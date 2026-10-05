import { describe, expect, it } from 'vitest';
import { MARKETS, defaultMarket, hasData, rankMarkets, type MarketActivity } from '@/lib/markets';

const NOW = Date.UTC(2026, 9, 6, 12, 0);
const none: MarketActivity = { lastTradeAt: null, dayVolumeUsd: 0, delisted: false };
const act = (over: Record<string, Partial<MarketActivity>>) =>
  Object.fromEntries(MARKETS.map((m) => [m.coin, { ...none, ...(over[m.ticker] ?? {}) }])) as Record<string, MarketActivity>;

describe('default market: real data first', () => {
  it('no trade for a week and no volume, or delisted: no data', () => {
    expect(hasData({ ...none, lastTradeAt: NOW - 8 * 86_400_000 }, NOW)).toBe(false);
    expect(hasData({ ...none, lastTradeAt: NOW - 3_600_000 }, NOW)).toBe(true);
    expect(hasData({ ...none, dayVolumeUsd: 12 }, NOW)).toBe(true);
    expect(hasData({ lastTradeAt: NOW, dayVolumeUsd: 9, delisted: true }, NOW)).toBe(false);
  });
  it('opens on the first market in the fixed order that has data (testnet: GOLD, not CL)', () => {
    const a = act({ GOLD: { lastTradeAt: NOW - 128 * 60_000, dayVolumeUsd: 2347.88 }, NVDA: { lastTradeAt: NOW - 47 * 60_000, dayVolumeUsd: 527.88 }, CL: {} });
    expect(defaultMarket(a, 'testnet', NOW, null).ticker).toBe('GOLD');
    // If GOLD had nothing, the next in the order with data.
    const b = act({ NVDA: { lastTradeAt: NOW - 47 * 60_000 }, CL: {} });
    expect(defaultMarket(b, 'testnet', NOW, null).ticker).toBe('NVDA');
  });
  it('uses the API’s hasRecentData when it answered', () => {
    const a = act({ GOLD: { hasRecentData: false, lastTradeAt: NOW - 60_000, dayVolumeUsd: 9 }, NVDA: { hasRecentData: true } });
    expect(hasData(a['xyz:GOLD'], NOW)).toBe(false);
    expect(defaultMarket(a, 'testnet', NOW, null).ticker).toBe('NVDA');
  });
  it('remembers the user’s last market if it still has data, and ignores it if not', () => {
    const a = act({ GOLD: { lastTradeAt: NOW - 60_000 }, NVDA: { lastTradeAt: NOW - 86_400_000 } });
    expect(defaultMarket(a, 'testnet', NOW, 'NVDA').ticker).toBe('NVDA');
    expect(defaultMarket(a, 'testnet', NOW, 'CL').ticker).toBe('GOLD');
  });
  it('with no data anywhere, the fixed fallback order; while loading, the last market or the first fallback', () => {
    expect(defaultMarket(act({}), 'testnet', NOW, null).ticker).toBe('GOLD');
    expect(defaultMarket(act({}), 'mainnet', NOW, null).ticker).toBe('CL');
    expect(defaultMarket(null, 'testnet', NOW, 'SILVER').ticker).toBe('SILVER');
    expect(defaultMarket(null, 'testnet', NOW, null).ticker).toBe('GOLD');
  });
  it('the selector: with data first, then most trades in 24 h, then most volume; the rest last', () => {
    const a = act({ SILVER: { hasRecentData: true, trades24h: 3, dayVolumeUsd: 900 }, GOLD: { hasRecentData: true, trades24h: 31, dayVolumeUsd: 2348 }, NVDA: { hasRecentData: true, trades24h: 3, dayVolumeUsd: 528 }, CL: { delisted: true } });
    const r = rankMarkets(a, 'testnet', NOW).map((m) => m.ticker);
    expect(r.slice(0, 3)).toEqual(['GOLD', 'SILVER', 'NVDA']);
    expect(r.indexOf('CL')).toBeGreaterThan(2);
  });
});
