import { describe, expect, it } from 'vitest';
import { evaluate, type GuardAction } from '../src/evaluate.js';
import { MAX_ACTIONS_PER_MINUTE, checkAction } from '../src/invariants.js';
import { RETRY_ALERT_AFTER, planRetries, recordFill, type RetryChain } from '../src/retry.js';
import { simulate } from '../src/simulate.js';
import { ctx, execCtx, policy, standardAccount } from './helpers.js';

type Order = Extract<GuardAction, { type: 'order' }>;
const CL = 'xyz:CL';
const NOW = Date.UTC(2026, 9, 7, 15, 0);
const account = (mark = 90, size = 10) => standardAccount({ xyz: { positions: [{ coin: CL, size, mark, leverage: 10 }], crossEquity: 100 - (90 - mark) * size } });
const stage = policy([{ id: 'stage-1', when: { kind: 'buffer', below: 2.5 }, then: [{ kind: 'reduceToBuffer', buffer: 4 }] }]);

/** The decision at `mark` with the stage already latched, as on every tick after it first fired. */
const held = (mark: number) => evaluate(stage, account(mark), { [CL]: mark }, ctx({ latched: new Set(['stage-1@dex:xyz']), now: NOW }));
const chain = (over: Partial<RetryChain> = {}): RetryChain => ({
  keys: ['stage-1@dex:xyz'], ruleId: 'stage-1', reason: 'buffer 2.10× below your 2.5× line', dex: 'xyz', coin: CL,
  isBuy: false, remaining: 4, failures: 1, lastAttemptAt: 0, alerted: false, ...over,
});
const orders = (a: GuardAction[]) => a.filter((x): x is Order => x.type === 'order');

describe('recordFill', () => {
  const order: Order = { type: 'order', ruleId: 'stage-1', reason: 'r', dex: 'xyz', coin: CL, assetId: 1, isBuy: false, size: 4, limitPx: 85, reduceOnly: true, tif: 'Ioc', closesPosition: false, keys: ['stage-1@dex:xyz'], attempt: 1 };
  it('a full fill ends the chain', () => expect(recordFill([chain()], order, 4, 10)).toEqual([]));
  it('a miss starts a chain with the whole size', () => {
    expect(recordFill([], order, 0, 10)).toEqual([chain({ reason: 'r', remaining: 4, failures: 1, lastAttemptAt: 10 })]);
  });
  it('a partial fill keeps only what is left and counts as a failed attempt', () => {
    const [c] = recordFill([chain({ failures: 2 })], order, 1.5, 10);
    expect(c).toMatchObject({ remaining: 2.5, failures: 3, lastAttemptAt: 10, reason: 'buffer 2.10× below your 2.5× line' });
  });
  it('orders not made by a stage start no chain', () => {
    const { keys: _, ...plain } = order;
    expect(recordFill([], plain, 0, 10)).toEqual([]);
  });
});

