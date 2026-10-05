/**
 * "Guard acts at": the mark at which a pool reaches one of the user's buffer lines.
 * Held to the liquidation price's standard:
 * - golden: at a line of 1.00× it reproduces Hyperliquid's API liquidation price on every captured
 *   mainnet account; at the user's lines, re-pricing those real accounts lands exactly on the line;
 * - properties: the same, on random accounts across every pool kind, plus direction and ordering.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { maintenanceMargin, priceForBuffer, tiersForPosition } from '../src/margin.js';
import { assessRisk, bufferLines, guardActsAt, priceAtLine } from '../src/risk.js';
import { buildSnapshot, type AccountSnapshot } from '../src/snapshot.js';
import { floorSize } from '../src/rounding.js';
import { accounts, assets, collateral } from './fixtures.js';
import { standardAccount, unifiedAccount, type PosSpec } from './helpers.js';

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-9, Math.abs(b));
const RUNS = Number(process.env.FC_RUNS ?? 1500);
// Stand-ins for lines a user typed.
const LINES = [1.1, 1.25, 1.5, 2, 2.5, 3, 5];

const supported = accounts.filter((a) => a.mode !== 'portfolioMargin');

describe.each(supported.map((a) => [a.label, a] as const))('golden %s', (_label, fx) => {
  const snapshot = buildSnapshot({ abstraction: fx.mode, dexStates: fx.dexes, spot: fx.spot, assets, dexCollateral: collateral });
  const risk = assessRisk(snapshot);

  it('a line of 1.00× is Hyperliquid’s own liquidation price', () => {
    for (const pool of risk.pools) {
      for (const row of pool.positions) {
        const api = row.position.api.liquidationPx;
        const ours = priceForBuffer({ mark: row.mark, size: row.position.size, equity: pool.equity, otherMaintenance: pool.maintenance - row.maintenance, tiers: row.position.tiers, buffer: 1 });
        if (api === null) {
          expect(ours).toBeNull();
          continue;
        }
        expect(ours).not.toBeNull();
        expect(rel(ours as number, api)).toBeLessThan(1e-6);
      }
    }
  });

  it('re-pricing the real account at each guard price lands its pool on the line', () => {
    let checked = 0;
    for (const pool of risk.pools) {
      for (const row of pool.positions) {
        for (const line of LINES) {
          const level = priceAtLine(pool, row, line);
          if (!level) continue;
          const after = assessRisk(snapshot, { [row.position.coin]: level.price }).pools.find((p) => p.pool.id === pool.pool.id)!;
          expect(rel(after.buffer, line)).toBeLessThan(1e-7);
          checked++;
        }
      }
    }
    // Every captured account has at least one position whose pool sits above a 1.1× line.
    expect(checked).toBeGreaterThan(0);
  });
});

const COINS = ['xyz:CL', 'xyz:GOLD', 'xyz:SP500', 'xyz:NVDA', 'xyz:SKHX', 'xyz:SILVER', 'BTC', 'ETH'];

const posArb = fc
  .record({
    coin: fc.constantFrom(...COINS),
    long: fc.boolean(),
    notional: fc.double({ min: 15, max: 50_000, noNaN: true }),
    mark: fc.double({ min: 0.5, max: 120_000, noNaN: true }),
    isolated: fc.boolean(),
    isoCushion: fc.double({ min: 0.6, max: 8, noNaN: true }),
  })
  .map(({ coin, long, notional, mark, isolated, isoCushion }): PosSpec | null => {
    const a = assets.get(coin);
    if (!a) return null;
    const size = floorSize(notional / mark, a.szDecimals);
    if (!(size > 0)) return null;
    const mm = maintenanceMargin(tiersForPosition(a.tiers, a.maxLeverage), size * mark);
    const iso = a.onlyIsolated || isolated;
    return { coin, size: long ? size : -size, mark, ...(iso ? { isolatedMargin: mm * isoCushion } : {}) };
  });

const accountArb = fc
  .record({
    unified: fc.boolean(),
    positions: fc.uniqueArray(posArb, { minLength: 1, maxLength: 5, selector: (p) => p?.coin ?? '' }),
    cushion: fc.double({ min: 0.7, max: 8, noNaN: true }),
  })
  .map(({ unified, positions, cushion }): AccountSnapshot | null => {
    const ps = positions.filter((p): p is PosSpec => p !== null);
    if (ps.length === 0) return null;
    const crossMM = (list: PosSpec[]) =>
      list.filter((p) => p.isolatedMargin === undefined).reduce((s, p) => s + maintenanceMargin(tiersForPosition(assets.get(p.coin)!.tiers, assets.get(p.coin)!.maxLeverage), Math.abs(p.size) * p.mark), 0);
    if (unified) {
      const iso = ps.reduce((s, p) => s + (p.isolatedMargin ?? 0), 0);
      return unifiedAccount(ps, iso + Math.max(1, crossMM(ps) * cushion));
    }
    const dexes: Parameters<typeof standardAccount>[0] = {};
    const xyz = ps.filter((p) => p.coin.startsWith('xyz:'));
    const main = ps.filter((p) => !p.coin.startsWith('xyz:'));
    if (xyz.length) dexes.xyz = { positions: xyz, crossEquity: Math.max(1, crossMM(xyz) * cushion) };
    if (main.length) dexes[''] = { positions: main, crossEquity: Math.max(1, crossMM(main) * cushion) };
    return standardAccount(dexes);
  });

const lineArb = fc.double({ min: 1.01, max: 12, noNaN: true });

describe('guard price properties', () => {
  it('the generators really exercise the solver (most sampled cases produce a price)', () => {
    let cases = 0;
    let priced = 0;
    for (const [snap, line] of fc.sample(fc.tuple(accountArb, lineArb), { numRuns: 400, seed: 7 })) {
      if (!snap) continue;
      for (const pool of assessRisk(snap).pools) {
        for (const row of pool.positions) {
          if (!(pool.buffer > line)) continue;
          cases++;
          if (priceAtLine(pool, row, line)) priced++;
        }
      }
    }
    expect(cases).toBeGreaterThan(200);
    expect(priced / cases).toBeGreaterThan(0.6);
  });

  it('re-pricing at the returned price lands the pool exactly on the line', () => {
    fc.assert(
      fc.property(accountArb, lineArb, (snap, line) => {
        if (!snap) return;
        const risk = assessRisk(snap);
        for (const pool of risk.pools) {
          for (const row of pool.positions) {
            const level = priceAtLine(pool, row, line);
            if (!level) continue;
            const after = assessRisk(snap, { [row.position.coin]: level.price }).pools.find((p) => p.pool.id === pool.pool.id)!;
            expect(rel(after.buffer, line)).toBeLessThan(1e-6);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('the price is always on the losing side of the mark, and only for lines below the current buffer', () => {
    fc.assert(
      fc.property(accountArb, lineArb, (snap, line) => {
        if (!snap) return;
        for (const pool of assessRisk(snap).pools) {
          for (const row of pool.positions) {
            const level = priceAtLine(pool, row, line);
            if (pool.buffer <= line) expect(level).toBeNull();
            if (!level) continue;
            if (row.position.size > 0) expect(level.price).toBeLessThan(row.mark);
            else expect(level.price).toBeGreaterThan(row.mark);
            expect(level.move).toBeCloseTo((level.price - row.mark) / row.mark, 12);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('a higher line acts sooner, and every line acts before liquidation', () => {
    fc.assert(
      fc.property(accountArb, lineArb, lineArb, (snap, a, b) => {
        if (!snap || a === b) return;
        const hi = Math.max(a, b);
        const lo = Math.min(a, b);
        for (const pool of assessRisk(snap).pools) {
          for (const row of pool.positions) {
            const pHi = priceAtLine(pool, row, hi);
            const pLo = priceAtLine(pool, row, lo);
            const dist = (p: number) => Math.abs(p - row.mark);
            if (pHi && pLo) expect(dist(pHi.price)).toBeLessThanOrEqual(dist(pLo.price) * (1 + 1e-9));
            if (pLo && row.liquidationPx !== null) expect(dist(pLo.price)).toBeLessThan(dist(row.liquidationPx));
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('guardActsAt picks the highest reachable line below the buffer, and nothing when every line is at or above it', () => {
    fc.assert(
      fc.property(accountArb, fc.uniqueArray(lineArb, { minLength: 1, maxLength: 4 }), (snap, lines) => {
        if (!snap) return;
        for (const pool of assessRisk(snap).pools) {
          for (const row of pool.positions) {
            const got = guardActsAt(pool, row, lines);
            const reachable = lines.filter((l) => priceAtLine(pool, row, l) !== null);
            if (reachable.length === 0) {
              expect(got).toBeNull();
              continue;
            }
            expect(got?.line).toBe(Math.max(...reachable));
          }
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('bufferLines', () => {
  it('takes only buffer triggers, once each, highest first, and adds nothing', () => {
    const rules = [
      { when: { kind: 'buffer', below: 2.5 } },
      { when: { kind: 'drawdown', atLeastPct: 10 } },
      { when: { kind: 'buffer', below: 3 } },
      { when: { kind: 'buffer', below: 2.5 } },
    ];
    expect(bufferLines(rules)).toEqual([3, 2.5]);
    expect(bufferLines([])).toEqual([]);
  });
});
