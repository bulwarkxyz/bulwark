import { describe, expect, it } from 'vitest';
import { assessRisk } from '../src/risk.js';
import { linearPath, nextTimeIn, simulate } from '../src/simulate.js';
import { windowContains } from '../src/windows.js';
import { policy, standardAccount } from './helpers.js';

const CL = 'xyz:CL';
// 10 CL at 90 with 100 USDC cross equity on xyz: buffer ≈ 4.4; a fall of about 9% liquidates.
const account = () => standardAccount({ xyz: { positions: [{ coin: CL, size: 10, mark: 90, leverage: 10 }], crossEquity: 100 } });
const NOW = Date.UTC(2026, 9, 7, 15, 0); // a Wednesday, US session
const drop = (pct: number, steps = 48) => linearPath({ [CL]: 90 }, { [CL]: -pct }, steps);

describe('simulate', () => {
  it('with no rules, matches the unguarded path exactly', () => {
    const r = simulate({ policy: policy([]), snapshot: account(), path: drop(12), now: NOW, feeRate: 0 });
    expect(r.liquidatedAt).not.toBeNull();
    expect(r.liquidatedAt).toBe(r.unguardedLiquidatedAt);
    expect(r.steps.every((s) => s.actions.length === 0)).toBe(true);
  });

  it('a trim stage keeps the account alive through a fall that liquidates it unguarded', () => {
    const p = policy([{ id: 'stage-1', when: { kind: 'buffer', below: 2.5 }, then: [{ kind: 'reduceToBuffer', buffer: 4 }] }]);
    const r = simulate({ policy: p, snapshot: account(), path: drop(12), now: NOW, feeRate: 0.00045 });
    expect(r.unguardedLiquidatedAt).not.toBeNull();
    expect(r.liquidatedAt).toBeNull();
    expect(r.final.buffer).toBeGreaterThan(1);
    const orders = r.steps.flatMap((s) => s.actions).filter((a) => a.type === 'order');
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((a) => a.type === 'order' && a.reduceOnly && !a.isBuy)).toBe(true);
    expect(r.feesPaid).toBeGreaterThan(0);
  });

  it('charges exactly the slippage to the limit price and the fee at a fill', () => {
    const p = policy([{ id: 'stage-1', when: { kind: 'buffer', below: 3 }, then: [{ kind: 'reduce', target: { kind: 'all' }, fraction: 0.5 }] }]);
    const path = drop(12);
    const fee = 0.0005;
    const r = simulate({ policy: p, snapshot: account(), path, now: NOW, feeRate: fee });
    const i = r.steps.findIndex((s) => s.actions.some((a) => a.type === 'order'));
    const order = r.steps[i]!.actions.find((a) => a.type === 'order')!;
    if (order.type !== 'order') throw new Error('no order');
    const mark = path[i]![CL]!;
    const unguardedValue = assessRisk(account(), path[i]).accountValue;
    const cost = order.size * (mark - order.limitPx) + order.size * order.limitPx * fee;
    expect(r.steps[i]!.accountValue).toBeCloseTo(unguardedValue - cost, 9);
  });

  it('a top-up moves idle USDC into the pool without changing account value', () => {
    const snap = standardAccount({ xyz: { positions: [{ coin: CL, size: 10, mark: 90, leverage: 10 }], crossEquity: 100 } }, 200);
    const p = policy([{ id: 'stage-1', when: { kind: 'buffer', below: 2.5 }, then: [{ kind: 'topUp', maxUsdc: 150 }] }]);
    const path = drop(12);
    const r = simulate({ policy: p, snapshot: snap, path, now: NOW, feeRate: 0 });
    const i = r.steps.findIndex((s) => s.actions.some((a) => a.type === 'transfer'));
    expect(i).toBeGreaterThan(0);
    expect(r.steps[i]!.accountValue).toBeCloseTo(assessRisk(snap, path[i]).accountValue, 9);
    expect(r.steps[i]!.buffer).toBeGreaterThan(2.5);
    expect(r.liquidatedAt).toBeNull();
  });

  it('regression: a top-up sized only to the line (old behaviour) is liquidated; the full typed amount (new) survives', () => {
    // The case the simulator found on 2026-10-05: "below 2.5×, move 150 USDC", price falling 12%.
    const snap = standardAccount({ xyz: { positions: [{ coin: CL, size: 10, mark: 90, leverage: 10 }], crossEquity: 100 } }, 200);
    const path = drop(12);
    // Old sizing, recreated exactly: at the first breach move only the gap to the line, rounded down to cents.
    const breach = path.findIndex((m) => assessRisk(snap, m).worst!.buffer < 2.5);
    const at = assessRisk(snap, path[breach]).worst!;
    const oldAmount = Math.floor((2.5 * at.maintenance - at.equity) * 100) / 100;
    expect(oldAmount).toBeGreaterThan(0);
    expect(oldAmount).toBeLessThan(1);
    const old = simulate({ policy: policy([{ id: 'stage-1', when: { kind: 'buffer', below: 2.5 }, then: [{ kind: 'topUp', maxUsdc: oldAmount }] }]), snapshot: snap, path, now: NOW, feeRate: 0 });
    expect(old.liquidatedAt).not.toBeNull(); // the rule stayed latched just under the line; the fall continued
    expect(old.steps.flatMap((s) => s.actions).filter((a) => a.type === 'transfer')).toHaveLength(1);

    const now = simulate({ policy: policy([{ id: 'stage-1', when: { kind: 'buffer', below: 2.5 }, then: [{ kind: 'topUp', maxUsdc: 150 }] }]), snapshot: snap, path, now: NOW, feeRate: 0 });
    const moved = now.steps.flatMap((s) => s.actions).filter((a) => a.type === 'transfer');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ amount: 150 }); // the full typed amount, once
    expect(now.liquidatedAt).toBeNull();
  });

  it('rules outside their window do not fire', () => {
    const p = policy([{ id: 'w', window: 'weekend', when: { kind: 'buffer', below: 3 }, then: [{ kind: 'close', target: { kind: 'all' } }] }]);
    const weekday = simulate({ policy: p, snapshot: account(), path: drop(12), now: NOW, feeRate: 0 });
    expect(weekday.steps.every((s) => s.actions.length === 0)).toBe(true);
    const sat = nextTimeIn('weekend', NOW)!;
    expect(windowContains('weekend', sat)).toBe(true);
    const weekend = simulate({ policy: p, snapshot: account(), path: drop(12), now: sat, feeRate: 0 });
    expect(weekend.final.positions).toHaveLength(0);
    expect(weekend.liquidatedAt).toBeNull();
  });

  it('closing an isolated position returns its margin', () => {
    const snap = standardAccount({ xyz: { positions: [{ coin: CL, size: 10, mark: 90, leverage: 10, isolatedMargin: 120 }], crossEquity: 50 } });
    const p = policy([{ id: 'c', when: { kind: 'priceMove', market: CL, direction: 'down', movePct: 2, from: 'rule_confirmed' }, then: [{ kind: 'close', target: { kind: 'all' } }] }]);
    const path = drop(6, 24);
    const r = simulate({ policy: p, snapshot: snap, path, now: NOW, feeRate: 0 });
    const i = r.steps.findIndex((s) => s.actions.some((a) => a.type === 'order'));
    expect(r.final.positions).toHaveLength(0);
    const order = r.steps[i]!.actions.find((a) => a.type === 'order')!;
    if (order.type !== 'order') throw new Error('no order');
    const slip = order.size * (path[i]![CL]! - order.limitPx);
    expect(r.final.accountValue).toBeCloseTo(assessRisk(snap, path[i]).accountValue - slip, 9);
  });
});
