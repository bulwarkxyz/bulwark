'use client';

import type { Policy } from '@bulwarkxyz/guard-core';
import type { Hex } from '@bulwarkxyz/hyperliquid';
import { useQuery } from '@tanstack/react-query';
import { api, sessionToken } from './api';

export interface Me {
  account: Hex;
  user: null | {
    account: Hex;
    agentKeyRef: string;
    agentAddress?: Hex | null;
    region: 'allowed' | 'guardOff';
    telegramChatId: string | null;
    killSwitch: boolean;
    builderApproved: boolean;
  };
  agent: null | { address: Hex; approved: boolean; validUntil: number | null };
  builder: { address: Hex; feeTenthsBps: number; approvedMaxTenthsBps: number };
  policy: null | { version: number; hash: string; confirmedAt: number; policy: Policy };
}

/** The signed-in user's Bulwark record (null when signed out). */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => (sessionToken() ? api<Me>('/v1/me') : null),
    refetchInterval: 30_000,
  });
}
