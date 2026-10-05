import { describe, expect, it } from 'vitest';
import { evaluate, type GuardAction } from '../src/evaluate.js';
import { gate } from '../src/invariants.js';
import { assessRisk } from '../src/risk.js';
import { ctx, execCtx, policy, standardAccount, unifiedAccount } from './helpers.js';

const orders = (a: GuardAction[]) => a.filter((x): x is Extract<GuardAction, { type: 'order' }> => x.type === 'order');

// Lines and fractions below stand in for numbers a user typed; the engine itself has none.
const LINE = 2;

describe('buffer stage', () => {
  // xyz:CL max 20× → maintenance 2.5%. Long 1 CL at 100 → notional 100, maintenance 2.5.
  const at = (mark: number, equity: number) => standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: 1, mark, entry: 100 }], crossEquity: equity } }, 50);
  const p = policy([{ id: 'stage-1', when: { kind: 'buffer', below: LINE }, then: [{ kind: 'reduce', target: { kind: 'first_position' }, fraction: 0.5 }] }]);

  it('does nothing above the line', () => {
    const d = evaluate(p, at(100, 6), undefined, ctx());
    expect(d.risk.worst?.buffer).toBeCloseTo(2.4, 6);
    expect(d.actions).toEqual([]);
  });

  it('trims with a reduce-only IOC sell inside the slippage when the buffer crosses the line', () => {
    const snap = at(100, 6); // at 97: equity 3, maintenance 2.425 → buffer 1.24
    const d = evaluate(p, snap, { 'xyz:CL': 97 }, ctx());
    const [o] = orders(d.actions);
    expect(o).toMatchObject({ coin: 'xyz:CL', isBuy: false, reduceOnly: true, tif: 'Ioc', size: 0.5 });
    expect(o!.limitPx).toBeLessThan(97);
    expect(o!.limitPx).toBeGreaterThanOrEqual(97 * 0.99 - 0.001);
    expect(gate(d.actions, p, snap, { 'xyz:CL': 97 }, execCtx(p)).rejected).toEqual([]);
  });

  it('latches: the same breach does not fire twice, and re-arms once the buffer recovers', () => {
    const snap = at(100, 6);
    const first = evaluate(p, snap, { 'xyz:CL': 97 }, ctx());
    const again = evaluate(p, snap, { 'xyz:CL': 97 }, ctx({ latched: first.latched }));
    expect(again.actions).toEqual([]);
    const recovered = evaluate(p, snap, { 'xyz:CL': 100 }, ctx({ latched: again.latched }));
    expect(recovered.latched.size).toBe(0);
    const breachAgain = evaluate(p, snap, { 'xyz:CL': 97 }, ctx({ latched: recovered.latched }));
    expect(orders(breachAgain.actions)).toHaveLength(1);
  });

  it('raises a too-small trim to the $10 minimum, or closes the position when it is that small', () => {
    // 0.15 CL at 97 = $14.55; 50% = $7.3 < $10 → bump to ceil(10/97 at 3dp) = 0.104
    const s1 = standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: 0.15, mark: 100 }], crossEquity: 1 } }, 0);
    const o1 = orders(evaluate(p, s1, { 'xyz:CL': 97 }, ctx()).actions)[0]!;
    expect(o1.size * 97).toBeGreaterThanOrEqual(10);
    expect(o1.size).toBeLessThanOrEqual(0.15);
    // 0.1 CL ($9.70) → whole position
    const s2 = standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: 0.1, mark: 100 }], crossEquity: 0.5 } }, 0);
    const o2 = orders(evaluate(p, s2, { 'xyz:CL': 97 }, ctx()).actions)[0]!;
    expect(o2.closesPosition).toBe(true);
  });
});

