import type { Network } from './builder.js';

/**
 * The network a service runs on, read strictly (mainnet prerequisites, 8 Oct 2026): a missing or misspelt NETWORK stops
 * the service instead of quietly meaning testnet.
 */
export function parseNetwork(value: string | undefined): Network {
  if (value === 'testnet' || value === 'mainnet') return value;
  throw new Error(`NETWORK must be exactly "testnet" or "mainnet" (got ${value === undefined ? 'nothing' : JSON.stringify(value)})`);
}
