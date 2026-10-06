import { builderEnabled } from '@bulwarkxyz/config';
import type { Network } from '@bulwarkxyz/hyperliquid';

export const NETWORK: Network = process.env.NEXT_PUBLIC_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
/** Builder code on/off for this network, from the same switch the worker uses (decision D6). */
export const BUILDER_ON = builderEnabled(NETWORK, {
  BUILDER_CODE_ENABLED_MAINNET: process.env.NEXT_PUBLIC_BUILDER_CODE_ENABLED_MAINNET,
  BUILDER_CODE_ENABLED_TESTNET: process.env.NEXT_PUBLIC_BUILDER_CODE_ENABLED_TESTNET,
});
/**
 * WalletConnect (Reown) project ID, for wallets on a phone or in another app. Without it the connect
 * modal offers browser wallets only (EIP-6963 discovery). Public by design: it identifies the app.
 */
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '';

/** Hyperliquid's explorer page for an address, on this app's network. */
export const explorerAddress = (address: string) => `${NETWORK === 'mainnet' ? 'https://app.hyperliquid.xyz' : 'https://app.hyperliquid-testnet.xyz'}/explorer/address/${address}`;

/**
 * Take profit / stop loss on positions: testnet only. On for everyone when the build sets
 * NEXT_PUBLIC_TPSL=1; until then one browser can opt in (localStorage bw.tpsl = "1") to try it on the live
 * site with real signed orders before it is switched on. See lib/tpsl.ts for what is proven.
 */
export const TPSL_BUILD = NETWORK === 'testnet' && process.env.NEXT_PUBLIC_TPSL === '1';