describe('top-up', () => {
  const p = policy([{ id: 'stage-2', when: { kind: 'buffer', below: LINE }, then: [{ kind: 'topUp', maxUsdc: 100 }] }]);

  it('standard: moves the amount the user set from spot into the dex that needs it', () => {
    const snap = standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: 10, mark: 100 }], crossEquity: 40 } }, 500);
    // maintenance 25, equity 40 → buffer 1.6, below line 2 → the rule's 100 USDC
    const d = evaluate(p, snap, undefined, ctx());
    const t = d.actions.find((a) => a.type === 'transfer');
    expect(t).toMatchObject({ type: 'transfer', source: 'spot', toDex: 'xyz', amount: 100 });
    // only what is there
    const thin = standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: 10, mark: 100 }], crossEquity: 40 } }, 30);
    expect(evaluate(p, thin, undefined, ctx()).actions.find((a) => a.type === 'transfer')).toMatchObject({ amount: 30 });
    expect(gate(d.actions, p, snap, undefined, execCtx(p)).rejected).toEqual([]);
  });

  it('standard: never drains another dex below the highest line', () => {
    const snap = standardAccount({
      xyz: { positions: [{ coin: 'xyz:CL', size: 10, mark: 100 }], crossEquity: 40 },
      '': { positions: [{ coin: 'BTC', size: 0.01, mark: 100_000 }], crossEquity: 30, withdrawable: 25 },
    }, 0);
    // main: BTC notional 1000, 40× → maintenance 12.5; equity 30 → room above line 2 = 30 − 25 = 5
    const d = evaluate(p, snap, undefined, ctx());
    const t = d.actions.filter((a) => a.type === 'transfer');
    const moved = t.reduce((s, a) => s + (a.type === 'transfer' ? a.amount : 0), 0);
    expect(moved).toBeLessThanOrEqual(5 + 1e-9);
    expect(gate(d.actions, p, snap, undefined, execCtx(p)).rejected).toEqual([]);
  });

  it('unified cross pool: nothing to move, so it alerts instead', () => {
    const snap = unifiedAccount([{ coin: 'xyz:CL', size: 10, mark: 100 }], 40);
    const d = evaluate(p, snap, undefined, ctx());
    expect(d.actions.every((a) => a.type === 'alert')).toBe(true);
    expect(d.actions).toHaveLength(1);
  });

  it('unified isolated position: adds isolated margin from the shared balance', () => {
    // COIN is isolated-only; 0.1 COIN at 200 = $20, max 10× → maintenance 1; isolated margin 1.5 → buffer 1.5
    const snap = unifiedAccount([{ coin: 'xyz:COIN', size: 0.1, mark: 200, isolatedMargin: 1.5 }], 100);
    const d = evaluate(p, snap, undefined, ctx());
    const iso = d.actions.find((a) => a.type === 'isolatedMargin');
    // the rule's 100 USDC, limited to the free shared balance: 100 − 1.5 already in the isolated margin
    expect(iso).toMatchObject({ coin: 'xyz:COIN', amount: 98.5 });
    expect(gate(d.actions, p, snap, undefined, execCtx(p)).rejected).toEqual([]);
  });
});

describe('reduce to buffer', () => {
  it('trims until the pool is back at the line after slippage', () => {
    const p = policy([{ id: 'stage-3', when: { kind: 'buffer', below: 1.5 }, then: [{ kind: 'reduceToBuffer', buffer: 2 }] }], 0.5);
    const snap = standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: 10, mark: 100 }, { coin: 'xyz:GOLD', size: 0.2, mark: 4000 }], crossEquity: 45 } }, 0);
    const marks = { 'xyz:CL': 99 };
    const d = evaluate(p, snap, marks, ctx());
    const os = orders(d.actions);
    expect(os.length).toBeGreaterThan(0);
    // apply fills at the limit price and recompute the buffer
    const risk = assessRisk(snap, marks);
    const pool = risk.worst!;
    let equity = pool.equity;
    let maint = pool.maintenance;
    for (const o of os) {
      const row = pool.positions.find((r) => r.position.coin === o.coin)!;
      equity -= o.size * Math.abs(row.mark - o.limitPx);
      maint -= (o.size / Math.abs(row.position.size)) * row.maintenance;
    }
    expect(equity / maint).toBeGreaterThanOrEqual(2 - 1e-6);
  });
});

