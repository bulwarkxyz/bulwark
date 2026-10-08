import type { RawClearinghouseState } from '@bulwarkxyz/guard-core';
import { describe, expect, it } from 'vitest';
import {
  BUILDER_STREAMS,
  BuilderStream,
  HYDRO_MAX_LAG_MS,
  HYDRO_STALE_MS,
  HydromancerFeed,
  NativeFallbackPoller,
  StateArbiter,
  WeightBudget,
  hydroWeight,
} from '../src/statefeed.js';
import type { SocketLike } from '../src/stream.js';

const U = '0x9959260f1aa229f8a70e0c495ca9b251106c1a86';
const st = (accountValue: string, time = 0): RawClearinghouseState => ({
  marginSummary: { accountValue, totalNtlPos: '0', totalRawUsd: accountValue, totalMarginUsed: '0' },
  crossMarginSummary: { accountValue, totalNtlPos: '0', totalRawUsd: accountValue, totalMarginUsed: '0' },
  crossMaintenanceMarginUsed: '0',
  withdrawable: '0',
  assetPositions: [],
  time,
});

function arbiter(t: { now: number }) {
  const out: Array<{ user: string; states: Array<[string, RawClearinghouseState]>; at: number }> = [];
  const a = new StateArbiter((user, states, at) => out.push({ user, states, at }), () => t.now);
  return { a, out, last: () => out.at(-1)! };
}
const value = (states: Array<[string, RawClearinghouseState]>, dex: string) => states.find(([d]) => d === dex)?.[1].marginSummary.accountValue;

describe('state arbiter', () => {
  it('uses Hydromancer while it is fresh, and the native state for dexes Hydromancer is not polled for', () => {
    const t = { now: 1_000_000 };
    const { a, last } = arbiter(t);
    a.native(U, [['', st('1')], ['xyz', st('2')], ['flx', st('3')]], t.now);
    a.hydromancer(U, '', st('10'), t.now);
    a.hydromancer(U, 'xyz', st('20'), t.now);
    expect(value(last().states, '')).toBe('10');
    expect(value(last().states, 'xyz')).toBe('20');
    expect(value(last().states, 'flx')).toBe('3');
    expect(a.sources(U)).toEqual({ '': 'hydromancer', xyz: 'hydromancer', flx: 'native' });
  });

  it('falls back to the native feed by itself when Hydromancer goes stale, and returns when it is fresh again', () => {
    const t = { now: 1_000_000 };
    const { a, last } = arbiter(t);
    a.hydromancer(U, 'xyz', st('20'), t.now);
    a.native(U, [['xyz', st('2')]], t.now);
    expect(value(last().states, 'xyz')).toBe('20');
    t.now += HYDRO_STALE_MS + 1;
    a.native(U, [['xyz', st('2.5')]], t.now);
    expect(value(last().states, 'xyz')).toBe('2.5');
    expect(last().at).toBe(t.now);
    expect(a.sources(U)).toEqual({ xyz: 'native' });
    t.now += 1000;
    a.hydromancer(U, 'xyz', st('21'), t.now);
    expect(value(last().states, 'xyz')).toBe('21');
  });

  it('a stale Hydromancer state hands over on republish even with no new native message', () => {
    const t = { now: 1_000_000 };
    const { a, out, last } = arbiter(t);
    a.native(U, [['xyz', st('2')]], t.now);
    a.hydromancer(U, 'xyz', st('20'), t.now);
    const n = out.length;
    a.republish();
    expect(out.length).toBe(n); // nothing changed: no re-emit
    t.now += HYDRO_STALE_MS + 1;
    a.republish();
    expect(value(last().states, 'xyz')).toBe('2');
  });

  it('reports the account as fresh only as its oldest chosen dex', () => {
    const t = { now: 1_000_000 };
    const { a, last } = arbiter(t);
    a.native(U, [['', st('1')]], t.now - 8000);
    a.hydromancer(U, 'xyz', st('20'), t.now);
    expect(last().at).toBe(t.now - 8000);
  });
});

