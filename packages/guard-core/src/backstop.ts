import type { GuardAction, OpenOrder } from './evaluate.js';
import { priceForBuffer } from './margin.js';
import type { Policy } from './policy.js';
import { assessRisk, markOf, type Marks, type PoolRisk, type PositionRisk } from './risk.js';
import { roundPrice } from './rounding.js';
import type { AccountSnapshot } from './snapshot.js';

/**
 * Backstops: a reduce-only stop order per position, resting on the exchange at the price where the
 * position's pool would reach the user's lowest buffer line. Trigger orders are exchange state and fire
 * on the mark price, so they protect the account even when Bulwark is slow or unreachable.
 * https://hyperliquid.gitbook.io/hyperliquid-docs/trading/take-profit-and-stop-loss-orders-tp-sl
 *
 * Pricing:
 * - 'single': moving only this position's mark, others held still. In a pool with several positions
 *   that move together, the pool reaches the line long before any single-position price (two equal
 *   positions falling together cross a 2× line after 5.8%; each single-position price is 11.5% away).
 * - 'together': as if every position in the pool moves against you by the same percentage at once
 *   (longs fall, shorts rise). Each stop is placed at the earlier of that price and its single price,
 *   so it fires no later than the line would be crossed under either assumption. The cost: when only
 *   one position falls, its stop fires earlier than strictly needed.
 *
 * No backstop is placed when the policy has no buffer line: the trigger price comes only from the
 * user's own numbers (decision D5).
 */

/** Re-place a backstop when its trigger has drifted this far from where it should be (engine constant). */
export const BACKSTOP_DRIFT = 0.005;

/**
 * Price at which the pool buffer equals `line`, moving only this position's mark (see
 * `priceForBuffer` in margin.ts, which also gives the liquidation price at a line of 1).
 */
export function priceAtBuffer(pool: PoolRisk, row: PositionRisk, line: number): number | null {
  return priceForBuffer({ mark: row.mark, size: row.position.size, equity: pool.equity, otherMaintenance: pool.maintenance - row.maintenance, tiers: row.position.tiers, buffer: line });
}

/**
 * The smallest common adverse move f (a fraction) at which the pool's buffer reaches `line` when every
 * position in it moves against the holder by f at once. Null when the pool is already at or past the
 * line, or has no maintenance.
 */
export function togetherMove(snapshot: AccountSnapshot, marks: Marks | undefined, poolId: string, line: number): number | null {
  const members = snapshot.positions.filter((p) => p.poolId === poolId);
  if (!members.length) return null;
  const bufferAt = (f: number) => {
    const moved: Record<string, number> = { ...(marks ?? {}) };
    for (const p of members) moved[p.coin] = markOf(p, marks) * (p.size > 0 ? 1 - f : 1 + f);
    const pool = assessRisk(snapshot, moved).pools.find((x) => x.pool.id === poolId);
    return pool && pool.maintenance > 0 ? pool.buffer : Number.POSITIVE_INFINITY;
  };
  if (!(bufferAt(0) > line)) return null;
  let lo = 0;
  let hi = 0.999;
  if (bufferAt(hi) > line) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bufferAt(mid) > line) lo = mid;
    else hi = mid;
  }
  return hi;
}

export type BackstopPricing = 'single' | 'together';

export interface BackstopPlan {
  place: Array<Extract<GuardAction, { type: 'trigger' }>>;
  cancel: Array<Extract<GuardAction, { type: 'cancel' }>>;
}

