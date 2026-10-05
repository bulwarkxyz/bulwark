'use client';

import { useSyncExternalStore } from 'react';

/**
 * Calls to the Bulwark API go through this app's own server route (/api/bw/*), which adds the edge
 * location headers and the proxy secret. The session token is a short-lived JWT kept in sessionStorage.
 */
const KEY = 'bw.session';

export function sessionToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(t: string | null) {
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the user signs in again */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === 'string' ? body.error : typeof body.reason === 'string' ? body.reason : `HTTP ${status}`);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = sessionToken();
  const res = await fetch(`/api/bw${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

const noop = () => () => {};
/** Signed-in state that is false during server render and hydration, so markup matches. */
export function useSignedIn(): boolean {
  return useSyncExternalStore(noop, () => Boolean(sessionToken()), () => false);
}

/** True after hydration. */
export function useMounted(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}
