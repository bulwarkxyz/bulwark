'use client';

import { assessRisk, buildAssetIndex, buildSnapshot, dexCollateral, type AccountRisk, type AccountSnapshot, type AssetIndex, type RawClearinghouseState, type RawPerpDexs, type RawPerpMeta, type RawSpotState } from '@bulwarkxyz/guard-core';
import { InfoClient, type Hex } from '@bulwarkxyz/hyperliquid';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { NETWORK } from './env';
import { stream } from './ws';

export const info = new InfoClient(NETWORK);
const REFRESH_MS = 5_000;

export function useAssets() {
  return useQuery({
    queryKey: ['assets', NETWORK],
    queryFn: async () => {
      const perpDexs = (await info.perpDexs()) as RawPerpDexs;
      const metas = (await info.allPerpMetas()) as RawPerpMeta[];
      return { assets: buildAssetIndex(perpDexs, metas) as AssetIndex, collateral: dexCollateral(perpDexs, metas) };
    },
    staleTime: 10 * 60_000,
  });
}

export interface MarketCtx {
  coin: string;
  mark: number;
  oracle: number;
  prevDay: number;
  change: number;
  fundingAprPct: number;
  /** Funding rate per hour in percent, as Hyperliquid quotes it (paid every hour). */
  fundingHourlyPct: number;
  openInterestUsd: number;
  dayVolumeUsd: number;
  maxLeverage: number;
  szDecimals: number;
  onlyIsolated: boolean;
  delisted: boolean;
}

/** Live contexts for every market on the xyz dex (metaAndAssetCtxs). */
export function useXyzMarkets() {
  return useQuery({
    queryKey: ['xyz-markets', NETWORK],
    queryFn: async () => {
      const [meta, ctxs] = (await info.metaAndAssetCtxs('xyz')) as [{ universe: Array<{ name: string; maxLeverage: number; szDecimals: number; onlyIsolated?: boolean; isDelisted?: boolean }> }, Array<Record<string, string>>];
      const out = new Map<string, MarketCtx>();
      meta.universe.forEach((u, i) => {
        const c = ctxs[i];
        if (!c) return;
        const mark = Number(c.markPx);
        const prev = Number(c.prevDayPx);
        out.set(u.name, {
          coin: u.name,
          mark,
          oracle: Number(c.oraclePx),
          prevDay: prev,
          change: prev ? mark / prev - 1 : 0,
          // funding is per hour; APR = hourly × 24 × 365
          fundingAprPct: Number(c.funding) * 24 * 365 * 100,
          fundingHourlyPct: Number(c.funding) * 100,
          openInterestUsd: Number(c.openInterest) * mark,
          dayVolumeUsd: Number(c.dayNtlVlm),
          maxLeverage: u.maxLeverage,
          szDecimals: u.szDecimals,
          onlyIsolated: u.onlyIsolated === true,
          delisted: u.isDelisted === true,
        });
      });
      return out;
    },
    refetchInterval: REFRESH_MS,
  });
}

export interface AccountView {
  snapshot: AccountSnapshot;
  risk: AccountRisk;
  abstraction: string;
}

/** The user's state across dexes, normalised by guard-core (the same numbers the guard acts on). */
export function useAccountView(address: Hex | undefined) {
  const assets = useAssets();
  return useQuery({
    queryKey: ['account', NETWORK, address],
    enabled: Boolean(address && assets.data),
    queryFn: async (): Promise<AccountView> => {
      const user = address as Hex;
      const [abstraction, main, xyz, spot] = await Promise.all([
        info.userAbstraction(user),
        info.clearinghouseState(user, ''),
        info.clearinghouseState(user, 'xyz'),
        info.spotClearinghouseState(user),
      ]);
      const snapshot = buildSnapshot({
        abstraction,
        dexStates: { '': main as RawClearinghouseState, xyz: xyz as RawClearinghouseState },
        spot: spot as RawSpotState,
        assets: assets.data!.assets,
        dexCollateral: assets.data!.collateral,
      });
      return { snapshot, risk: assessRisk(snapshot), abstraction };
    },
    refetchInterval: REFRESH_MS,
  });
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export function useCandles(coin: string, interval: '5m' | '15m' | '1h' | '4h' | '1d', hours: number) {
  return useQuery({
    queryKey: ['candles', NETWORK, coin, interval, hours],
    queryFn: async (): Promise<Candle[]> => {
      const end = Date.now();
      const rows = await info.request<Array<{ t: number; o: string; c: string; h: string; l: string }>>({ type: 'candleSnapshot', req: { coin, interval, startTime: end - hours * 3_600_000, endTime: end } });
      return rows.map((r) => ({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) }));
    },
    refetchInterval: 60_000,
  });
}

