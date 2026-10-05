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
