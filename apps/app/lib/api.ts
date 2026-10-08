'use client';

import { useSyncExternalStore } from 'react';

/**
 * Calls to the Bulwark API go through this app's own server route (/api/bw/*), which adds the edge
 * location headers and the proxy secret. The session token is a short-lived JWT kept in sessionStorage.
 */
const KEY = 'bw.session';
const ADDR = 'bw.session.address';
const listeners = new Set<() => void>();

export function sessionToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** The wallet address the session was signed in with (lower case). */
export function sessionAddress(): string | null {
  try {
    return sessionStorage.getItem(ADDR);
  } catch {
    return null;
  }
}

export function setSessionToken(t: string | null, address?: string) {
  try {
    if (t) {
      sessionStorage.setItem(KEY, t);
      if (address) sessionStorage.setItem(ADDR, address.toLowerCase());
    } else {
      sessionStorage.removeItem(KEY);
      sessionStorage.removeItem(ADDR);
    }
  } catch {
    /* storage unavailable: the user signs in again */
  }
  for (const fn of listeners) fn();
}

const onSession = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

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
  // A read the API refuses with 401 means the session itself is no longer accepted (expired, or from before
  // sessions named the network): drop it, so every screen asks to sign in again instead of showing an
  // error. A 401 on a write can be about that write's signature, so the session stays.
  if (res.status === 401 && token && (init.method ?? (init.body ? 'POST' : 'GET')) === 'GET') setSessionToken(null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

const noop = () => () => {};
/** Signed-in state that is false during server render and hydration, so markup matches. */
export function useSignedIn(): boolean {
  return useSyncExternalStore(onSession, () => Boolean(sessionToken()), () => false);
}

/** True after hydration. */
export function useMounted(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}