describe('plain-language rule shapes', () => {
  it('weekend drawdown closes everything only inside the window', () => {
    const p = policy([{ id: 'weekend-limit', window: 'weekend', when: { kind: 'drawdown', atLeastPct: 20, baseline: 'window_start' }, then: [{ kind: 'close', target: { kind: 'all' } }] }]);
    const snap = standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: 1, mark: 100 }, { coin: 'xyz:NVDA', size: -1, mark: 200 }], crossEquity: 80 } }, 0);
    const baselines = { 'weekend-limit': { accountValue: 120 } }; // now 80 → down 33%
    const saturday = Date.UTC(2026, 9, 10, 12, 0);
    const tuesday = Date.UTC(2026, 9, 6, 15, 0);
    const inWindow = evaluate(p, snap, undefined, ctx({ now: saturday, baselines }));
    expect(orders(inWindow.actions).map((o) => [o.coin, o.closesPosition, o.isBuy])).toEqual([
      ['xyz:CL', true, false],
      ['xyz:NVDA', true, true],
    ]);
    expect(evaluate(p, snap, undefined, ctx({ now: tuesday, baselines })).actions).toEqual([]);
  });

  it('price move from the window start closes that market', () => {
    const p = policy([{ id: 'gold-overnight', window: 'overnight', when: { kind: 'priceMove', market: 'xyz:GOLD', direction: 'down', movePct: 5, from: 'window_start' }, then: [{ kind: 'close', target: { kind: 'market', market: 'xyz:GOLD' } }] }]);
    const snap = standardAccount({ xyz: { positions: [{ coin: 'xyz:GOLD', size: 0.01, mark: 4000 }], crossEquity: 30 } }, 0);
    const night = Date.UTC(2026, 9, 7, 3, 0);
    const base = { 'gold-overnight': { prices: { 'xyz:GOLD': 4000 } } };
    expect(evaluate(p, snap, { 'xyz:GOLD': 3850 }, ctx({ now: night, baselines: base })).actions).toEqual([]);
    expect(orders(evaluate(p, snap, { 'xyz:GOLD': 3790 }, ctx({ now: night, baselines: base })).actions)[0]).toMatchObject({ coin: 'xyz:GOLD', closesPosition: true });
  });

  it('leverage cap trims back under the cap', () => {
    const p = policy([{ id: 'oil-cap', when: { kind: 'leverageAbove', market: 'xyz:CL', leverage: 5 }, then: [{ kind: 'reduceToLeverage', market: 'xyz:CL', leverage: 5 }] }], 0.5);
    const snap = standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: 10, mark: 100 }], crossEquity: 125 } }, 0); // 8×
    const o = orders(evaluate(p, snap, undefined, ctx()).actions)[0]!;
    const after = (10 - o.size) * 100;
    const equityAfter = 125 - o.size * (100 - o.limitPx);
    expect(after / equityAfter).toBeLessThanOrEqual(5 + 1e-6);
  });

  it('cancels only the user’s opening orders, never their reduce-only ones', () => {
    const p = policy([{ id: 'stage-1', when: { kind: 'buffer', below: LINE }, then: [{ kind: 'cancelOpeningOrders' }] }]);
    const snap = standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: 1, mark: 100 }], crossEquity: 4 } }, 0);
    const openOrders = [
      { coin: 'xyz:CL', oid: 1, side: 'B' as const, reduceOnly: false, isTrigger: false },
      { coin: 'xyz:CL', oid: 2, side: 'A' as const, reduceOnly: true, isTrigger: true },
    ];
    const d = evaluate(p, snap, undefined, ctx({ openOrders }));
    expect(d.actions.filter((a) => a.type === 'cancel').map((a) => (a.type === 'cancel' ? a.oid : 0))).toEqual([1]);
  });
});

describe('mode and region', () => {
  const p = policy([{ id: 'stage-1', when: { kind: 'buffer', below: LINE }, then: [{ kind: 'reduce', target: { kind: 'all' }, fraction: 0.5 }] }]);
  const snap = standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: 1, mark: 100 }], crossEquity: 4 } }, 0);

  it('turns every action into one alert per rule where automation is off (EU, D4)', () => {
    const d = evaluate(p, snap, undefined, ctx({ automationAllowed: false }));
    expect(d.actions).toHaveLength(1);
    expect(d.actions[0]).toMatchObject({ type: 'alert', level: 'critical' });
  });
});
