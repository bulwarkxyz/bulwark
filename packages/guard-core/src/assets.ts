import type { RawPerpDexs, RawPerpMeta } from './types.js';

export interface MarginTier {
  /** Notional position value (quote units) where this tier starts. */
  lowerBound: number;
  maxLeverage: number;
}

export interface AssetInfo {
  /** Coin name as the API uses it, e.g. `BTC` or `xyz:CL`. */
  coin: string;
  /** Dex name; `""` is the main (validator-operated) dex. */
  dex: string;
  dexIndex: number;
  /** Order asset id: main dex = index; HIP-3 = 100000 + dexIndex * 10000 + index. */
  assetId: number;
  szDecimals: number;
  maxLeverage: number;
  tiers: MarginTier[];
  collateralToken: number;
  onlyIsolated: boolean;
  /** `noCross` allows removing isolated margin; `strictIsolated` does not. */
  marginMode: string | null;
  delisted: boolean;
}

export type AssetIndex = ReadonlyMap<string, AssetInfo>;

/**
 * Margin table ids below 50 mean a single tier whose max leverage equals the id.
 * https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margin-tiers
 */
function tiersFor(meta: RawPerpMeta, tableId: number | undefined, maxLeverage: number): MarginTier[] {
  if (tableId !== undefined) {
    const table = meta.marginTables?.find(([id]) => id === tableId)?.[1];
    if (table) {
      return table.marginTiers
        .map((t) => ({ lowerBound: Number(t.lowerBound), maxLeverage: t.maxLeverage }))
        .sort((a, b) => a.lowerBound - b.lowerBound);
    }
    if (tableId < 50) return [{ lowerBound: 0, maxLeverage: tableId }];
  }
  return [{ lowerBound: 0, maxLeverage }];
}

/** Builds a coin → asset lookup from `perpDexs` and `allPerpMetas` (same order). */
export function buildAssetIndex(perpDexs: RawPerpDexs, allPerpMetas: RawPerpMeta[]): AssetIndex {
  const index = new Map<string, AssetInfo>();
  allPerpMetas.forEach((meta, dexIndex) => {
    const dexEntry = perpDexs[dexIndex];
    const dex = dexEntry === null || dexEntry === undefined ? '' : dexEntry.name;
    meta.universe.forEach((asset, i) => {
      index.set(asset.name, {
        coin: asset.name,
        dex,
        dexIndex,
        assetId: dexIndex === 0 ? i : 100000 + dexIndex * 10000 + i,
        szDecimals: asset.szDecimals,
        maxLeverage: asset.maxLeverage,
        tiers: tiersFor(meta, asset.marginTableId, asset.maxLeverage),
        collateralToken: meta.collateralToken ?? 0,
        onlyIsolated: asset.onlyIsolated === true,
        marginMode: asset.marginMode ?? null,
        delisted: asset.isDelisted === true,
      });
    });
  });
  return index;
}

/** Maps dex name → collateral token id. */
export function dexCollateral(perpDexs: RawPerpDexs, allPerpMetas: RawPerpMeta[]): Map<string, number> {
  const out = new Map<string, number>();
  allPerpMetas.forEach((meta, i) => {
    const d = perpDexs[i];
    out.set(d === null || d === undefined ? '' : d.name, meta.collateralToken ?? 0);
  });
  return out;
}
