import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, sessionToken, setSessionToken } from '../lib/api';
import { placeName, regionHold, regionNote, type TicketRegion } from '../lib/region';
import { explainWalletError, retryIn } from '../lib/wallet-errors';

const answer = (verdict: 'allowed' | 'alerts_only' | 'blocked', country: string | null = 'SG'): TicketRegion => ({ kind: 'answer', answer: { verdict, trading: verdict !== 'blocked', guard: verdict === 'allowed', country } });

describe('region at the ticket', () => {
  it('lets an allowed order go, with no note', () => {
    expect(regionHold(answer('allowed'), false)).toBeNull();
    expect(regionNote(answer('allowed'))).toBeNull();
  });
  it('holds a new order where trading is blocked, naming the place, and says closing still works', () => {
    const hold = regionHold(answer('blocked', 'US'), false)!;
    expect(hold).toMatch(/aren’t available from United States/);
    expect(hold).toMatch(/still close/);
  });
  it('never holds a reduce-only order, whatever the answer', () => {
    for (const r of [answer('blocked'), { kind: 'signin' }, { kind: 'unknown' }, { kind: 'checking' }] as TicketRegion[]) expect(regionHold(r, true)).toBeNull();
  });
  it('holds new orders without a session or without an answer, rather than sending them unchecked', () => {
    expect(regionHold({ kind: 'signin' }, false)).toMatch(/Sign in/);
    expect(regionHold({ kind: 'unknown' }, false)).toMatch(/Can’t check your region/);
    expect(regionHold({ kind: 'checking' }, false)).toMatch(/Checking/);
  });
  it('notes that the guard only alerts where trading is allowed but the guard is not', () => {
    expect(regionHold(answer('alerts_only', 'DE'), false)).toBeNull();
    expect(regionNote(answer('alerts_only', 'DE'))).toMatch(/From Germany, the guard sends alerts but does not trade/);
  });
  it('names an unknown country plainly', () => {
    expect(placeName(null)).toBe('where you are');
  });
});

describe('rate limits (429)', () => {
  it('shows the API’s own words and when to try again', () => {
    const e = new ApiError(429, { error: 'You have created 3 guard keys in 24 hours, the most allowed.', limit: 'keys_account', retryAfter: 7200 });
    const x = explainWalletError(e);
    expect(x.text).toBe('You have created 3 guard keys in 24 hours, the most allowed.');
    expect(x.next).toMatch(/Nothing was changed\. You can try again in about 2 hours\./);
  });
  it('says when in seconds, minutes or hours', () => {
    expect(retryIn(40)).toBe('in about 40 seconds');
    expect(retryIn(60)).toBe('in about 1 minute');
    expect(retryIn(1800)).toBe('in about 30 minutes');
    expect(retryIn(86_400)).toBe('in about 24 hours');
  });
  it('still reads well without retryAfter', () => {
    expect(explainWalletError(new ApiError(429, {})).next).toMatch(/Wait a minute/);
  });
});

describe('a session the API no longer accepts', () => {
  const store = new Map<string, string>();
  beforeEach(() => vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }));
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('is dropped when a read answers 401, so screens ask to sign in again', async () => {
    setSessionToken('old', '0xabc');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'session expired' }), { status: 401 }));
    await expect(api('/v1/me')).rejects.toBeInstanceOf(ApiError);
    expect(sessionToken()).toBeNull();
  });
  it('is kept when a write answers 401, which can be about that write’s signature', async () => {
    setSessionToken('current', '0xabc');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'bad signature' }), { status: 401 }));
    await expect(api('/v1/policy', { body: {} })).rejects.toBeInstanceOf(ApiError);
    expect(sessionToken()).toBe('current');
  });
});