export function planBackstops(
  policy: Policy,
  snapshot: AccountSnapshot,
  marks: Marks | undefined,
  /** The guard's own resting triggers (from its records), with their trigger price and size. */
  existing: readonly OpenOrder[],
  pricing: BackstopPricing = 'single',
): BackstopPlan {
  const plan: BackstopPlan = { place: [], cancel: [] };
  const risk = assessRisk(snapshot, marks);
  const lineRules = policy.rules.filter((r) => r.when.kind === 'buffer');
  if (!risk.supported || lineRules.length === 0) {
    for (const o of existing) plan.cancel.push({ type: 'cancel', ruleId: lineRules[0]?.id ?? policy.rules[0]?.id ?? 'backstop', reason: 'backstop no longer needed', dex: dexOf(o.coin), coin: o.coin, oid: o.oid });
    return plan;
  }
  const lowest = lineRules.reduce((a, b) => ((a.when as { below: number }).below <= (b.when as { below: number }).below ? a : b));
  const line = (lowest.when as { below: number }).below;
  const slip = policy.execution.maxSlippagePct / 100;
  const covered = new Set<number>();

  for (const pool of risk.pools) {
    const together = pricing === 'together' && pool.positions.length > 1 ? togetherMove(snapshot, marks, pool.pool.id, line) : null;
    for (const row of pool.positions) {
      const p = row.position;
      const mine = existing.filter((o) => o.coin === p.coin);
      const single = priceAtBuffer(pool, row, line);
      const joint = together === null ? null : row.mark * (p.size > 0 ? 1 - together : 1 + together);
      // The earlier of the two: higher for a long, lower for a short.
      const px = single === null ? joint : joint === null ? single : p.size > 0 ? Math.max(single, joint) : Math.min(single, joint);
      const losingSide = px !== null && (p.size > 0 ? px < row.mark : px > row.mark);
      if (px === null || !losingSide) {
        // Already past the line (the live guard is acting) or no such price: leave existing ones alone.
        for (const o of mine) covered.add(o.oid);
        continue;
      }
      const isBuy = p.size < 0;
      const d = p.asset.szDecimals;
      // Round the trigger toward the mark (fires slightly earlier, never later than the line).
      const triggerPx = roundPrice(px, d, isBuy ? 'down' : 'up');
      // Less than one tick from the line: it is effectively crossed, and the live guard acts.
      if (!(isBuy ? triggerPx > row.mark : triggerPx < row.mark)) {
        for (const o of mine) covered.add(o.oid);
        continue;
      }
      const rawLimit = isBuy ? triggerPx * (1 + slip) : triggerPx * (1 - slip);
      let limitPx = roundPrice(rawLimit, d, isBuy ? 'up' : 'down');
      if (Math.abs(limitPx - triggerPx) / triggerPx > slip) limitPx = roundPrice(rawLimit, d, isBuy ? 'down' : 'up');
      const size = Math.abs(p.size);
      const current = mine.find((o) => o.triggerPx !== undefined && Math.abs((o.triggerPx as number) - triggerPx) / triggerPx <= BACKSTOP_DRIFT && Math.abs((o.size ?? 0) - size) < 1e-12);
      if (current) {
        covered.add(current.oid);
        continue;
      }
      if (Math.abs(limitPx - triggerPx) / triggerPx > slip + 1e-12) continue; // no valid limit inside the user's slippage
      plan.place.push({
        type: 'trigger',
        ruleId: lowest.id,
        reason: joint !== null && px === joint ? `backstop at your ${line}× line, priced as if every position in this pool moves against you at once` : `backstop at your ${line}× line`,
        dex: p.dex,
        coin: p.coin,
        assetId: p.asset.assetId,
        isBuy,
        size,
        triggerPx,
        limitPx,
        reduceOnly: true,
        tpsl: 'sl',
        line,
        pricing: joint !== null && px === joint ? 'together' : 'single',
      });
    }
  }
  for (const o of existing) {
    if (!covered.has(o.oid)) plan.cancel.push({ type: 'cancel', ruleId: lowest.id, reason: 'replacing backstop', dex: dexOf(o.coin), coin: o.coin, oid: o.oid });
  }
  return plan;
}

const dexOf = (coin: string): string => (coin.includes(':') ? (coin.split(':')[0] as string) : '');

/** Why a position has no backstop resting below (above, for a short) its price. */
export type NoBackstop =
  /** The pool is at or past the lowest line: the live guard acts instead. */
  | { reason: 'line_crossed'; line: number; buffer: number }
  /**
   * Margin large next to the position: a fall lowers maintenance faster than equity, so the buffer rises as the
   * price falls and never reaches the line. Happens to a long once the pool's buffer is at or above
   * `ceiling` (its notional over its maintenance, about 1 / its maintenance rate: 50× for a 2% rate).
   */
  | { reason: 'margin_too_large'; line: number; buffer: number; ceiling: number };

/**
 * For each position the planner would leave without a backstop, why, so the app can say it in words. Positions
 * that get one are absent. Mirrors planBackstops' pricing (single, or together for pools with several positions).
 */
export function whyNoBackstop(policy: Policy, snapshot: AccountSnapshot, marks: Marks | undefined, pricing: BackstopPricing = 'single'): Record<string, NoBackstop> {
  const out: Record<string, NoBackstop> = {};
  const risk = assessRisk(snapshot, marks);
  const lines = policy.rules.flatMap((r) => (r.when.kind === 'buffer' ? [r.when.below] : []));
  if (!risk.supported || !lines.length) return out;
  const line = Math.min(...lines);
  for (const pool of risk.pools) {
    const together = pricing === 'together' && pool.positions.length > 1 ? togetherMove(snapshot, marks, pool.pool.id, line) : null;
    for (const row of pool.positions) {
      const p = row.position;
      if (!(pool.buffer > line)) {
        out[p.coin] = { reason: 'line_crossed', line, buffer: pool.buffer };
        continue;
      }
      const single = priceAtBuffer(pool, row, line);
      const losing = (px: number | null) => px !== null && (p.size > 0 ? px < row.mark : px > row.mark);
      if (losing(single) || together !== null) continue;
      out[p.coin] = { reason: 'margin_too_large', line, buffer: pool.buffer, ceiling: row.maintenance > 0 ? row.notional / row.maintenance : Number.POSITIVE_INFINITY };
    }
  }
  return out;
}
