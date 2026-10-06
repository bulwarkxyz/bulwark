import { describe, expect, it } from 'vitest';
import { evaluate, type Decision } from '../src/evaluate.js';
import { needsRepeatChoice, Policy, type Repeat, type Rule } from '../src/policy.js';
import { simulate } from '../src/simulate.js';
import { ctx, policy, standardAccount } from './helpers.js';

const CL = 'xyz:CL';
const NOW = Date.UTC(2026, 9, 7, 15, 0);
// 10 CL at 90 with 100 USDC on xyz: buffer ≈ 4.4.
const account = (size = 10, mark = 90, equity = 100) => standardAccount({ xyz: { positions: [{ coin: CL, size, mark, leverage: 10 }], crossEquity: equity } });
/** The account at mark `m`, before any trim (equity moves with the price). */
const at = (m: number) => account(10, m, 100 - 10 * (90 - m));
const stage = (repeat?: Repeat): Rule => ({ id: 'stage-1', when: { kind: 'buffer', below: 3 }, then: [{ kind: 'reduce', target: { kind: 'all' }, fraction: 0.2 }], ...(repeat ? { repeat } : {}) });

/** Steps the evaluator along a path, applying each trim to the account (no fees, fills at the mark). */
function walk(rule: Rule, path: number[]) {
  let size = 10;
  let cash = 100 - 900; // equity = cash + size × mark
  let state: Pick<Decision, 'latched' | 'breaches' | 'fires'> = { latched: new Set(), breaches: {}, fires: {} };
  const acted: number[] = [];
  path.forEach((m, i) => {
    const d = evaluate(policy([rule]), account(size, m, cash + size * m), { [CL]: m }, ctx({ now: NOW + i * 60_000, latched: state.latched, breaches: state.breaches, fires: state.fires }));
    state = d;
    for (const a of d.actions) if (a.type === 'order') {
      size -= a.size;
      cash += a.size * m;
      acted.push(m);
    }
  });
  return acted;
}

describe('repeat: the user chooses per stage', () => {
  // Falls, pauses, falls again: the first trim lifts the buffer back above the line, then it falls back.
  const fall = [90, 88, 87, 86.6, 86.3, 86.2, 85.6, 85.2, 84.8, 84.4, 84.2];

  it('every crossing: the stage acts again each time the buffer comes back above its line and falls through it', () => {
    expect(walk(stage({ mode: 'everyCrossing' }), fall).length).toBeGreaterThan(1);
  });

  it('once per breach: it acts once; its own trim lifting the buffer does not re-arm it', () => {
    expect(walk(stage({ mode: 'oncePerBreach' }), fall)).toHaveLength(1);
  });

  it('once per breach: it re-arms after the market recovers to where it was when it acted', () => {
    const acted = walk(stage({ mode: 'oncePerBreach' }), [90, 86.3, 86.2, 88, 90, 86, 85, 84.5, 84]);
    expect(acted).toHaveLength(2);
  });

  it('once per breach: a flat market does not re-arm it while the line is still crossed (testnet run, 6 Oct: it fired twice in 2 s)', () => {
    // A line far above the buffer (the canary): the trim cannot lift the buffer over it, and the price never moves.
    const canary: Rule = { ...stage({ mode: 'oncePerBreach' }), when: { kind: 'buffer', below: 10 } };
    expect(walk(canary, [86, 86, 86, 86, 86, 86])).toHaveLength(1);
  });

  it('once per breach: it re-arms once the position it acted on is gone', () => {
    const r: Rule = { ...stage({ mode: 'oncePerBreach' }), then: [{ kind: 'close', target: { kind: 'all' } }] };
    let d = evaluate(policy([r]), at(86), { [CL]: 86 }, ctx({ now: NOW }));
    expect(d.latched.size).toBe(1);
    d = evaluate(policy([r]), standardAccount({ xyz: { positions: [], crossEquity: 80 } }), {}, ctx({ now: NOW + 1, latched: d.latched, breaches: d.breaches }));
    expect(d.latched.size).toBe(0);
  });

  it('a limit the user typed: at most N actions in H hours, then one alert per crossing; the limit window slides', () => {
    const r = stage({ mode: 'everyCrossing', limit: { times: 1, perHours: 2 } });
    let d = evaluate(policy([r]), at(86), { [CL]: 86 }, ctx({ now: NOW }));
    expect(d.actions.filter((a) => a.type === 'order')).toHaveLength(1);
    // back above the line, then through it again within 2 hours: held, with an alert
    d = evaluate(policy([r]), at(90), { [CL]: 90 }, ctx({ now: NOW + 60_000, latched: d.latched, fires: d.fires }));
    d = evaluate(policy([r]), at(86), { [CL]: 86 }, ctx({ now: NOW + 120_000, latched: d.latched, fires: d.fires }));
    expect(d.actions.filter((a) => a.type === 'order')).toHaveLength(0);
    expect(d.actions.find((a) => a.type === 'alert')?.reason).toMatch(/acted 1 time in the last 2 h, your limit, so it holds\. Your backstop still stands\./);
    // still below the line: no repeated alert
    const again = evaluate(policy([r]), at(85.9), { [CL]: 85.9 }, ctx({ now: NOW + 180_000, latched: d.latched, fires: d.fires }));
    expect(again.actions).toEqual([]);
    // more than 2 hours after the first action, a new crossing acts again
    d = evaluate(policy([r]), at(90), { [CL]: 90 }, ctx({ now: NOW + 2 * 3_600_000 + 1, latched: again.latched, fires: again.fires }));
    d = evaluate(policy([r]), at(86), { [CL]: 86 }, ctx({ now: NOW + 2 * 3_600_000 + 2, latched: d.latched, fires: d.fires }));
    expect(d.actions.filter((a) => a.type === 'order')).toHaveLength(1);
  });

  it('policies signed before the choice existed still load, run as every crossing, and are listed as needing the choice', () => {
    const old = policy([stage(), { ...stage({ mode: 'oncePerBreach' }), id: 'stage-2' }]);
    expect(Policy.parse(old)).toBeTruthy();
    expect(needsRepeatChoice(old)).toEqual(['stage-1']);
    expect(walk(stage(), fall)).toEqual(walk(stage({ mode: 'everyCrossing' }), fall));
  });

  it('the schema takes only the two modes and a positive whole limit', () => {
    expect(Policy.safeParse(policy([stage({ mode: 'sometimes' as never })])).success).toBe(false);
    expect(Policy.safeParse(policy([stage({ mode: 'everyCrossing', limit: { times: 1.5, perHours: 2 } })])).success).toBe(false);
    expect(Policy.safeParse(policy([stage({ mode: 'everyCrossing', limit: { times: 2, perHours: 0 } })])).success).toBe(false);
  });

  it('in the simulator, on a stepped fall, once per breach trims less than every crossing', () => {
    const path = Array.from({ length: 120 }, (_, i) => ({ [CL]: 90 * (1 - 0.0008 * i) * (1 + 0.004 * Math.sin(i / 3)) }));
    const run = (repeat: Repeat) => simulate({ policy: policy([stage(repeat)]), snapshot: account(), path, now: NOW, feeRate: 0, stepMs: 60_000 });
    const once = run({ mode: 'oncePerBreach' });
    const every = run({ mode: 'everyCrossing' });
    const orders = (r: typeof once) => r.events.filter((e) => e.kind === 'server').length;
    expect(orders(once)).toBe(1);
    expect(orders(every)).toBeGreaterThan(1);
  });
});
