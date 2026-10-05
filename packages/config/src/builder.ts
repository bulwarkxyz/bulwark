/**
 * Builder code settings (decisions D2 and D6).
 *
 * Fee: flat 3 bps on every market, guard orders included. Orders carry `{"b": builder, "f": 30}`
 * where f is in tenths of a basis point. Users approve a maximum of 0.05%.
 * https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes
 *
 * Mainnet is OFF until the builder account holds ≥100 USDC perps value in standard mode: with an
 * unfunded builder the user's approval fails ("Builder has insufficient balance to be approved.") and
 * orders carrying the code are rejected ("Builder fee has not been approved"). Turning it on is
 * funding the builder and setting BUILDER_CODE_ENABLED_MAINNET=true — no code change.
 */
export type Network = 'mainnet' | 'testnet';

export const BUILDER_ADDRESS = '0x813843cf39a4d312182af6c5b85cff9290c42981' as const;
export const BUILDER_FEE_TENTHS_BPS = 30;
export const BUILDER_APPROVE_MAX_RATE = '0.05%';
export const BUILDER_APPROVE_MAX_TENTHS_BPS = 50;

const flag = (v: string | undefined, fallback: boolean) => (v === undefined ? fallback : v === 'true' || v === '1');

export function builderEnabled(network: Network, env: Record<string, string | undefined> = process.env): boolean {
  return network === 'mainnet' ? flag(env.BUILDER_CODE_ENABLED_MAINNET, false) : flag(env.BUILDER_CODE_ENABLED_TESTNET, true);
}

/** The builder field to attach to an order, or null when disabled for this network. */
export function builderField(network: Network, env: Record<string, string | undefined> = process.env): { b: string; f: number } | null {
  return builderEnabled(network, env) ? { b: BUILDER_ADDRESS, f: BUILDER_FEE_TENTHS_BPS } : null;
}
