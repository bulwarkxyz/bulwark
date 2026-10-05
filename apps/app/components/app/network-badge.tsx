'use client';

import { NETWORK } from '@/lib/env';

/** Persistent network label. On testnet nothing uses real funds, and the label says so on every screen. */
export function NetworkBadge() {
  if (NETWORK !== 'testnet') return null;
  return (
    <span className="chip chip-warn" role="status" title="This is Hyperliquid testnet. Balances and orders here are not real money.">
      <i />
      Testnet · not real funds
    </span>
  );
}
