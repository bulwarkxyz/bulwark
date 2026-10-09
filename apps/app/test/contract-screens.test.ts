import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, sessionToken, setSessionToken } from '../lib/api';
import { placeName, regionFailure, regionHold, regionNote, type TicketRegion } from '../lib/region';
import { explainWalletError, retryIn } from '../lib/wallet-errors';

const answer = (verdict: 'allowed' | 'alerts_only' | 'blocked', country: string | null = 'SG'): TicketRegion => ({ kind: 'answer', answer: { verdict, trading: verdict !== 'blocked', guard: verdict === 'allowed', country } });

describe('region at the ticket', () => {
  it('lets an allowed order go, with no note', () => {
    expect(regionHold(answer('allowed'), false)).toBeNull();
    expect(regionNote(answer('allowed'))).toBeNull();
  });
  it('names the connection’s country when that is what blocks', () => {
    const hold = regionHold(answer('blocked', 'US'), false)!;
    expect(hold).toMatch(/Your connection comes from United States, where Bulwark doesn’t offer trading/);
    expect(hold).toMatch(/Closing a position works/);
  });
  it('blames the declaration, not the place, when the connection’s country is allowed', () => {
    const hold = regionHold(answer('blocked', 'SG'), false)!;
    expect(hold).toMatch(/residence or citizenship you declared/);
    expect(hold).not.toMatch(/Singapore/);
  });
  it('says when the connection’s country is unknown, and what to try', () => {
    expect(regionHold(answer('blocked', null), false)).toMatch(/can’t tell which country.*VPN or proxy/);
  });
  it('names a sanctioned part of Ukraine without blaming the whole country', () => {
    expect(regionHold(answer('blocked', 'UA'), false)).toMatch(/a part of Ukraine/);
  });
  it('never holds a reduce-only order, whatever the answer', () => {
    const all: TicketRegion[] = [answer('blocked'), { kind: 'signin' }, { kind: 'unknown', why: 'unreachable' }, { kind: 'unknown', why: 'limited', retryAfter: 40 }, { kind: 'unknown', why: 'refused', text: 'x' }, { kind: 'checking' }];
    for (const r of all) expect(regionHold(r, true)).toBeNull();
  });
  it('holds new orders without a session or an answer, saying why and what to do', () => {
    expect(regionHold({ kind: 'signin' }, false)).toMatch(/Sign in \(top right\), then place the order/);
    expect(regionHold({ kind: 'unknown', why: 'unreachable' }, false)).toMatch(/didn’t answer.*nothing was sent.*Check again in a minute/);
    expect(regionHold({ kind: 'unknown', why: 'limited', retryAfter: 40 }, false)).toMatch(/limiting region checks.*Check again in about 40 seconds/);
    expect(regionHold({ kind: 'unknown', why: 'refused', text: 'Finish setup first.' }, false)).toMatch(/refused the region check \(“Finish setup first\.”\)/);
    expect(regionHold({ kind: 'checking' }, false)).toMatch(/Checking/);
  });
  it('sorts failed checks by what the user can do', () => {
    expect(regionFailure(new ApiError(429, { retryAfter: 12 }))).toEqual({ why: 'limited', retryAfter: 12 });
    expect(regionFailure(new ApiError(502, { code: 'api_unreachable' }))).toEqual({ why: 'unreachable' });
    expect(regionFailure(new TypeError('Failed to fetch'))).toEqual({ why: 'unreachable' });
    expect(regionFailure(new ApiError(409, { error: 'Finish setup first.' }))).toEqual({ why: 'refused', text: 'Finish setup first.' });
  });
  it('notes why the guard only alerts: the place, or the declaration', () => {
    expect(regionHold(answer('alerts_only', 'DE'), false)).toBeNull();
    expect(regionNote(answer('alerts_only', 'DE'))).toMatch(/From Germany, the guard sends alerts but does not trade for you \(EU and EEA rules\)/);
    expect(regionNote(answer('alerts_only', 'SG'))).toMatch(/Because of the residence or citizenship you declared/);
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
