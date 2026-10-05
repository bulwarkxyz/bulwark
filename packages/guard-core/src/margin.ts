import type { MarginTier } from './assets.js';

/**
 * Maintenance margin with tiers:
 *   maintenance_margin = notional * mmr(tier) - deduction(tier)
 *   mmr(tier) = 1 / (2 * maxLeverage(tier))
 *   deduction(0) = 0; deduction(n) = deduction(n-1) + lowerBound(n) * (mmr(n) - mmr(n-1))
 * https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margin-tiers
 */
export function maintenanceRate(tier: MarginTier): number {
  return 1 / (2 * tier.maxLeverage);
}

export function tierIndexFor(tiers: readonly MarginTier[], notional: number): number {
  let idx = 0;
  for (let i = 0; i < tiers.length; i++) {
    if (notional >= (tiers[i] as MarginTier).lowerBound) idx = i;
  }
  return idx;
}

function deductionAt(tiers: readonly MarginTier[], n: number): number {
  let d = 0;
  for (let i = 1; i <= n; i++) {
    const cur = tiers[i] as MarginTier;
    const prev = tiers[i - 1] as MarginTier;
    d += cur.lowerBound * (maintenanceRate(cur) - maintenanceRate(prev));
  }
  return d;
}

export function maintenanceMargin(tiers: readonly MarginTier[], notional: number): number {
  const abs = Math.abs(notional);
  if (abs === 0) return 0;
  const n = tierIndexFor(tiers, abs);
  return abs * maintenanceRate(tiers[n] as MarginTier) - deductionAt(tiers, n);
}

/** Maintenance rate of the tier that applies at a given notional (the `l` in the liquidation formula). */
export function maintenanceRateAt(tiers: readonly MarginTier[], notional: number): number {
  return maintenanceRate(tiers[tierIndexFor(tiers, Math.abs(notional))] as MarginTier);
}

/**
 * Liquidation price for one position with every other position in its pool held still.
 *
 * The docs give, for a single tier,
 *   liq_price = price - side * margin_available / position_size / (1 - l * side)
 *   margin_available = equity - maintenance_required
 * https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations
 *
 * Solving equity(P) = maintenance(P) directly gives the same result for one tier and stays exact for
 * tiered assets, whose maintenance carries a deduction:
 *   E + s·(P − m) = MMo + |s|·P·r_n − d_n   ⇒   P = (MMo − d_n − E + s·m) / (s − |s|·r_n)
 * choosing the tier n whose range contains the notional |s|·P. Returns null when no positive price
 * liquidates the position.
 */
export function liquidationPrice(args: PriceForBufferArgs): number | null {
  return priceForBuffer({ ...args, buffer: 1 });
}

export interface PriceForBufferArgs {
  mark: number;
  /** Signed size: positive long, negative short. */
  size: number;
  /** Pool equity at `mark`. */
  equity: number;
  /** Maintenance margin of the other positions in the same pool. */
  otherMaintenance: number;
  tiers: readonly MarginTier[];
}

/**
 * The mark at which a pool's buffer (equity ÷ maintenance) equals `buffer`, moving only this
 * position's mark. `buffer = 1` is the liquidation price; a user's line gives the price at which the
 * guard acts ("guard acts at"). Same derivation as the liquidation price with the line as a factor:
 *   E + s·(P − m) = B · (MMo + |s|·P·r_n − d_n)   ⇒   P = (B·(MMo − d_n) − E + s·m) / (s − B·|s|·r_n)
 * choosing the tier n whose range contains |s|·P. Returns null when no positive price reaches the line.
 */
export function priceForBuffer(args: PriceForBufferArgs & { buffer: number }): number | null {
  const { mark, size, equity, otherMaintenance, tiers, buffer } = args;
  if (size === 0 || !(buffer > 0)) return null;
  const abs = Math.abs(size);
  for (let n = 0; n < tiers.length; n++) {
    const r = maintenanceRate(tiers[n] as MarginTier);
    const d = deductionAt(tiers, n);
    const denom = size - buffer * abs * r;
    if (denom === 0) continue;
    const px = (buffer * (otherMaintenance - d) - equity + size * mark) / denom;
    if (!(px > 0) || !Number.isFinite(px)) continue;
    const notional = abs * px;
    const lo = (tiers[n] as MarginTier).lowerBound;
    const hi = n + 1 < tiers.length ? (tiers[n + 1] as MarginTier).lowerBound : Number.POSITIVE_INFINITY;
    if (notional >= lo && notional < hi) return px;
  }
  return null;
}

/**
 * Tiers that apply to an open position. A position keeps the max leverage it reports even if the
 * asset's listed max leverage was lowered later (observed on mainnet: INJ listed at 5×, position at 10×,
 * API liquidation price consistent with 10×).
 */
export function tiersForPosition(assetTiers: readonly MarginTier[], positionMaxLeverage: number | undefined): MarginTier[] {
  const tiers = assetTiers.map((t) => ({ ...t }));
  const first = tiers[0];
  if (first && positionMaxLeverage && positionMaxLeverage !== first.maxLeverage) {
    first.maxLeverage = positionMaxLeverage;
  }
  return tiers;
}
