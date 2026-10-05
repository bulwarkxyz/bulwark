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
  it('opens on the market with the most activity in the last 24 hours (testnet today: GOLD, not CL)', () => {
    // As read on 5 Oct 2026: GOLD $2,348 traded in 24h, NVDA $528 with a later last trade, CL nothing.
    const a = act({ GOLD: { lastTradeAt: NOW - 128 * 60_000, dayVolumeUsd: 2347.88 }, NVDA: { lastTradeAt: NOW - 47 * 60_000, dayVolumeUsd: 527.88 }, CL: {} });
    expect(defaultMarket(a, 'testnet', NOW, null).ticker).toBe('GOLD');
  });
  it('with no 24h volume anywhere, the latest trade decides', () => {
    const a = act({ GOLD: { lastTradeAt: NOW - 3 * 3_600_000 }, SILVER: { lastTradeAt: NOW - 3_600_000 } });
    expect(defaultMarket(a, 'testnet', NOW, null).ticker).toBe('SILVER');
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
  it('the selector lists markets with data first, the rest last', () => {
    const a = act({ SILVER: { lastTradeAt: NOW - 1000 }, GOLD: { lastTradeAt: NOW - 5000 }, CL: { delisted: true } });
    const r = rankMarkets(a, 'testnet', NOW).map((m) => m.ticker);
    expect(r.slice(0, 2)).toEqual(['SILVER', 'GOLD']);
    expect(r.indexOf('CL')).toBeGreaterThan(1);
  });
});
