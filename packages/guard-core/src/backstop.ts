import type { MarginTier } from './assets.js';
import type { GuardAction, OpenOrder } from './evaluate.js';
import { maintenanceRate } from './margin.js';
import type { Policy } from './policy.js';
import { assessRisk, type Marks, type PoolRisk, type PositionRisk } from './risk.js';
import { roundPrice } from './rounding.js';
import type { AccountSnapshot } from './snapshot.js';

/**
 * Backstops: a reduce-only stop-market order per position, resting on the exchange at the price where
 * the position's pool would reach the user's lowest buffer line (others held still). Trigger orders are
 * exchange state and fire on the mark price, so they protect the account even when Bulwark is slow or
 * unreachable. https://hyperliquid.gitbook.io/hyperliquid-docs/trading/take-profit-and-stop-loss-orders-tp-sl
 *
 * No backstop is placed when the policy has no buffer line: the trigger price comes only from the
 * user's own numbers (decision D5).
 */

/** Re-place a backstop when its trigger has drifted this far from where it should be (engine constant). */
export const BACKSTOP_DRIFT = 0.005;

function deduction(tiers: readonly MarginTier[], n: number): number {
  let d = 0;
  for (let i = 1; i <= n; i++) d += (tiers[i] as MarginTier).lowerBound * (maintenanceRate(tiers[i] as MarginTier) - maintenanceRate(tiers[i - 1] as MarginTier));
  return d;
}

/**
 * Price at which the pool buffer equals `line`, moving only this position's mark:
 *   E + s(P − m) = L · (MMo + |s|·P·r_n − d_n)   ⇒   P = (L·(MMo − d_n) − E + s·m) / (s − L·|s|·r_n)
 */
export function priceAtBuffer(pool: PoolRisk, row: PositionRisk, line: number): number | null {
  const s = row.position.size;
  const abs = Math.abs(s);
  const tiers = row.position.tiers;
  const others = pool.maintenance - row.maintenance;
  for (let n = 0; n < tiers.length; n++) {
    const r = maintenanceRate(tiers[n] as MarginTier);
    const denom = s - line * abs * r;
    if (denom === 0) continue;
    const px = (line * (others - deduction(tiers, n)) - pool.equity + s * row.mark) / denom;
    if (!(px > 0) || !Number.isFinite(px)) continue;
    const lo = (tiers[n] as MarginTier).lowerBound;
    const hi = n + 1 < tiers.length ? (tiers[n + 1] as MarginTier).lowerBound : Number.POSITIVE_INFINITY;
    if (abs * px >= lo && abs * px < hi) return px;
  }
  return null;
}

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
    for (const row of pool.positions) {
      const p = row.position;
      const mine = existing.filter((o) => o.coin === p.coin);
      const px = priceAtBuffer(pool, row, line);
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
        reason: `backstop at your ${line}× line`,
        dex: p.dex,
        coin: p.coin,
        assetId: p.asset.assetId,
        isBuy,
        size,
        triggerPx,
        limitPx,
        reduceOnly: true,
        tpsl: 'sl',
      });
    }
  }
  for (const o of existing) {
    if (!covered.has(o.oid)) plan.cancel.push({ type: 'cancel', ruleId: lowest.id, reason: 'replacing backstop', dex: dexOf(o.coin), coin: o.coin, oid: o.oid });
  }
  return plan;
}

const dexOf = (coin: string): string => (coin.includes(':') ? (coin.split(':')[0] as string) : '');
