'use client';

import type { Policy } from '@bulwarkxyz/guard-core';
import type { Hex } from '@bulwarkxyz/hyperliquid';
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { useAccount } from 'wagmi';

/**
 * Review mode exists only for design review. It is compiled in only when the build sets
 * NEXT_PUBLIC_REVIEW_MODE=1 outside Vercel production (see next.config.mjs), driven by URL parameters:
 *   ?watch=0x…   show a public account read-only, as if connected
 *   ?rules=example   give that account example rules, labelled "Example rules" on screen
 *   ?state=empty|loading|error|closed   force a screen state
 *   ?guard=paused:signer_error   stand in for the guard status endpoint
 *   ?key=sealed|wiped            an older encrypted key, or a key already wiped (default: a KMS key)
 *   ?resign=1                    the example rules need signing again (signed before signatures named the network)
 *   ?region=blocked|declared|nowhere|alerts_only|unknown|limited   stand in for the region check at the trade ticket
 * Nothing here can sign, send or store anything.
 */
export const REVIEW_BUILD = process.env.NEXT_PUBLIC_REVIEW_MODE === '1';
/** Present in the bundle only when review mode is compiled in; scripts/review-mode-check.mjs looks for it. */
export const REVIEW_MARKER = REVIEW_BUILD ? 'bulwark-review-mode-compiled-in' : '';

export type ForcedState = 'empty' | 'loading' | 'error' | 'closed' | null;
interface Review {
  on: boolean;
  watch?: Hex;
  exampleRules: boolean;
  state: ForcedState;
  /** ?guard=paused:signer_error: stand in for the guard status endpoint. */
  guard?: string;
  /** ?key=sealed|kms: where the example guard key lives (default kms, the active custody). */
  key?: 'sealed' | 'kms' | 'wiped';
  /** ?resign=1: the example rules were signed before signatures named the network. */
  resign: boolean;
  /** ?region=allowed|alerts_only|blocked|unknown: stand in for GET /v1/region at the ticket. */
  region?: 'allowed' | 'alerts_only' | 'blocked' | 'unknown' | 'limited' | 'declared' | 'nowhere';
}
const OFF: Review = { on: false, exampleRules: false, state: null, resign: false };
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
      resign: q.get('resign') === '1',
      ...(['allowed', 'alerts_only', 'blocked', 'unknown', 'limited', 'declared', 'nowhere'].includes(q.get('region') ?? '') ? { region: q.get('region') as Review['region'] } : {}),
      ...(['sealed', 'kms', 'wiped'].includes(q.get('key') ?? '') ? { key: q.get('key') as 'sealed' | 'kms' | 'wiped' } : {}),
      ...(q.get('guard') && /^(protected|acting|at_risk|paused|stopped|no_rules|alerts_only)(:(stale_data|exchange_unreachable|signer_error|agent_expired|resign_required|operator_stop))?$/.test(q.get('guard')!) ? { guard: q.get('guard')! } : {}),
      state: state === 'empty' || state === 'loading' || state === 'error' || state === 'closed' ? state : null,
    });
  }, []);
  return (
    <Ctx.Provider value={r}>
      {REVIEW_BUILD ? <span hidden data-review={REVIEW_MARKER} /> : null}
      {children}
    </Ctx.Provider>
  );
}

export const useReview = () => useContext(Ctx);

/** The address the screens show: the connected wallet, or (review builds only) a watched account. */
export function useViewer(): { address: Hex | undefined; connected: boolean; pending: boolean } {
  const { address, status } = useAccount();
  const r = useReview();
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  if (r.state === 'empty') return { address: undefined, connected: false, pending: false };
  if (r.on && r.watch) return { address: r.watch, connected: true, pending: false };
  // Not known yet: the server's page and the first paint can't see the wallet, and a wallet connected here
  // before reconnects after load (wagmi starts that a moment after hydration). Screens show a placeholder
  // until it settles, not "No wallet connected".
  if (status !== 'disconnected') reconnectStarted = true;
  const pending = !address && (!hydrated || (REVIEW_BUILD && !r.on) || (hadWallet() && (!reconnectStarted || status === 'reconnecting' || status === 'connecting')));
  return { address: address as Hex | undefined, connected: Boolean(address), pending };
}

const noop = () => () => {};
/** wagmi has begun its reconnect on load (once per page load; it always runs). */
let reconnectStarted = false;
/** A wallet was connected in this browser before, so wagmi's reconnect on load is a real one. */
export function hadWallet(): boolean {
  try {
    return Boolean(localStorage.getItem('wagmi.recentConnectorId'));
  } catch {
    return false;
  }
}

/** Example rules for review screenshots only. Every screen that shows them also shows "Example rules". */
export function examplePolicy(account: Hex): Policy {
  return {
    version: 3,
    account,
    rules: [
      { id: 'stage-1', when: { kind: 'buffer', below: 3 }, then: [{ kind: 'alert' }], repeat: { mode: 'everyCrossing' }, source: { text: 'Alert me every time my buffer drops below 3', compiler: 'example' } },
      { id: 'stage-2', when: { kind: 'buffer', below: 2.5 }, then: [{ kind: 'reduce', target: { kind: 'first_position' }, fraction: 0.25 }], repeat: { mode: 'oncePerBreach', limit: { times: 3, perHours: 24 } }, source: { text: 'Below 2.5, cut my biggest position by a quarter, only once per fall, at most 3 times in 24 hours', compiler: 'example' } },
      // Signed before the choice existed: shows the "needs your choice" state.
      { id: 'stage-3', when: { kind: 'buffer', below: 1.8 }, then: [{ kind: 'close', target: { kind: 'all' } }] },
    ],
    execution: { maxSlippagePct: 0.5 },
  };
}

/** A fixed Saturday, so the "home market closed" state can be shown on any day. */
export const REVIEW_WEEKEND = Date.UTC(2026, 9, 10, 12, 0);
