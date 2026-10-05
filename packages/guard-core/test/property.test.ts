import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkDraft } from '../src/compiler-check.js';
import { evaluate, type OpenOrder } from '../src/evaluate.js';
import { gate } from '../src/invariants.js';
import { maintenanceMargin, tiersForPosition } from '../src/margin.js';
import type { Action, Rule, Target } from '../src/policy.js';
import { assessRisk } from '../src/risk.js';
import { floorSize } from '../src/rounding.js';
import type { AccountSnapshot } from '../src/snapshot.js';
import { assets } from './fixtures.js';
import { ctx, execCtx, policy, standardAccount, unifiedAccount, type PosSpec } from './helpers.js';

const COINS = ['xyz:CL', 'xyz:GOLD', 'xyz:SP500', 'xyz:NVDA', 'xyz:SKHX', 'xyz:COIN', 'BTC', 'ETH'];
const RUNS = Number(process.env.FC_RUNS ?? 1500);

const posArb = fc
  .record({
    coin: fc.constantFrom(...COINS),
    long: fc.boolean(),
    notional: fc.double({ min: 15, max: 50_000, noNaN: true }),
    mark: fc.double({ min: 0.5, max: 120_000, noNaN: true }),
    isoCushion: fc.double({ min: 0.6, max: 8, noNaN: true }),
  })
  .map(({ coin, long, notional, mark, isoCushion }): PosSpec | null => {
    const a = assets.get(coin)!;
    const size = floorSize(notional / mark, a.szDecimals);
    if (!(size > 0)) return null;
    const mm = maintenanceMargin(tiersForPosition(a.tiers, a.maxLeverage), size * mark);
    const isolated = a.onlyIsolated;
    return { coin, size: long ? size : -size, mark, ...(isolated ? { isolatedMargin: mm * isoCushion } : {}) };
  });

const accountArb = fc
  .record({
    unified: fc.boolean(),
    positions: fc.uniqueArray(posArb, { minLength: 1, maxLength: 5, selector: (p) => p?.coin ?? '' }),
    cushion: fc.double({ min: 0.7, max: 6, noNaN: true }),
    spot: fc.double({ min: 0, max: 5_000, noNaN: true }),
    mainCushion: fc.double({ min: 0.7, max: 6, noNaN: true }),
  })
  .map(({ unified, positions, cushion, spot, mainCushion }): AccountSnapshot | null => {
    const ps = positions.filter((p): p is PosSpec => p !== null);
    if (ps.length === 0) return null;
    const mmOf = (list: PosSpec[]) =>
      list.filter((p) => p.isolatedMargin === undefined).reduce((s, p) => {
        const a = assets.get(p.coin)!;
        return s + maintenanceMargin(tiersForPosition(a.tiers, a.maxLeverage), Math.abs(p.size) * p.mark);
      }, 0);
    if (unified) {
      const iso = ps.reduce((s, p) => s + (p.isolatedMargin ?? 0), 0);
      return unifiedAccount(ps, iso + Math.max(1, mmOf(ps) * cushion));
    }
    const xyz = ps.filter((p) => p.coin.startsWith('xyz:'));
    const main = ps.filter((p) => !p.coin.startsWith('xyz:'));
    const dexes: Parameters<typeof standardAccount>[0] = {};
    if (xyz.length) dexes.xyz = { positions: xyz, crossEquity: Math.max(1, mmOf(xyz) * cushion) };
    if (main.length) {
      const eq = Math.max(1, mmOf(main) * mainCushion);
      dexes[''] = { positions: main, crossEquity: eq, withdrawable: eq * 0.5 };
    }
    return standardAccount(dexes, spot);
  });

const targetArb: fc.Arbitrary<Target> = fc.oneof(
  fc.constant({ kind: 'first_position' as const }),
  fc.constant({ kind: 'worst_pnl' as const }),
  fc.constant({ kind: 'all' as const }),
  fc.constantFrom(...COINS).map((market) => ({ kind: 'market' as const, market })),
);
// Numbers here stand in for numbers a user typed.
const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ kind: fc.constant('reduce' as const), target: targetArb, fraction: fc.double({ min: 0.01, max: 1, noNaN: true }) }),
  fc.record({ kind: fc.constant('close' as const), target: targetArb }),
  fc.record({ kind: fc.constant('reduceToBuffer' as const), buffer: fc.double({ min: 1.05, max: 5, noNaN: true }) }),
  fc.record({ kind: fc.constant('reduceToLeverage' as const), market: fc.constantFrom(...COINS), leverage: fc.double({ min: 0.5, max: 20, noNaN: true }) }),
  fc.record({ kind: fc.constant('topUp' as const), maxUsdc: fc.double({ min: 1, max: 10_000, noNaN: true }) }),
  fc.constant({ kind: 'cancelOpeningOrders' as const }),
  fc.constant({ kind: 'alert' as const }),
);
const ruleArb = (i: number): fc.Arbitrary<Rule> =>
  fc.record({
    when: fc.oneof(
      fc.record({ kind: fc.constant('buffer' as const), below: fc.double({ min: 1.05, max: 6, noNaN: true }) }),
      fc.record({ kind: fc.constant('drawdown' as const), atLeastPct: fc.double({ min: 1, max: 60, noNaN: true }), baseline: fc.constant('rule_confirmed' as const) }),
      fc.record({ kind: fc.constant('priceMove' as const), market: fc.constantFrom(...COINS), direction: fc.constantFrom('down' as const, 'up' as const), movePct: fc.double({ min: 1, max: 40, noNaN: true }), from: fc.constant('rule_confirmed' as const) }),
      fc.record({ kind: fc.constant('leverageAbove' as const), market: fc.constantFrom(...COINS), leverage: fc.double({ min: 0.5, max: 25, noNaN: true }) }),
    ),
    then: fc.array(actionArb, { minLength: 1, maxLength: 3 }),
  }).map((r) => ({ id: `rule-${i}`, ...r }));