describe('planRetries', () => {
  const opts = { slippagePct: 1, automationAllowed: true };

  it('the stage latched and the order unfilled: re-sends the unfilled size, re-priced from the current mark', () => {
    const d = held(84);
    expect(d.actions).toEqual([]); // the latch alone would do nothing more
    const { actions, chains } = planRetries(d, [chain()], opts);
    const [o] = orders(actions);
    expect(o).toMatchObject({ coin: CL, isBuy: false, size: 4, reduceOnly: true, tif: 'Ioc', attempt: 2, keys: ['stage-1@dex:xyz'] });
    expect(o!.limitPx).toBeGreaterThanOrEqual(84 * 0.99 - 1e-9); // never past the user's slippage
    expect(o!.limitPx).toBeLessThan(84);
    expect(o!.reason).toContain('retry 1');
    expect(chains).toHaveLength(1);
  });

  it('every retry passes the same gate (I1–I7)', () => {
    const d = held(84);
    const [o] = orders(planRetries(d, [chain()], opts).actions);
    expect(checkAction(o!, stage, account(84), { [CL]: 84 }, execCtx(stage, { now: NOW }))).toBeNull();
  });

  it('never larger than the position', () => {
    const [o] = orders(planRetries(held(84), [chain({ remaining: 50 })], opts).actions);
    expect(o!.size).toBe(10);
    expect(o!.closesPosition).toBe(true);
  });

  it('stops once the stage condition clears', () => {
    const d = evaluate(stage, account(90), { [CL]: 90 }, ctx({ latched: new Set(['stage-1@dex:xyz']), now: NOW }));
    expect(d.active.size).toBe(0);
    expect(planRetries(d, [chain()], opts)).toEqual({ actions: [], chains: [] });
  });

  it('stops when the position is gone', () => {
    const d = evaluate(stage, standardAccount({ xyz: { positions: [], crossEquity: 100 } }), {}, ctx({ now: NOW }));
    expect(planRetries({ ...d, active: new Set(['stage-1@dex:xyz']) }, [chain()], opts).chains).toEqual([]);
  });

  it('stops where automatic action is off or the guard is stopped', () => {
    expect(planRetries(held(84), [chain()], { ...opts, automationAllowed: false })).toEqual({ actions: [], chains: [] });
  });

  it('waits for account state newer than the last attempt, so an unseen fill is never sent twice', () => {
    const r = planRetries(held(84), [chain({ lastAttemptAt: 500 })], { ...opts, stateAt: 500 });
    expect(orders(r.actions)).toEqual([]);
    expect(r.chains).toHaveLength(1);
    expect(orders(planRetries(held(84), [chain({ lastAttemptAt: 500 })], { ...opts, stateAt: 501 }).actions)).toHaveLength(1);
  });

  it('merges with a new stage order on the same position: the larger one, with both stages’ keys', () => {
    const two = policy([
      { id: 'stage-1', when: { kind: 'buffer', below: 2.5 }, then: [{ kind: 'reduceToBuffer', buffer: 4 }] },
      { id: 'stage-2', when: { kind: 'buffer', below: 2.2 }, then: [{ kind: 'close', target: { kind: 'all' } }] },
    ]);
    const d = evaluate(two, account(84), { [CL]: 84 }, ctx({ latched: new Set(['stage-1@dex:xyz']), now: NOW }));
    const [o, ...more] = orders(planRetries(d, [chain()], opts).actions);
    expect(more).toEqual([]);
    expect(o).toMatchObject({ size: 10, closesPosition: true });
    expect(new Set(o!.keys)).toEqual(new Set(['stage-1@dex:xyz', 'stage-2@dex:xyz']));
  });

  it(`after ${RETRY_ALERT_AFTER} failed attempts: one critical alert in plain words, and it keeps trying`, () => {
    const below = planRetries(held(84), [chain({ failures: RETRY_ALERT_AFTER - 1 })], opts);
    expect(below.actions.some((a) => a.type === 'alert')).toBe(false);
    const at = planRetries(held(84), [chain({ failures: RETRY_ALERT_AFTER })], opts);
    const alert = at.actions.find((a) => a.type === 'alert');
    expect(alert).toMatchObject({ level: 'critical' });
    expect(alert!.reason).toContain(`cannot fill ${CL} within your 1% slippage`);
    expect(orders(at.actions)).toHaveLength(1); // still trying
    expect(at.chains[0]!.alerted).toBe(true);
    const next = planRetries(held(84), at.chains, opts);
    expect(next.actions.filter((a) => a.type === 'alert')).toEqual([]); // not repeated
    expect(orders(next.actions)).toHaveLength(1);
  });
});

