'use client';

import { assessRisk, buildAssetIndex, buildSnapshot, dexCollateral, type AccountRisk, type AccountSnapshot, type AssetIndex, type RawClearinghouseState, type RawPerpDexs, type RawPerpMeta, type RawSpotState } from '@bulwarkxyz/guard-core';
import { InfoClient, type Hex } from '@bulwarkxyz/hyperliquid';
import { useQuery } from '@tanstack/react-query';
import { NETWORK } from './env';

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

export function useCandles(coin: string, interval: '1h' | '15m' | '1d', hours: number) {
  return useQuery({
    queryKey: ['candles', NETWORK, coin, interval, hours],
    queryFn: async () => {
      const end = Date.now();
      const rows = await info.request<Array<{ t: number; c: string; h: string; l: string }>>({ type: 'candleSnapshot', req: { coin, interval, startTime: end - hours * 3_600_000, endTime: end } });
      return rows.map((r) => ({ t: r.t, c: Number(r.c), h: Number(r.h), l: Number(r.l) }));
    },
    refetchInterval: 60_000,
  });
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
