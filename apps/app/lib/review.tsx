'use client';

import type { Policy } from '@bulwarkxyz/guard-core';
import type { Hex } from '@bulwarkxyz/hyperliquid';
import { createContext, useContext, useEffect, useState } from 'react';
import { useAccount } from 'wagmi';

/**
 * Review mode exists only to take the design-review screenshots. It works only in a development build
 * with NEXT_PUBLIC_REVIEW_MODE=1 (production builds compile it out), driven by URL parameters:
 *   ?watch=0x…   show a public account read-only, as if connected
 *   ?rules=example   give that account example rules, labelled "Example rules" on screen
 *   ?state=empty|loading|error|closed   force a screen state
 * Nothing here can sign, send or store anything.
 */
export const REVIEW_BUILD = process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_REVIEW_MODE === '1';

export type ForcedState = 'empty' | 'loading' | 'error' | 'closed' | null;
interface Review {
  on: boolean;
  watch?: Hex;
  exampleRules: boolean;
  state: ForcedState;
}
const OFF: Review = { on: false, exampleRules: false, state: null };
const Ctx = createContext<Review>(OFF);

export function ReviewProvider({ children }: { children: React.ReactNode }) {
  const [r, setR] = useState<Review>(OFF);
  useEffect(() => {
    if (!REVIEW_BUILD) return;
    const q = new URLSearchParams(window.location.search);
    const watch = q.get('watch');
    const state = q.get('state');
    setR({
      on: true,
      ...(watch && /^0x[0-9a-fA-F]{40}$/.test(watch) ? { watch: watch.toLowerCase() as Hex } : {}),
      exampleRules: q.get('rules') === 'example',
      state: state === 'empty' || state === 'loading' || state === 'error' || state === 'closed' ? state : null,
    });
  }, []);
  return <Ctx.Provider value={r}>{children}</Ctx.Provider>;
}

export const useReview = () => useContext(Ctx);

/** The address the screens show: the connected wallet, or (review builds only) a watched account. */
export function useViewer(): { address: Hex | undefined; connected: boolean } {
  const { address } = useAccount();
  const r = useReview();
  if (r.state === 'empty') return { address: undefined, connected: false };
  if (r.on && r.watch) return { address: r.watch, connected: true };
  return { address: address as Hex | undefined, connected: Boolean(address) };
}

/** Example rules for review screenshots only. Every screen that shows them also shows "Example rules". */
export function examplePolicy(account: Hex): Policy {
  return {
    version: 3,
    account,
    rules: [
      { id: 'stage-1', when: { kind: 'buffer', below: 3 }, then: [{ kind: 'alert' }], source: { text: 'Alert me if my buffer drops below 3', compiler: 'example' } },
      { id: 'stage-2', when: { kind: 'buffer', below: 2.5 }, then: [{ kind: 'reduce', target: { kind: 'first_position' }, fraction: 0.25 }], source: { text: 'Below 2.5, cut my biggest position by a quarter', compiler: 'example' } },
      { id: 'stage-3', when: { kind: 'buffer', below: 1.8 }, then: [{ kind: 'close', target: { kind: 'all' } }] },
    ],
    execution: { maxSlippagePct: 0.5 },
  };
}

/** A fixed Saturday, so the "home market closed" state can be shown on any day. */
export const REVIEW_WEEKEND = Date.UTC(2026, 9, 10, 12, 0);
