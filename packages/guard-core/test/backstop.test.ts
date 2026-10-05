import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { planBackstops, priceAtBuffer } from '../src/backstop.js';
import { checkAction, gate } from '../src/invariants.js';
import { assessRisk } from '../src/risk.js';
import { execCtx, policy, standardAccount, unifiedAccount } from './helpers.js';

// Lines stand in for numbers a user typed.
const p = policy([
  { id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'reduce', target: { kind: 'first_position' }, fraction: 0.25 }] },
  { id: 'stage-3', when: { kind: 'buffer', below: 1.2 }, then: [{ kind: 'reduceToBuffer', buffer: 2 }] },
]);
const snap = standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: 10, mark: 100 }, { coin: 'xyz:NVDA', size: -2, mark: 200 }], crossEquity: 300 } }, 0);

describe('backstops', () => {
  it('places one reduce-only stop per position at the lowest line, on the losing side', () => {
    const plan = planBackstops(p, snap, undefined, []);
    expect(plan.place.map((t) => [t.coin, t.isBuy, t.tpsl, t.ruleId])).toEqual([
      ['xyz:CL', false, 'sl', 'stage-3'],
      ['xyz:NVDA', true, 'sl', 'stage-3'],
    ]);
    const cl = plan.place[0]!;
    expect(cl.triggerPx).toBeLessThan(100);
    expect(cl.size).toBe(10);
    expect(gate(plan.place, p, snap, undefined, execCtx(p)).rejected).toEqual([]);
  });

  it('the trigger price really is where the pool reaches the line', () => {
    const risk = assessRisk(snap);
    const pool = risk.pools[0]!;
    const row = pool.positions[0]!;
    const px = priceAtBuffer(pool, row, 1.2)!;
    const at = assessRisk(snap, { [row.position.coin]: px }).pools[0]!;
    expect(at.buffer).toBeCloseTo(1.2, 9);
  });

  it('keeps a backstop that is still in place and replaces one that drifted', () => {
    const first = planBackstops(p, snap, undefined, []).place[0]!;
    const same = [{ coin: 'xyz:CL', oid: 1, side: 'A' as const, reduceOnly: true, isTrigger: true, triggerPx: first.triggerPx, size: 10 }];
    expect(planBackstops(p, snap, undefined, same).cancel).toEqual([]);
    const drifted = [{ ...same[0]!, triggerPx: first.triggerPx * 0.9 }];
    const plan = planBackstops(p, snap, undefined, drifted);
    expect(plan.cancel.map((c) => c.oid)).toEqual([1]);
    expect(plan.place.some((t) => t.coin === 'xyz:CL')).toBe(true);
  });

  it('cancels backstops for positions that are gone, and all of them when the policy has no line', () => {
    const orphan = [{ coin: 'xyz:GOLD', oid: 9, side: 'A' as const, reduceOnly: true, isTrigger: true, triggerPx: 3000, size: 1 }];
    expect(planBackstops(p, snap, undefined, orphan).cancel.map((c) => c.oid)).toEqual([9]);
    const noLines = policy([{ id: 'alert-only', when: { kind: 'leverageAbove', market: 'xyz:CL', leverage: 50 }, then: [{ kind: 'alert' }] }]);
    const plan = planBackstops(noLines, snap, undefined, orphan);
    expect(plan.place).toEqual([]);
    expect(plan.cancel.map((c) => c.oid)).toEqual([9]);
  });

  it('may cancel its own reduce-only stops but never the user’s', () => {
    const openOrders = [{ coin: 'xyz:CL', oid: 5, side: 'A' as const, reduceOnly: true, isTrigger: true }];
    const cancel = { type: 'cancel' as const, ruleId: 'stage-3', reason: 't', dex: 'xyz', coin: 'xyz:CL', oid: 5 };
    expect(checkAction(cancel, p, snap, undefined, execCtx(p, { openOrders, guardOwnedOids: new Set([5]) }))).toBeNull();
    expect(checkAction(cancel, p, snap, undefined, execCtx(p, { openOrders }))?.invariant).toBe('I2');
  });

  it('rejects a backstop on the wrong side of the mark', () => {
    const t = planBackstops(p, snap, undefined, []).place[0]!;
    expect(checkAction({ ...t, triggerPx: 101, limitPx: 100.5 }, p, snap, undefined, execCtx(p))?.invariant).toBe('I1');
  });

  it('works for unified accounts and isolated positions', () => {
    const u = unifiedAccount([{ coin: 'xyz:CL', size: 10, mark: 100 }, { coin: 'xyz:COIN', size: 1, mark: 200, isolatedMargin: 60 }], 400);
    const plan = planBackstops(p, u, undefined, []);
    expect(plan.place.map((t) => t.coin).sort()).toEqual(['xyz:CL', 'xyz:COIN']);
    expect(gate(plan.place, p, u, undefined, execCtx(p)).rejected).toEqual([]);
  });

  it('property: every planned backstop passes the gate and sits at the line', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1.05, max: 4, noNaN: true }),
        fc.double({ min: 1.2, max: 20, noNaN: true }),
        fc.integer({ min: 1, max: 200 }),
        fc.double({ min: 0.1, max: 3, noNaN: true }),
        (line, cushion, size, slip) => {
          const pol = policy([{ id: 'stage-x', when: { kind: 'buffer', below: line }, then: [{ kind: 'alert' }] }], slip);
          const mm = size * 100 * 0.025;
          const s = standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size, mark: 100 }], crossEquity: mm * line * cushion } }, 0);
          const plan = planBackstops(pol, s, undefined, []);
          expect(gate(plan.place, pol, s, undefined, execCtx(pol)).rejected).toEqual([]);
          for (const t of plan.place) {
            const at = assessRisk(s, { [t.coin]: t.triggerPx }).pools[0]!;
            // rounded toward the mark, so the stop fires at or just before the line
            expect(at.buffer).toBeGreaterThanOrEqual(line - 1e-6);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
