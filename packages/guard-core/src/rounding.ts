/**
 * Hyperliquid tick and lot rules for perps: sizes are rounded to the asset's szDecimals; prices may have
 * at most 5 significant figures and at most (6 − szDecimals) decimals, and integer prices are always
 * allowed. https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
 */
const PERP_MAX_DECIMALS = 6;

/** Minimum order value in quote units. https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses */
export const MIN_ORDER_NOTIONAL = 10;

const pow10 = (n: number) => 10 ** n;

export function floorSize(size: number, szDecimals: number): number {
  const f = pow10(szDecimals);
  return Math.floor(Math.abs(size) * f + 1e-9) / f;
}

export function ceilSize(size: number, szDecimals: number): number {
  const f = pow10(szDecimals);
  return Math.ceil(Math.abs(size) * f - 1e-9) / f;
}

/**
 * Rounds a price to a valid perp tick. `direction` picks which side to round to: a protective sell
 * rounds down (more aggressive), a protective buy rounds up.
 */
export function roundPrice(px: number, szDecimals: number, direction: 'down' | 'up'): number {
  if (!(px > 0)) throw new Error(`invalid price ${px}`);
  const maxDecimals = Math.max(0, PERP_MAX_DECIMALS - szDecimals);
  const magnitude = Math.floor(Math.log10(px));
  // decimals allowed by 5 significant figures
  const sigDecimals = Math.max(0, 4 - magnitude);
  const decimals = Math.min(maxDecimals, sigDecimals);
  const f = pow10(decimals);
  const scaled = px * f;
  const r = direction === 'down' ? Math.floor(scaled + 1e-9) : Math.ceil(scaled - 1e-9);
  const out = r / f;
  // Integer prices are always valid, even beyond 5 significant figures.
  return decimals === 0 ? Math.max(1, out) : out;
}

/** Formats a number the way the exchange expects in signed actions: no trailing zeros, no exponent. */
export function toWire(x: number, decimals = 8): string {
  const s = x.toFixed(decimals);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
