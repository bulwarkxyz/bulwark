import { priceAtBuffer } from './backstop.js';
import { evaluate } from './evaluate.js';
import type { Policy, Rule } from './policy.js';
import { assessRisk, type Marks } from './risk.js';
import { clone, fill } from './sim-state.js';
import type { AccountSnapshot } from './snapshot.js';

/**
 * EXPERIMENTAL (investigation, not used by the worker): every buffer stage as a reduce-only trigger
 * order resting on Hyperliquid, so the exchange fires it on its own mark price with no hop from us.
 *
 * For each stage, from the highest line down, and each position in each pool: the trigger price is
 * where that pool's buffer reaches the stage's line, moving only that position's mark (others held
 * still, as for the backstop); the size is what the stage itself would trim at that price, from the
 * same evaluator. Stages are planned cumulatively: a lower stage assumes the stages above it filled
 * at their trigger less `gapPct`. Stages that cannot be a price trigger are left to the server:
 * top-ups, alerts, cancels, time-window rules, and non-buffer triggers.
 */
export interface StageTrigger {
  ruleId: string;
  /** Fire key (`ruleId@pool`) the stage latches when it fires. */
  key: string;
  coin: string;
  isBuy: boolean;
  size: number;
  triggerPx: number;
}

const lineOf = (r: Rule) => (r.when.kind === 'buffer' ? r.when.below : null);

/**
 * `gapPct`: how much worse than its trigger each stage is assumed to fill when planning the stages
 * below it. A larger value prices lower stages earlier, which keeps them ahead of the account when an
 * earlier stage fills worse than planned and the server is slow to re-price them.
 */
export function planStageTriggers(policy: Policy, snapshot: AccountSnapshot, marks: Marks, opts: { latched: ReadonlySet<string>; gapPct: number; now: number }): StageTrigger[] {
  const stages = policy.rules.filter((r) => lineOf(r) !== null && r.window === undefined).sort((a, b) => (lineOf(b) as number) - (lineOf(a) as number));
  const s = clone(snapshot);
  const out: StageTrigger[] = [];
  for (const rule of stages) {
    const line = lineOf(rule) as number;
    const risk = assessRisk(s, marks);
    for (const pool of risk.pools) {
      const key = `${rule.id}@${pool.pool.id}`;
      if (opts.latched.has(key)) continue; // already fired for this breach: the server tracks it
      for (const row of pool.positions) {
        const px = priceAtBuffer(pool, row, line);
        const long = row.position.size > 0;
        if (px === null || !(long ? px < row.mark : px > row.mark)) continue; // already past the line
        // Just past the line, what does this stage do to this position?
        const at = { ...marks, [row.position.coin]: px * (long ? 1 - 1e-9 : 1 + 1e-9) };
        const d = evaluate({ ...policy, rules: [rule] }, s, at, { now: opts.now, baselines: {}, openOrders: [], latched: new Set(), automationAllowed: true });
        const order = d.actions.find((a) => a.type === 'order' && a.coin === row.position.coin);
        if (!order || order.type !== 'order') continue;
        out.push({ ruleId: rule.id, key, coin: row.position.coin, isBuy: order.isBuy, size: order.size, triggerPx: px });
        const fillPx = long ? px * (1 - opts.gapPct / 100) : px * (1 + opts.gapPct / 100);
        fill(s, row.position.coin, order.isBuy ? order.size : -order.size, fillPx, px, 0);
      }
    }
    s.positions = s.positions.filter((p) => p.size !== 0);
  }
  return out;
}
