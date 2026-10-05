import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { planBackstops, priceAtBuffer, togetherMove } from '../src/backstop.js';
import { gate } from '../src/invariants.js';
import { maintenanceMargin, tiersForPosition } from '../src/margin.js';
import { assessRisk } from '../src/risk.js';
import { floorSize } from '../src/rounding.js';
import { assets } from './fixtures.js';
import { execCtx, policy, standardAccount, type PosSpec } from './helpers.js';

const RUNS = Number(process.env.FC_RUNS ?? 500);
const lowest = (line: number) => policy([{ id: 'floor', when: { kind: 'buffer', below: line }, then: [{ kind: 'alert' }] }]);
// Two cross longs in one pool, $1,000 each, $200 equity: buffer ≈ 4.4.
const pair = () => standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: 10, mark: 100 }, { coin: 'xyz:GOLD', size: 0.25, mark: 4000 }], crossEquity: 200 } }, 0);
const fall = (px: number, mark: number) => 1 - px / mark;

describe('backstop priced as if the pool moves together (golden)', () => {
  it('two equal positions falling together cross a 2× line after 5.8%; each single-position price is 11.5% away', () => {
    const snap = pair();
    const f = togetherMove(snap, undefined, 'dex:xyz', 2)!;
    expect(f * 100).toBeCloseTo(5.76, 2);
    const both = assessRisk(snap, { 'xyz:CL': 100 * (1 - f), 'xyz:GOLD': 4000 * (1 - f) }).pools[0]!;
    expect(both.buffer).toBeCloseTo(2, 6);

    const single = planBackstops(lowest(2), snap, undefined, [], 'single').place;
    const together = planBackstops(lowest(2), snap, undefined, [], 'together').place;
    const cl = (plan: typeof single) => plan.find((t) => t.coin === 'xyz:CL')!;
    const gold = (plan: typeof single) => plan.find((t) => t.coin === 'xyz:GOLD')!;
    expect(fall(cl(single).triggerPx, 100) * 100).toBeCloseTo(11.58, 1);
    expect(fall(gold(single).triggerPx, 4000) * 100).toBeCloseTo(11.46, 1);
    expect(fall(cl(together).triggerPx, 100) * 100).toBeCloseTo(5.76, 1);
    expect(fall(gold(together).triggerPx, 4000) * 100).toBeCloseTo(5.76, 1);
    // At the single-position prices, moving together, the pool is already gone.
    expect(assessRisk(snap, { 'xyz:CL': cl(single).triggerPx, 'xyz:GOLD': gold(single).triggerPx }).pools[0]!.equity).toBeLessThanOrEqual(0);
    expect(cl(together).reason).toMatch(/as if every position in this pool moves against you at once/);
    expect(gate(together, lowest(2), snap, undefined, execCtx(lowest(2))).rejected).toEqual([]);
  });

  it('a long and a short in one pool: the long is priced down and the short up, by the same adverse move', () => {
    const snap = standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: 10, mark: 100 }, { coin: 'xyz:NVDA', size: -2, mark: 200 }], crossEquity: 300 } }, 0);
    const f = togetherMove(snap, undefined, 'dex:xyz', 1.2)!;
    const plan = planBackstops(lowest(1.2), snap, undefined, [], 'together').place;
    expect(fall(plan.find((t) => t.coin === 'xyz:CL')!.triggerPx, 100)).toBeCloseTo(f, 3);
    expect(plan.find((t) => t.coin === 'xyz:NVDA')!.triggerPx / 200 - 1).toBeCloseTo(f, 3);
  });

  it('a pool with one position, and isolated positions, are priced exactly as before', () => {
    const one = standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: 10, mark: 90, leverage: 10 }], crossEquity: 100 } });
    expect(planBackstops(lowest(1.5), one, undefined, [], 'together')).toEqual(planBackstops(lowest(1.5), one, undefined, [], 'single'));
  });

  it('nothing when the pool is already past the line', () => {
    const snap = pair();
    expect(togetherMove(snap, undefined, 'dex:xyz', 10)).toBeNull();
  });
});

const COINS = ['xyz:CL', 'xyz:GOLD', 'xyz:SP500', 'xyz:NVDA', 'xyz:SKHX', 'xyz:COIN'];
const posArb = fc
  .record({ coin: fc.constantFrom(...COINS), long: fc.boolean(), notional: fc.double({ min: 50, max: 20_000, noNaN: true }), mark: fc.double({ min: 1, max: 5_000, noNaN: true }) })
  .map(({ coin, long, notional, mark }): PosSpec | null => {
    const a = assets.get(coin)!;
    if (a.onlyIsolated) return null;
    const size = floorSize(notional / mark, a.szDecimals);
    return size > 0 ? { coin, size: long ? size : -size, mark } : null;
  });

describe('backstop priced together (properties)', () => {
  it('every stop fires no later than the together-move line, and no later than its single-position line', () => {
    fc.assert(
      fc.property(fc.uniqueArray(posArb, { minLength: 2, maxLength: 4, selector: (p) => p?.coin ?? '' }), fc.double({ min: 1.05, max: 6, noNaN: true }), fc.double({ min: 1.1, max: 4, noNaN: true }), (raw, cushion, line) => {
        const positions = raw.filter((p): p is PosSpec => p !== null);
        if (positions.length < 2) return;
        const mm = positions.reduce((s, p) => s + maintenanceMargin(tiersForPosition(assets.get(p.coin)!.tiers, assets.get(p.coin)!.maxLeverage), Math.abs(p.size) * p.mark), 0);
        const snap = standardAccount({ xyz: { positions, crossEquity: mm * line * cushion } }, 0);
        const risk = assessRisk(snap);
        const pool = risk.pools.find((p) => p.pool.id === 'dex:xyz')!;
        if (!(pool.buffer > line)) return;
        const f = togetherMove(snap, undefined, 'dex:xyz', line);
        const plan = planBackstops(lowest(line), snap, undefined, [], 'together').place;
        for (const t of plan) {
          const row = pool.positions.find((r) => r.position.coin === t.coin)!;
          const long = row.position.size > 0;
          const move = long ? 1 - t.triggerPx / row.mark : t.triggerPx / row.mark - 1;
          // tick rounding moves the trigger toward the mark (earlier), never away from it
          if (f !== null) expect(move).toBeLessThanOrEqual(f + 1e-9);
          const single = priceAtBuffer(pool, row, line);
          if (single !== null) expect(long ? t.triggerPx >= single - 1e-9 : t.triggerPx <= single + 1e-9).toBe(true);
        }
        expect(gate(plan, lowest(line), snap, undefined, execCtx(lowest(line))).rejected).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });
});
