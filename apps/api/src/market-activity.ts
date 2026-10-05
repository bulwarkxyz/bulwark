/**
 * Whether each curated market has recent trading on this network, so the app can open the trade
 * screen on a market with a real chart and sort its selector. Testnet HIP-3 markets are often idle:
 * on 5 Oct 2026, xyz:GOLD, xyz:NVDA and xyz:XYZ100 had hourly candles there and the other seven had none.
 *
 * Read from Hyperliquid's public info endpoint (metaAndAssetCtxs for the xyz dex, and one hourly
 * candleSnapshot per market over the last 7 days), and cached so the API makes at most one round of
 * requests per ACTIVITY_CACHE_MS, whatever the number of visitors.
 */
import type { InfoClient } from '@bulwarkxyz/hyperliquid';

export const ACTIVITY_CACHE_MS = 2 * 60_000;
/** A market "has recent data" when it traded within this window. */
export const RECENT_WINDOW_MS = 24 * 3600_000;
const LOOKBACK_MS = 7 * 24 * 3600_000;
const HOUR = 3600_000;
/** At most this many coins per request. */
export const MAX_COINS = 20;

export interface MarketActivity {
  coin: string;
  /** Listed on this network's xyz dex. */
  listed: boolean;
  delisted: boolean;
  /** Traded within the last 24 h. */
  hasRecentData: boolean;
  /** Start of the latest hourly candle with at least one trade in the last 7 days (ms), or null. */
  lastTradeAt: number | null;
  /** Trades in the last 24 h (sum of hourly candle trade counts). */
  trades24h: number;
  /** Hourly candles in the last 24 h (what a 1 h chart would draw). */
  candles24h: number;
  /** Hyperliquid's 24 h notional volume, USD. */
  dayNtlVlm: number;
}

type Candle = { t: number; n: number };

/** One market's summary from its hourly candles. Pure, for tests. */
export function summarise(coin: string, listed: boolean, delisted: boolean, dayNtlVlm: number, candles: Candle[], now: number): MarketActivity {
  const recent = candles.filter((c) => c.t + HOUR > now - RECENT_WINDOW_MS);
  const traded = candles.filter((c) => Number(c.n) > 0);
  const lastTradeAt = traded.length ? Math.max(...traded.map((c) => c.t)) : null;
  const trades24h = recent.reduce((a, c) => a + Number(c.n), 0);
  return { coin, listed, delisted, hasRecentData: !delisted && trades24h > 0, lastTradeAt, trades24h, candles24h: recent.length, dayNtlVlm };
}

/** Markets with recent data first, then by trades in the last 24 h, then by volume; the input order breaks ties. */
export function byActivity(a: MarketActivity, b: MarketActivity): number {
  return Number(b.hasRecentData) - Number(a.hasRecentData) || b.trades24h - a.trades24h || b.dayNtlVlm - a.dayNtlVlm;
}

export function marketActivity(info: Pick<InfoClient, 'metaAndAssetCtxs' | 'candleSnapshot'>, now: () => number) {
  const cache = new Map<string, { at: number; value: MarketActivity }>();
  let ctx: { at: number; byCoin: Map<string, { delisted: boolean; dayNtlVlm: number }> } | null = null;

  const assetCtxs = async () => {
    if (ctx && now() - ctx.at < ACTIVITY_CACHE_MS) return ctx.byCoin;
    const [meta, ctxs] = (await info.metaAndAssetCtxs('xyz')) as [{ universe: Array<{ name: string; isDelisted?: boolean }> }, Array<{ dayNtlVlm?: string }>];
    const byCoin = new Map(meta.universe.map((a, i) => [a.name, { delisted: Boolean(a.isDelisted), dayNtlVlm: Number(ctxs[i]?.dayNtlVlm ?? 0) }]));
    ctx = { at: now(), byCoin };
    return byCoin;
  };

  return async (coins: string[]): Promise<MarketActivity[]> => {
    const byCoin = await assetCtxs();
    return Promise.all(
      coins.map(async (coin) => {
        const hit = cache.get(coin);
        if (hit && now() - hit.at < ACTIVITY_CACHE_MS) return hit.value;
        const a = byCoin.get(coin);
        const t = now();
        const candles = a ? await info.candleSnapshot(coin, '1h', t - LOOKBACK_MS, t) : [];
        const value = summarise(coin, Boolean(a), a?.delisted ?? false, a?.dayNtlVlm ?? 0, candles, t);
        cache.set(coin, { at: t, value });
        return value;
      }),
    );
  };
}