function fakeFetch(reply: (body: { users: string[]; dex: string }) => { status?: number; json?: unknown }) {
  const calls: Array<{ users: string[]; dex: string; auth: string }> = [];
  const f = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { users: string[]; dex: string };
    calls.push({ ...body, auth: (init.headers as Record<string, string>).authorization ?? '' });
    const r = reply(body);
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, json: async () => r.json } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('Hydromancer feed', () => {
  it('polls dex "" and "xyz" in batches of up to 1000 users, and passes on fresh states', async () => {
    const now = 5_000_000;
    const { f, calls } = fakeFetch(({ users, dex }) => ({ json: { successful_states: users.map((u) => [u, st(dex || 'main', now - 300)]), failed_wallets: [] } }));
    const got: string[] = [];
    const feed = new HydromancerFeed({ url: 'https://h', apiKey: 'k', dexes: ['', 'xyz'], pointsPerMinute: 10_000, onState: (u, dex) => got.push(`${u}|${dex}`), fetch: f, now: () => now });
    feed.setUsers(Array.from({ length: 1500 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`));
    await feed.poll();
    expect(calls.map((c) => [c.dex, c.users.length])).toEqual([['', 1000], ['', 500], ['xyz', 1000], ['xyz', 500]]);
    expect(calls[0]!.auth).toBe('Bearer k');
    expect(got).toHaveLength(3000);
    expect(feed.stats.points).toBe(400); // 100 points per request, the cap
  });

  it('staleness check: drops states whose snapshot time is too old', async () => {
    const now = 5_000_000;
    const { f } = fakeFetch(() => ({ json: { successful_states: [[U, st('1', now - HYDRO_MAX_LAG_MS - 1)]] } }));
    const got: string[] = [];
    const feed = new HydromancerFeed({ url: 'https://h', apiKey: 'k', dexes: ['xyz'], pointsPerMinute: 10_000, onState: (u) => got.push(u), fetch: f, now: () => now });
    feed.setUsers([U]);
    await feed.poll();
    expect(got).toEqual([]);
    expect(feed.stats.staleStates).toBe(1);
  });

  it('keeps to the points budget', async () => {
    const t = { now: 5_000_000 };
    const { f, calls } = fakeFetch(() => ({ json: { successful_states: [] } }));
    const feed = new HydromancerFeed({ url: 'https://h', apiKey: 'k', dexes: ['', 'xyz'], pointsPerMinute: 150, onState: () => undefined, fetch: f, now: () => t.now });
    feed.setUsers(Array.from({ length: 60 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`));
    await feed.poll();
    expect(calls).toHaveLength(1); // 100 + 100 > 150
    expect(feed.stats.skippedForBudget).toBe(1);
    t.now += 60_001;
    await feed.poll();
    expect(calls).toHaveLength(2);
    expect(hydroWeight(3)).toBe(6);
  });

  it('turns itself off when the key is refused (e.g. a mainnet key on testnet), leaving the native feeds', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 401, json: { error: 'Invalid API key' } }));
    const logs: unknown[] = [];
    const feed = new HydromancerFeed({ url: 'https://h', apiKey: 'k', dexes: ['', 'xyz'], pointsPerMinute: 10_000, onState: () => undefined, fetch: f, log: (m) => logs.push(m) });
    feed.setUsers([U]);
    await feed.poll();
    await feed.poll();
    expect(calls).toHaveLength(1);
    expect(feed.disabled).toMatch(/401/);
    expect(JSON.stringify(logs)).not.toContain('"k"');
  });
});

