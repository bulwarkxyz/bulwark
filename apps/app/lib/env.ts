import { builderEnabled } from '@bulwarkxyz/config';
import type { Network } from '@bulwarkxyz/hyperliquid';

export const NETWORK: Network = process.env.NEXT_PUBLIC_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
/** Builder code on/off for this network, from the same switch the worker uses (decision D6). */
export const BUILDER_ON = builderEnabled(NETWORK, {
  BUILDER_CODE_ENABLED_MAINNET: process.env.NEXT_PUBLIC_BUILDER_CODE_ENABLED_MAINNET,
  BUILDER_CODE_ENABLED_TESTNET: process.env.NEXT_PUBLIC_BUILDER_CODE_ENABLED_TESTNET,
});