describe('simulate with retries', () => {
  // A fast fall (0.5% a step) that a 4-step delay overshoots, then a slow one (0.05% a step).
  const path = (() => {
    const out = [{ [CL]: 90 }];
    let m = 90;
    for (let i = 0; i < 14; i++) out.push({ [CL]: (m *= 0.995) });
    for (let i = 0; i < 60; i++) out.push({ [CL]: (m *= 0.9995) });
    return out;
  })();
  const run = (over: Partial<Parameters<typeof simulate>[0]> = {}) => simulate({ policy: stage, snapshot: account(), path, now: NOW, feeRate: 0, delaySteps: 4, ...over });

  it('before: a late order that missed leaves the stage done, and the account is liquidated', () => {
    const r = run({ retry: false });
    expect(r.missedOrders).toBe(1);
    expect(r.retryOrders).toBe(0);
    expect(r.liquidatedAt).not.toBeNull();
  });

  it('after: the stage retries at the new mark, fills, and the account survives', () => {
    const r = run();
    expect(r.missedOrders).toBe(1);
    expect(r.retryOrders).toBe(1);
    expect(r.liquidatedAt).toBeNull();
    expect(r.unguardedLiquidatedAt).not.toBeNull();
    const all = orders(r.steps.flatMap((s) => s.actions));
    for (const s of r.steps) for (const o of orders(s.actions)) expect(o.limitPx).toBeGreaterThanOrEqual(s.marks[CL]! * 0.99 - 1e-9);
    expect(all.every((o) => o.reduceOnly && !o.isBuy)).toBe(true);
  });

  it('with no delay, retries change nothing (fills are assumed)', () => {
    const { steps: a, ...ra } = run({ delaySteps: 0 });
    const { steps: b, ...rb } = run({ delaySteps: 0, retry: false });
    expect(ra).toEqual(rb);
    expect(a.length).toBe(b.length);
  });

  it('a steady fall faster than the slippage per delay: every attempt misses, the alert is raised, and the outcome is shown as it is', () => {
    const steep = Array.from({ length: 40 }, (_, i) => ({ [CL]: 90 * 0.994 ** i }));
    const r = simulate({ policy: stage, snapshot: account(), path: steep, now: NOW, feeRate: 0, delaySteps: 2 });
    expect(r.missedOrders).toBeGreaterThanOrEqual(RETRY_ALERT_AFTER);
    expect(r.retryAlertAt).not.toBeNull();
    expect(r.liquidatedAt).not.toBeNull();
  });

  it('regression: while an order is in flight the guard decides nothing new, so a stage flickering across its line cannot stack trims', () => {
    // Below the line, then flickering across it every step while the first order is on its way.
    const flicker = [90, 85, ...Array.from({ length: 30 }, (_, i) => (i % 2 ? 85 : 86.5))].map((m) => ({ [CL]: m }));
    const half = policy([{ id: 'stage-1', when: { kind: 'buffer', below: 2.5 }, then: [{ kind: 'reduce', target: { kind: 'all' }, fraction: 0.5 }] }]);
    const r = simulate({ policy: half, snapshot: account(), path: flicker, now: NOW, feeRate: 0, delaySteps: 10 });
    const decided = r.steps.filter((s) => orders(s.actions).length).map((s) => s.step);
    for (let k = 1; k < decided.length; k++) expect(decided[k]! - decided[k - 1]!).toBeGreaterThanOrEqual(10);
    const unguarded = simulate({ policy: half, snapshot: account(), path: flicker, now: NOW, feeRate: 0 });
    expect(r.final.positions[0]?.size ?? 0).toBeGreaterThan(0);
    expect(unguarded.final.positions[0]?.size ?? 0).toBeGreaterThan(0);
  });

  it('the I6 rate cap still applies to stage orders and retries', () => {
    const p = policy([{ id: 'dip', when: { kind: 'priceMove', market: CL, direction: 'down', movePct: 3, from: 'rule_confirmed' }, then: [{ kind: 'reduce', target: { kind: 'all' }, fraction: 0.02 }] }]);
    // Crosses the 3% line every other step, so the stage re-arms and fires 30 times in a minute.
    const zigzag = Array.from({ length: 61 }, (_, i) => ({ [CL]: i === 0 ? 90 : i % 2 ? 87 : 88 }));
    const r = simulate({ policy: p, snapshot: account(), path: zigzag, now: NOW, feeRate: 0, stepMs: 1000 });
    expect(r.rateCapped).toBeGreaterThan(0);
    const sent = r.steps.flatMap((s) => orders(s.actions).map(() => s.step));
    expect(sent.length).toBeGreaterThan(MAX_ACTIONS_PER_MINUTE);
    const r2 = simulate({ policy: p, snapshot: account(), path: zigzag, now: NOW, feeRate: 0 });
    expect(r2.rateCapped).toBe(0);
    expect(r2.final.positions[0]!.size).toBeLessThan(r.final.positions[0]!.size); // capped run trimmed less
  });
});