describe('native REST fallback', () => {
  it('polls only dexes without a fresh Hydromancer state, refreshes native ones at 24 s, within its weight budget', async () => {
    const t = { now: 1_000_000 };
    const { a, last } = arbiter(t);
    const V = '0x0000000000000000000000000000000000000002';
    a.hydromancer(U, '', st('10'), t.now);
    a.hydromancer(U, 'xyz', st('20'), t.now);
    const asked: string[] = [];
    const poller = new NativeFallbackPoller(a, async (u, dex) => (asked.push(`${u}|${dex}`), st('7')), ['', 'xyz'], () => t.now, 600);
    await poller.poll([U, V]);
    expect(asked).toEqual([`${V}|`, `${V}|xyz`]); // U is fresh on Hydromancer
    expect(value(last().states, 'xyz')).toBe('7');
    t.now += HYDRO_STALE_MS + 1; // U's Hydromancer state is stale; V's native state is 15 s old
    asked.length = 0;
    await poller.poll([U, V]);
    expect(asked).toEqual([`${U}|`, `${U}|xyz`]); // V waits until 24 s
    t.now += 10_000;
    asked.length = 0;
    await poller.poll([U, V]);
    expect(asked).toEqual([`${V}|`, `${V}|xyz`]);
    // A budget too small for the next request: skipped, not overspent.
    const tiny = new NativeFallbackPoller(a, async () => st('1'), ['', 'xyz'], () => t.now, 12);
    t.now += 60_000;
    await tiny.poll([U, V]);
    expect(tiny.stats.requests).toBe(1);
    expect(tiny.stats.skippedForBudget).toBe(1);
  });

  it('weight budget slides over one minute', () => {
    const t = { now: 0 };
    const b = new WeightBudget(4, () => t.now);
    expect([b.take(2), b.take(2), b.take(2)]).toEqual([true, true, false]);
    t.now = 60_001;
    expect(b.take(2)).toBe(true);
  });
});

describe('builderApproved streams', () => {
  function socket() {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    const sent: string[] = [];
    const s: SocketLike = { on: (e, cb) => void (handlers[e] = cb), send: (d) => void sent.push(d), close: () => handlers.close?.() };
    return { s, handlers, sent };
  }

  it('subscribes to all four streams for our builder, refreshes users on activity, reports liquidations, answers pings', () => {
    const sock = socket();
    const activity: string[][] = [];
    const liquidations: string[] = [];
    const stream = new BuilderStream('wss://h/ws', '0xbuilder', { onActivity: (u) => activity.push(u), onLiquidation: (u) => liquidations.push(u) }, () => sock.s, () => 1);
    stream.start();
    sock.handlers.open?.();
    expect(sock.sent.map((m) => JSON.parse(m).subscription.type)).toEqual([...BUILDER_STREAMS]);
    expect(sock.sent.every((m) => JSON.parse(m).subscription.builder === '0xbuilder')).toBe(true);

    stream.onMessage(JSON.stringify({ type: 'subscriptionUpdate', subscribed: ['builderApprovedFills'] }));
    stream.onMessage(JSON.stringify({ type: 'builderApprovedFills', channel: 'builderApprovedFills', fills: [[U.toUpperCase().replace('0X', '0x'), { coin: 'xyz:CL' }]] }));
    stream.onMessage(JSON.stringify({ type: 'builderApprovedNonFundingLedgerEvents', ledgerEvents: [{ user: U, delta: { type: 'deposit' } }] }));
    stream.onMessage(JSON.stringify({ type: 'builderLiquidations', liquidations: [[U, { coin: 'xyz:CL', sz: '1' }]] }));
    expect(activity).toEqual([[U], [U], [U]]);
    expect(liquidations).toEqual([U]);

    stream.onMessage(JSON.stringify({ type: 'ping' }));
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({ type: 'pong' });
    stream.stop();
  });
});

describe('REST fallback under load (8 Oct 2026)', () => {
  it('serves accounts fairly and, beyond its budget, keeps as many fresh as it can instead of starving the end of the list', async () => {
    const { simulate } = await import('../bench/feed-capacity.js');
    expect((await simulate(70, 4)).staleAccounts).toBe(0); // before: 40 of 70 went stale, the end of the list never refreshed
    const over = await simulate(300, 4);
    expect(300 - over.staleAccounts).toBeGreaterThanOrEqual(65); // before: about 10 stayed fresh
  });
});
