'use client';

import type { Policy } from '@bulwarkxyz/guard-core';
import type { Hex } from '@bulwarkxyz/hyperliquid';
import { useQuery } from '@tanstack/react-query';
import { api, sessionToken, useSignedIn } from './api';
import { examplePolicy, useReview } from './review';

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
  /** Where this user's guard key lives: 'kms' = AWS KMS; 'sealed' = encrypted on Bulwark's server. */
  keyCustody: 'sealed' | 'kms';
  /** Where a new or replacement key would be created (the signing service's current mode). */
  newKeyCustody: 'sealed' | 'kms';
  keyStatus: 'none' | 'creating' | 'ready' | 'wiped';
  pendingAgent: null | { address: Hex };
  /** The AI translator's model provider, named next to the translator (absent on older API builds). */
  translator?: { enabled: boolean; provider: string | null };
  /**
   * `needsRepeatChoice`: rule ids still without the once / every-time choice (empty when none).
   * `needsResign`: the whole policy must be signed again (signed before signatures named the network, or for
   * the other network); the guard is paused with reason resign_required until it is.
   */
  policy: null | { version: number; hash: string; confirmedAt: number; policy: Policy; needsRepeatChoice?: string[]; needsResign?: boolean };
  /** The strictest of the user's declarations and where their connection came from last (absent on older API builds). */
  regionNow?: 'allowed' | 'alerts_only' | 'blocked' | null;
}

/** The signed-in user's Bulwark record (null when signed out). */
export function useMe() {
  const review = useReview();
  // Keyed on the session too, so signing out (or a session the API drops) reads again instead of keeping an error.
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: ['me', review.on ? `${review.watch ?? ''}|${review.exampleRules}|${review.state}|${review.guard ?? ''}|${review.key ?? ''}|${review.resign}` : `live|${signedIn}`],
    queryFn: async (): Promise<Me | null> => {
      if (review.on && review.state !== 'empty' && review.watch) return reviewMe(review.watch, review.exampleRules, review.guard === 'stopped', review.key ?? 'kms', review.resign);
      return sessionToken() ? api<Me>('/v1/me') : null;
    },
    refetchInterval: 30_000,
  });
}

/** Review builds only: a watched account as if it had finished onboarding (see lib/review.tsx). */
function reviewMe(account: Hex, exampleRules: boolean, stopped: boolean, key: 'sealed' | 'kms' | 'wiped', resign: boolean): Me {
  const wiped = key === 'wiped';
  return {
    account,
    user: { account, agentKeyRef: 'review', agentAddress: null, region: 'allowed', telegramChatId: null, killSwitch: stopped || wiped, builderApproved: false },
    agent: wiped ? null : { address: account, approved: true, validUntil: null },
    builder: { address: account, feeTenthsBps: 30, approvedMaxTenthsBps: 0 },
    keyCustody: key === 'sealed' ? 'sealed' : 'kms',
    newKeyCustody: 'kms',
    keyStatus: wiped ? 'wiped' : 'ready',
    pendingAgent: null,
    policy: exampleRules ? { version: 3, hash: 'example', confirmedAt: Date.UTC(2026, 9, 4, 14, 2), policy: examplePolicy(account), needsRepeatChoice: examplePolicy(account).rules.filter((r) => !r.repeat).map((r) => r.id), needsResign: resign } : null,
  };
}
