/**
 * Raw shapes returned by Hyperliquid's public info endpoint, limited to the fields the guard reads.
 * Numbers arrive as decimal strings. Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 */

export type RawAbstraction = 'unifiedAccount' | 'portfolioMargin' | 'disabled' | 'default' | 'dexAbstraction';

export interface RawLeverage {
  type: 'cross' | 'isolated';
  value: number;
  /** Present on isolated positions: isolated USDC balance before the position's notional. */
  rawUsd?: string;
}

export interface RawPosition {
  coin: string;
  szi: string;
  leverage: RawLeverage;
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  liquidationPx: string | null;
  marginUsed: string;
  maxLeverage: number;
}

export interface RawMarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
}

export interface RawClearinghouseState {
  marginSummary: RawMarginSummary;
  crossMarginSummary: RawMarginSummary;
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  assetPositions: Array<{ type: string; position: RawPosition }>;
  time: number;
}

export interface RawSpotBalance {
  coin: string;
  token: number;
  total: string;
  hold: string;
  entryNtl: string;
}

export interface RawSpotState {
  balances: RawSpotBalance[];
  tokenToAvailableAfterMaintenance?: Array<[number, string]>;
}

export interface RawMarginTier {
  lowerBound: string;
  maxLeverage: number;
}

export interface RawMarginTable {
  description: string;
  marginTiers: RawMarginTier[];
}

export interface RawAssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  marginTableId?: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
  marginMode?: 'strictIsolated' | 'noCross' | string;
}

export interface RawPerpMeta {
  universe: RawAssetMeta[];
  marginTables?: Array<[number, RawMarginTable]>;
  collateralToken?: number;
}

/** `perpDexs` returns `null` for the main dex followed by one object per HIP-3 dex. */
export type RawPerpDexs = Array<null | { name: string; fullName?: string }>;