const policyArb = fc
  .tuple(fc.integer({ min: 1, max: 4 }), fc.double({ min: 0.1, max: 3, noNaN: true }))
  .chain(([n, slip]) => fc.tuple(...Array.from({ length: n }, (_, i) => ruleArb(i))).map((rules) => policy(rules, slip)));

const shockArb = fc.dictionary(fc.constantFrom(...COINS), fc.double({ min: 0.6, max: 1.4, noNaN: true }), { maxKeys: COINS.length });

describe('properties', () => {
  it('the evaluator never proposes an action the invariant gate rejects', () => {
    fc.assert(
      fc.property(accountArb, policyArb, shockArb, fc.boolean(), (snap, p, shock, withOrders) => {
        if (!snap) return;
        const marks = Object.fromEntries(snap.positions.map((x) => [x.coin, x.markAtSnapshot * (shock[x.coin] ?? 1)]));
        const openOrders: OpenOrder[] = withOrders
          ? snap.positions.map((x, i) => ({ coin: x.coin, oid: 1000 + i, side: x.size > 0 ? 'B' : 'A', reduceOnly: i % 2 === 0, isTrigger: i % 2 === 0 }))
          : [];
        const baselines = Object.fromEntries(
          p.rules.map((r) => [r.id, { accountValue: snap.accountValueAtSnapshot, prices: Object.fromEntries(snap.positions.map((x) => [x.coin, x.markAtSnapshot])) }]),
        );
        const c = ctx({ openOrders, baselines });
        const d = evaluate(p, snap, marks, c);
        const g = gate(d.actions, p, snap, marks, execCtx(p, { openOrders, baselines }));
        expect(g.rejected.map((r) => `${r.violation.invariant}: ${r.violation.message}`)).toEqual([]);
        for (const a of d.actions) {
          if (a.type !== 'order') continue;
          const pos = snap.positions.find((x) => x.dex === a.dex && x.coin === a.coin)!;
          expect(a.reduceOnly).toBe(true);
          expect(a.isBuy).toBe(pos.size < 0);
          expect(a.size).toBeLessThanOrEqual(Math.abs(pos.size) + 1e-12);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('every computed liquidation price takes its pool to a ratio of exactly 1', () => {
    fc.assert(
      fc.property(accountArb, (snap) => {
        if (!snap) return;
        const risk = assessRisk(snap);
        for (const pool of risk.pools) {
          for (const row of pool.positions) {
            if (row.liquidationPx === null) continue;
            const at = assessRisk(snap, { [row.position.coin]: row.liquidationPx });
            const after = at.pools.find((x) => x.pool.id === pool.pool.id)!;
            expect(after.maintenance / after.equity).toBeCloseTo(1, 6);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('is pure: same inputs, same output, and the caller’s latch set is not mutated', () => {
    fc.assert(
      fc.property(accountArb, policyArb, shockArb, (snap, p, shock) => {
        if (!snap) return;
        const marks = Object.fromEntries(snap.positions.map((x) => [x.coin, x.markAtSnapshot * (shock[x.coin] ?? 1)]));
        const latched = new Set<string>(['rule-0@whatever']);
        const a = evaluate(p, snap, marks, ctx({ latched }));
        const b = evaluate(p, snap, marks, ctx({ latched }));
        expect(JSON.stringify(a.actions)).toBe(JSON.stringify(b.actions));
        expect([...latched]).toEqual(['rule-0@whatever']);
      }),
      { numRuns: 300 },
    );
  });

  it('rejects any drafted number the user did not type', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 90 }), fc.integer({ min: 2, max: 90 }), (typed, drafted) => {
        fc.pre(typed !== drafted && typed !== drafted * 100 && typed * 100 !== drafted);
        const text = `never lose more than ${typed} percent this weekend`;
        const draft = { id: 'weekend-limit', window: 'weekend', when: { kind: 'drawdown', atLeastPct: drafted, baseline: 'window_start' }, then: [{ kind: 'close', target: { kind: 'all' } }] };
        const base = policy([]);
        expect(checkDraft(text, base, draft).ok).toBe(false);
        expect(checkDraft(text, base, { ...draft, when: { ...draft.when, atLeastPct: typed } }).ok).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
