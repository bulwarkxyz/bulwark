'use client';

import { useQuery } from '@tanstack/react-query';
import { api, ApiError, useSignedIn } from './api';
import { useReview } from './review';

/** GET /v1/region (apps/api/CONTRACT.md): may this user trade from here, now. */
export interface RegionAnswer {
  verdict: 'allowed' | 'alerts_only' | 'blocked';
  trading: boolean;
  guard: boolean;
  country: string | null;
}

/** What the ticket knows about the region: an answer, no session to ask with, or no answer. */
export type TicketRegion = { kind: 'answer'; answer: RegionAnswer } | { kind: 'signin' } | { kind: 'checking' } | { kind: 'unknown' };

/** "SG" → "Singapore"; unknown or missing codes → "where you are". */
export function placeName(country: string | null): string {
  if (!country) return 'where you are';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(country.toUpperCase()) ?? country;
  } catch {
    return country;
  }
}

/**
 * Why the ticket can't send this order, or null. Pure. Closing a position (reduce-only) is never held: it
 * only lowers risk, wherever the user is. New orders need an answer that allows trading; when there is no
 * answer, they wait for one rather than go out unchecked.
 */
export function regionHold(r: TicketRegion, reduceOnly: boolean): string | null {
  if (reduceOnly) return null;
  switch (r.kind) {
    case 'signin':
      return 'Sign in (top right) to trade: Bulwark checks your region before each new order. Closing a position works without it.';
    case 'checking':
      return 'Checking your region…';
    case 'unknown':
      return 'Can’t check your region with Bulwark right now, so new orders wait. Closing a position still works. Try again in a moment.';
    case 'answer':
      return r.answer.trading ? null : `New orders aren’t available from ${placeName(r.answer.country)}. You can still close your positions.`;
  }
}

/** A note to show beside an order that can go: the guard only alerts in this region. */
export function regionNote(r: TicketRegion): string | null {
  return r.kind === 'answer' && r.answer.trading && !r.answer.guard ? `From ${placeName(r.answer.country)}, the guard sends alerts but does not trade for you.` : null;
}

const REVIEW: Record<string, RegionAnswer> = {
  allowed: { verdict: 'allowed', trading: true, guard: true, country: 'SG' },
  alerts_only: { verdict: 'alerts_only', trading: true, guard: false, country: 'DE' },
  blocked: { verdict: 'blocked', trading: false, guard: false, country: 'US' },
};

/** Ask Bulwark now (before each order). Throws when it can't answer. */
export async function fetchRegion(review: { on: boolean; region?: string }): Promise<RegionAnswer> {
  if (review.on) {
    if (review.region === 'unknown') throw new Error('review: region unknown');
    return REVIEW[review.region ?? 'allowed']!;
  }
  return api<RegionAnswer>('/v1/region');
}

/** The region for the ticket, asked when it opens (and again whenever it mounts). */
export function useTicketRegion(enabled: boolean): { region: TicketRegion; refresh: () => Promise<TicketRegion> } {
  const review = useReview();
  const signedIn = useSignedIn() || review.on;
  const q = useQuery({
    queryKey: ['region', signedIn, review.on ? (review.region ?? 'allowed') : 'live'],
    queryFn: () => fetchRegion(review),
    enabled: enabled && signedIn,
    staleTime: 0,
    refetchOnMount: 'always',
    retry: (n, e) => n < 1 && !(e instanceof ApiError && e.status < 500),
  });
  const region: TicketRegion = !signedIn ? { kind: 'signin' } : q.data ? { kind: 'answer', answer: q.data } : q.isError ? { kind: 'unknown' } : { kind: 'checking' };
  const refresh = async (): Promise<TicketRegion> => {
    if (!signedIn) return { kind: 'signin' };
    const r = await q.refetch();
    return r.data ? { kind: 'answer', answer: r.data } : { kind: 'unknown' };
  };
  return { region, refresh };
}