export interface BookLevel {
  px: number;
  sz: number;
}
type RawLevel = { px: string; sz: string };
const toLevels = (xs: RawLevel[] | undefined): BookLevel[] => (xs ?? []).map((x) => ({ px: Number(x.px), sz: Number(x.sz) }));

/** Live-stream status for the status bar: socket open, and when the last market message arrived. */
export function useStreamStatus() {
  return useSyncExternalStore(
    (fn) => stream.onStatus(fn),
    () => stream.status,
    () => stream.status,
  );
}

export interface Book {
  bids: BookLevel[];
  asks: BookLevel[];
  time: number;
}

/**
 * Order book: streamed (l2Book subscription), with REST polling as the fallback whenever the stream is
 * closed. `source` says which one the screen is showing; `updatedAt` is when it last changed.
 */
export function useBook(coin: string) {
  const status = useStreamStatus();
  const [live, setLive] = useState<{ book: Book; at: number } | null>(null);
  useEffect(() => {
    setLive(null);
    return stream.subscribe({ type: 'l2Book', coin }, (d) => {
      const x = d as { levels: [RawLevel[], RawLevel[]]; time: number };
      setLive({ book: { bids: toLevels(x.levels?.[0]), asks: toLevels(x.levels?.[1]), time: x.time }, at: Date.now() });
    });
  }, [coin]);
  const streaming = status.open && live !== null;
  const poll = useQuery({
    queryKey: ['book', NETWORK, coin],
    enabled: !streaming,
    queryFn: async (): Promise<Book> => {
      const r = await info.request<{ levels: [RawLevel[], RawLevel[]]; time: number }>({ type: 'l2Book', coin });
      return { bids: toLevels(r.levels[0]), asks: toLevels(r.levels[1]), time: r.time };
    },
    refetchInterval: streaming ? false : 2_000,
  });
  const data = streaming ? live.book : (poll.data ?? live?.book);
  return {
    data,
    source: streaming ? ('stream' as const) : ('poll' as const),
    updatedAt: streaming ? live.at : poll.dataUpdatedAt || live?.at || 0,
    isError: !streaming && poll.isError,
  };
}

export interface Trade {
  px: number;
  sz: number;
  side: 'B' | 'A';
  time: number;
  tid?: number;
}
type RawTrade = { px: string; sz: string; side: 'B' | 'A'; time: number; tid?: number };
const toTrade = (r: RawTrade): Trade => ({ px: Number(r.px), sz: Number(r.sz), side: r.side, time: r.time, tid: r.tid });

/** Recent trades: one REST snapshot, then the trades stream; polling only while the stream is closed. */
export function useTrades(coin: string) {
  const status = useStreamStatus();
  const [streamed, setStreamed] = useState<Trade[]>([]);
  useEffect(() => {
    setStreamed([]);
    return stream.subscribe({ type: 'trades', coin }, (d) => setStreamed((xs) => [...(d as RawTrade[]).map(toTrade), ...xs].slice(0, 100)));
  }, [coin]);
  const base = useQuery({
    queryKey: ['trades', NETWORK, coin],
    queryFn: async (): Promise<Trade[]> => (await info.request<RawTrade[]>({ type: 'recentTrades', coin })).map(toTrade),
    refetchInterval: status.open ? false : 3_000,
  });
  const seen = new Set<string>();
  const data = [...streamed, ...(base.data ?? [])]
    .filter((t) => {
      const k = `${t.tid ?? ''}|${t.time}|${t.px}|${t.sz}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.time - a.time);
  return { data: base.data || streamed.length ? data : undefined, source: status.open ? ('stream' as const) : ('poll' as const), isError: !status.open && base.isError };
}

export interface Fill {
  coin: string;
  px: string;
  sz: string;
  side: 'B' | 'A';
  time: number;
  fee: string;
  builderFee?: string;
  closedPnl: string;
  dir: string;
  liquidation?: unknown;
}

export function useFills(address: Hex | undefined) {
  return useQuery({
    queryKey: ['fills', NETWORK, address],
    enabled: Boolean(address),
    queryFn: () => info.request<Fill[]>({ type: 'userFills', user: address as Hex }),
    refetchInterval: 15_000,
  });
}

/** The user's realised all-in fee rate on a market, in bps, from their own recent fills (real numbers only). */
export function realisedFeeBps(fills: readonly Fill[] | undefined, coin: string): number | null {
  const rows = (fills ?? []).filter((f) => f.coin === coin);
  const notional = rows.reduce((s, f) => s + Number(f.px) * Number(f.sz), 0);
  if (!notional) return null;
  const fees = rows.reduce((s, f) => s + Number(f.fee), 0);
  return (fees / notional) * 1e4;
}
