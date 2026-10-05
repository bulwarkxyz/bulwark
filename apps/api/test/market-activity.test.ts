import { MemoryStore } from '@bulwarkxyz/store';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ACTIVITY_CACHE_MS, byActivity, summarise } from '../src/market-activity.js';

const H = 3600_000;
const NOW = 1_791_200_000_000;

describe('market activity', () => {
  it('a market has recent data only when it traded in the last 24 h; candles with no trades do not count', () => {
    const idle = summarise('xyz:CL', true, false, 0, [{ t: NOW - 30 * H, n: 4 }, { t: NOW - 2 * H, n: 0 }], NOW);
    expect(idle).toMatchObject({ hasRecentData: false, lastTradeAt: NOW - 30 * H, trades24h: 0, candles24h: 1 });
    const live = summarise('xyz:GOLD', true, false, 2348, [{ t: NOW - 3 * H, n: 5 }, { t: NOW - H, n: 2 }], NOW);
    expect(live).toMatchObject({ hasRecentData: true, lastTradeAt: NOW - H, trades24h: 7, candles24h: 2 });
    expect(summarise('xyz:SP500', true, true, 0, [{ t: NOW - H, n: 3 }], NOW).hasRecentData).toBe(false);
    expect(summarise('xyz:NOPE', false, false, 0, [], NOW)).toMatchObject({ listed: false, hasRecentData: false, lastTradeAt: null });
  });

  it('sorts markets with recent data first, then by trades, then by volume', () => {
    const m = (coin: string, hasRecentData: boolean, trades24h: number, dayNtlVlm: number) => ({ coin, listed: true, delisted: false, hasRecentData, lastTradeAt: null, trades24h, candles24h: 0, dayNtlVlm });
    const sorted = [m('xyz:CL', false, 0, 0), m('xyz:NVDA', true, 7, 528), m('xyz:GOLD', true, 14, 2348), m('xyz:MU', false, 0, 10)].sort(byActivity);
    expect(sorted.map((x) => x.coin)).toEqual(['xyz:GOLD', 'xyz:NVDA', 'xyz:MU', 'xyz:CL']);
  });

  it('GET /markets/activity is public, checks its input, and is cached so visitors do not multiply Hyperliquid requests', async () => {
    let now = NOW;
    let candleCalls = 0;
    const info = {
      metaAndAssetCtxs: async () => [{ universe: [{ name: 'xyz:CL' }, { name: 'xyz:GOLD' }] }, [{ dayNtlVlm: '0' }, { dayNtlVlm: '2348.5' }]],
      candleSnapshot: async (coin: string) => (candleCalls++, coin === 'xyz:GOLD' ? [{ t: NOW - H, n: 3 }] : []),
    } as never;
    const app = createApp({ store: new MemoryStore(), info, jwtSecret: new TextEncoder().encode('test-secret-test-secret-test-secret'), proxySecret: 'p', siweDomain: 'x', keyCustody: 'kms', network: 'testnet', now: () => now });
    expect((await app.request('/markets/activity')).status).toBe(400);
    expect((await app.request('/markets/activity?coins=CL')).status).toBe(400);
    const res = await app.request('/markets/activity?coins=xyz:CL,xyz:GOLD,xyz:TSLA');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { network: string; markets: Array<{ coin: string; listed: boolean; hasRecentData: boolean; dayNtlVlm: number }> };
    expect(body.network).toBe('testnet');
    expect(body.markets.map((m) => [m.coin, m.listed, m.hasRecentData])).toEqual([['xyz:CL', true, false], ['xyz:GOLD', true, true], ['xyz:TSLA', false, false]]);
    expect(body.markets[1]!.dayNtlVlm).toBe(2348.5);
    expect(candleCalls).toBe(2); // not listed: no candle request
    await app.request('/markets/activity?coins=xyz:CL,xyz:GOLD');
    expect(candleCalls).toBe(2);
    now += ACTIVITY_CACHE_MS;
    await app.request('/markets/activity?coins=xyz:CL,xyz:GOLD');
    expect(candleCalls).toBe(4);
  });
});
