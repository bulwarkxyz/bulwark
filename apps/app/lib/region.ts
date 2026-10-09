'use client';

import { regionVerdict } from '@bulwarkxyz/config';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, useSignedIn } from './api';
import { useReview } from './review';
import { retryIn } from './wallet-errors';

/** GET /v1/region (apps/api/CONTRACT.md): may this user trade from here, now. */
export interface RegionAnswer {
  verdict: 'allowed' | 'alerts_only' | 'blocked';
  trading: boolean;
  guard: boolean;
  country: string | null;
}

/** Why the region couldn't be checked: Bulwark rate-limited the check, didn't answer, or refused it. */
export type RegionFailure = { why: 'limited'; retryAfter: number | null } | { why: 'unreachable' } | { why: 'refused'; text: string };

/** What the ticket knows about the region: an answer, no session to ask with, a failed check, or a check in flight. */
export type TicketRegion = { kind: 'answer'; answer: RegionAnswer } | { kind: 'signin' } | { kind: 'checking' } | ({ kind: 'unknown' } & RegionFailure);

/** "SG" → "Singapore"; unknown or missing codes → "where you are". */
export function placeName(country: string | null): string {
  if (!country) return 'where you are';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(country.toUpperCase()) ?? country;
  } catch {
    return country;
  }
}

/** A failed GET /v1/region, sorted by what the user can do about it. */
export function regionFailure(e: unknown): RegionFailure {
  if (e instanceof ApiError) {
    if (e.status === 429) return { why: 'limited', retryAfter: typeof e.body.retryAfter === 'number' ? e.body.retryAfter : null };
    if (e.status >= 500) return { why: 'unreachable' };
    return { why: 'refused', text: e.message };
  }
  return { why: 'unreachable' };
}

const CLOSE = 'Closing a position works whatever this says.';

/**
 * Why the ticket can't send this order, and what to do, or null. Pure. Closing a position (reduce-only) is
 * never held: it only lowers risk, wherever the user is. New orders need an answer that allows trading;
 * without one they wait rather than go out unchecked.
 * The API's verdict is the strictest of where the connection comes from now and what the user declared in
 * setup (residence, citizenship); the answer names only the connection's country, so the reason is worked
 * out from the same lists the API uses (@bulwarkxyz/config).
 */
export function regionHold(r: TicketRegion, reduceOnly: boolean): string | null {
  if (reduceOnly) return null;
  switch (r.kind) {
    case 'signin':
      return `New orders need a region check, and Bulwark only checks for a signed-in wallet. Sign in (top right), then place the order. ${CLOSE}`;
    case 'checking':
      return 'Checking your region with Bulwark…';
    case 'unknown':
      if (r.why === 'limited') return `Bulwark is limiting region checks from your connection, so new orders wait. Check again ${r.retryAfter ? retryIn(r.retryAfter) : 'in a minute'}. ${CLOSE}`;
      if (r.why === 'unreachable') return `Bulwark’s server didn’t answer the region check, so new orders wait; nothing was sent. Check again in a minute. ${CLOSE}`;
      return `Bulwark refused the region check (“${r.text}”), so new orders wait. ${CLOSE}`;
    case 'answer': {
      const a = r.answer;
      if (a.trading) return null;
      if (!a.country) return `Bulwark can’t tell which country your connection comes from, and new orders need that. If you use a VPN or proxy, turn it off and check again. ${CLOSE}`;
      if (regionVerdict(a.country) === 'blocked') return `Your connection comes from ${placeName(a.country)}, where Bulwark doesn’t offer trading (its exchanges’ terms and sanctions rules), so new orders are off. ${CLOSE}`;
      if (a.country.toUpperCase() === 'UA') return `Your connection comes from a part of Ukraine where Bulwark doesn’t offer trading (sanctions rules), so new orders are off. ${CLOSE}`;
      return `The residence or citizenship you declared in setup is one where Bulwark doesn’t offer trading, so new orders are off, wherever you connect from. ${CLOSE}`;
    }
  }
}

/** A note beside an order that can go: the guard only alerts here, and why. */
export function regionNote(r: TicketRegion): string | null {
  if (r.kind !== 'answer' || !r.answer.trading || r.answer.guard) return null;
  const c = r.answer.country;
  return c && regionVerdict(c) === 'guardOff'
    ? `From ${placeName(c)}, the guard sends alerts but does not trade for you (EU and EEA rules). Your orders are fine.`
    : 'Because of the residence or citizenship you declared, the guard sends alerts but does not trade for you. Your orders are fine.';
}

const REVIEW: Record<string, RegionAnswer> = {
  allowed: { verdict: 'allowed', trading: true, guard: true, country: 'SG' },
  alerts_only: { verdict: 'alerts_only', trading: true, guard: false, country: 'DE' },
  blocked: { verdict: 'blocked', trading: false, guard: false, country: 'US' },
};

/** Ask Bulwark now (before each order). Throws when it can't answer. */
export async function fetchRegion(review: { on: boolean; region?: string }): Promise<RegionAnswer> {
  if (review.on) {
    if (review.region === 'unknown') throw new ApiError(502, { error: 'review: no answer', code: 'api_unreachable' });
    if (review.region === 'limited') throw new ApiError(429, { error: 'review: limited', retryAfter: 40 });
    if (review.region === 'declared') return { verdict: 'blocked', trading: false, guard: false, country: 'SG' };
    if (review.region === 'nowhere') return { verdict: 'blocked', trading: false, guard: false, country: null };
    return REVIEW[review.region ?? 'allowed']!;
  }
  return api<RegionAnswer>('/v1/region');
}

/** The region for the ticket, asked when it opens (and again whenever it mounts). */
export function useTicketRegion(enabled: boolean): { region: TicketRegion; refresh: () => Promise<TicketRegion>; checking: boolean } {
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
  const region: TicketRegion = !signedIn ? { kind: 'signin' } : q.isFetching && !q.data ? { kind: 'checking' } : q.data && !q.isError ? { kind: 'answer', answer: q.data } : q.isError ? { kind: 'unknown', ...regionFailure(q.error) } : { kind: 'checking' };
  const refresh = async (): Promise<TicketRegion> => {
    if (!signedIn) return { kind: 'signin' };
    const r = await q.refetch();
    return r.data && !r.isError ? { kind: 'answer', answer: r.data } : { kind: 'unknown', ...regionFailure(r.error) };
  };
  return { region, refresh, checking: q.isFetching };
}
