import { describe, expect, it } from 'vitest';
import { priceAtBuffer } from '../src/backstop.js';
import { evaluate } from '../src/evaluate.js';
import { assessRisk } from '../src/risk.js';
import { simulate } from '../src/simulate.js';
import { planStageTriggers } from '../src/stage-triggers.js';
import { ctx, policy, standardAccount } from './helpers.js';

const CL = 'xyz:CL';
const NOW = Date.UTC(2026, 9, 7, 15, 0);
// 10 CL at 90 with 100 USDC on xyz: buffer ≈ 4.4; a fall of about 9% liquidates.
const account = () => standardAccount({ xyz: { positions: [{ coin: CL, size: 10, mark: 90, leverage: 10 }], crossEquity: 100 } });
const stages = policy([
  { id: 'stage-1', when: { kind: 'buffer', below: 3 }, then: [{ kind: 'reduceToBuffer', buffer: 4 }] },
  { id: 'stage-2', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'reduceToBuffer', buffer: 3 }] },
  { id: 'stage-3', when: { kind: 'buffer', below: 1.3 }, then: [{ kind: 'close', target: { kind: 'all' } }] },
]);
const plan = (p = stages, latched = new Set<string>()) => planStageTriggers(p, account(), { [CL]: 90 }, { latched, gapPct: 1, now: NOW });

describe('stage triggers (experimental)', () => {
  it('one reduce-only trigger per stage, highest line first, each lower stage priced after the ones above filled', () => {
    const t = plan();
    expect(t.map((x) => x.ruleId)).toEqual(['stage-1', 'stage-2', 'stage-3']);
    expect(t.every((x) => !x.isBuy && x.size > 0)).toBe(true);
    expect(t[0]!.triggerPx).toBeGreaterThan(t[1]!.triggerPx);
    expect(t[1]!.triggerPx).toBeGreaterThan(t[2]!.triggerPx);
    // Stage 1 fires exactly where the pool reaches its line, and trims what the guard itself would.
    const risk = assessRisk(account(), { [CL]: 90 });
    const pool = risk.pools[0]!;
    expect(t[0]!.triggerPx).toBeCloseTo(priceAtBuffer(pool, pool.positions[0]!, 3)!, 9);
    const just = evaluate(policy([stages.rules[0]!]), account(), { [CL]: t[0]!.triggerPx * (1 - 1e-9) }, ctx({ now: NOW }));
    expect(t[0]!.size).toBe((just.actions[0] as { size: number }).size);
    // The last stage closes what is left after stages 1 and 2.
    expect(t[2]!.size).toBeCloseTo(10 - t[0]!.size - t[1]!.size, 6);
  });

  it('leaves to the server: stages already fired, time-window rules, and actions a price trigger cannot express', () => {
    expect(plan(stages, new Set(['stage-1@dex:xyz'])).map((x) => x.ruleId)).toEqual(['stage-2', 'stage-3']);
    const mixed = policy([
      { id: 'weekend', window: 'weekend', when: { kind: 'buffer', below: 3 }, then: [{ kind: 'close', target: { kind: 'all' } }] },
      { id: 'top-up', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'topUp', maxUsdc: 50 }] },
      { id: 'dd', when: { kind: 'drawdown', atLeastPct: 5, baseline: 'rule_confirmed' }, then: [{ kind: 'close', target: { kind: 'all' } }] },
    ]);
    expect(plan(mixed)).toEqual([]);
  });

  it('a resting stage trigger acts even when the server is 5 minutes late', () => {
    // A steep fall: 0.3% per 3-second round, about 9% in a minute and a half.
    const path = Array.from({ length: 200 }, (_, i) => ({ [CL]: 90 * 0.997 ** Math.min(i, 40) }));
    const base = { policy: stages, snapshot: account(), path, now: NOW, feeRate: 0, delaySteps: 100 };
    const server = simulate(base);
    const resting = simulate({ ...base, stageTriggers: { gapPct: 1 } });
    expect(server.liquidatedAt).not.toBeNull();
    expect(resting.liquidatedAt).toBeNull();
    expect(resting.triggerFills).toBeGreaterThan(0);
  });

  it('a trigger whose fill would be worse than the exchange tolerance does not fill, and the server is the second line', () => {
    // One gap of 15% straight through every line.
    const path = [{ [CL]: 90 }, { [CL]: 90 }, ...Array.from({ length: 20 }, () => ({ [CL]: 90 * 0.9 }))];
    const r = simulate({ policy: stages, snapshot: account(), path, now: NOW, feeRate: 0, stageTriggers: { gapPct: 1, tolerancePct: 5 } });
    expect(r.triggerMisses).toBeGreaterThan(0);
  });

  it('the backstop: once triggered it rests as a limit and fills only when the mark is back within it', () => {
    const lowest = policy([{ id: 'floor', when: { kind: 'buffer', below: 3.5 }, then: [{ kind: 'alert' }] }]);
    const risk = assessRisk(account(), { [CL]: 90 });
    const px = priceAtBuffer(risk.pools[0]!, risk.pools[0]!.positions[0]!, 3.5)!;
    // Gap 1.5% below the trigger (past the 1% limit), then back to just under the trigger.
    const path = [{ [CL]: 90 }, { [CL]: px * 0.985 }, { [CL]: px * 0.985 }, { [CL]: px * 0.995 }, { [CL]: px * 0.995 }];
    const r = simulate({ policy: lowest, snapshot: account(), path, now: NOW, feeRate: 0, backstops: true });
    expect(r.steps[2]!.accountValue).toBeLessThan(r.steps[0]!.accountValue);
    expect(r.triggerFills).toBe(1);
    expect(r.liquidatedAt).toBeNull();
    expect(r.final.positions).toEqual([]);
    expect(r.triggerFills).toBe(1);
  });

  it('regression: a late retry that fills re-prices the resting backstop for the smaller position', () => {
    const p = policy([
      { id: 'trim', when: { kind: 'buffer', below: 3 }, then: [{ kind: 'reduce', target: { kind: 'all' }, fraction: 0.5 }], repeat: { mode: 'oncePerBreach' } },
      { id: 'floor', when: { kind: 'buffer', below: 1.3 }, then: [{ kind: 'alert' }] },
    ]);
    // The stage fires at 86; its late order lands at 84, past its limit, and misses; the retry fills.
    const path = [90, 86, 86, 86, 84, 84, 84, 84, 84, 84, 84, 84].map((m) => ({ [CL]: m }));
    const r = simulate({ policy: p, snapshot: account(), path, now: NOW, feeRate: 0, backstops: true, delaySteps: 3 });
    expect(r.events.map((e) => e.kind)).toEqual(['missed', 'server']);
    // placed at the start, re-placed when the stage fired, and again after the retry filled
    expect(r.resyncs).toBe(3);
  });

  it('off by default: results are exactly as before', () => {
    const path = Array.from({ length: 60 }, (_, i) => ({ [CL]: 90 * 0.998 ** i }));
    const r = simulate({ policy: stages, snapshot: account(), path, now: NOW, feeRate: 0.00045 });
    expect([r.triggerFills, r.triggerMisses, r.resyncs]).toEqual([0, 0, 0]);
  });
});
