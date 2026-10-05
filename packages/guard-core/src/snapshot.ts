import type { AssetIndex, AssetInfo, MarginTier } from './assets.js';
import { tiersForPosition } from './margin.js';
import type { RawAbstraction, RawClearinghouseState, RawSpotState } from './types.js';

/**
 * Account modes the guard understands.
 * - standard: `disabled` / `default`. Each dex is its own cross-margin pool.
 * - unified: one balance per collateral token backs cross positions on every dex using it.
 * - portfolio: shown read-only; the guard does not act (decision D8).
 * - unsupported: discontinued `dexAbstraction`.
 * https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes
 */
export type AccountMode = 'standard' | 'unified' | 'portfolio' | 'unsupported';

export function accountModeOf(raw: RawAbstraction | string): AccountMode {
  switch (raw) {
    case 'disabled':
    case 'default':
      return 'standard';
    case 'unifiedAccount':
      return 'unified';
    case 'portfolioMargin':
      return 'portfolio';
    default:
      return 'unsupported';
  }
}

export type PoolKind = 'dex' | 'token' | 'isolated';

export interface Pool {
  id: string;
  kind: PoolKind;
  /** Dex for `dex` and `isolated` pools. */
  dex: string | null;
  /** Collateral token for `token` pools (unified). */
  token: number | null;
  /** Equity backing the pool at snapshot marks. */
  equityAtSnapshot: number;
}

export interface Position {
  key: string;
  dex: string;
  coin: string;
  /** Signed size: positive long, negative short. */
  size: number;
  markAtSnapshot: number;
  entryPx: number;
  leverageType: 'cross' | 'isolated';
  leverage: number;
  /** Isolated positions only: isolated margin = rawUsd + size * mark. */
  isolatedRawUsd: number | null;
  poolId: string;
  asset: AssetInfo;
  /** Margin tiers that apply to this position (uses the position's own max leverage). */
  tiers: MarginTier[];
  /** Values the API reported, kept for reconciliation. */
  api: { liquidationPx: number | null; marginUsed: number; unrealizedPnl: number; positionValue: number };
}

/** Balance the guard may move into a pool (standard mode) or into isolated margin. */
export interface IdleSource {
  /** `spot`, `dex:<name>` or `token:<id>` (unified). */
  id: string;
  kind: 'spot' | 'dex' | 'token';
  dex: string | null;
  token: number;
  availableAtSnapshot: number;
}

export interface AccountSnapshot {
  mode: AccountMode;
  time: number;
  positions: Position[];
  pools: Pool[];
  idle: IdleSource[];
  accountValueAtSnapshot: number;
}

export interface SnapshotInput {
  abstraction: RawAbstraction | string;
  /** clearinghouseState per dex name (`""` = main dex). Dexes with no state may be omitted. */
  dexStates: Record<string, RawClearinghouseState>;
  spot: RawSpotState;
  assets: AssetIndex;
  /** dex name → collateral token id. */
  dexCollateral: ReadonlyMap<string, number>;
  time?: number;
}

const num = (s: string | null | undefined): number => (s === null || s === undefined ? NaN : Number(s));

export function buildSnapshot(input: SnapshotInput): AccountSnapshot {
  const mode = accountModeOf(input.abstraction);
  const positions: Position[] = [];
  const pools = new Map<string, Pool>();
  const idle: IdleSource[] = [];

  const spotTotal = (token: number): number => num(input.spot.balances.find((b) => b.token === token)?.total ?? '0');
  const spotHold = (token: number): number => num(input.spot.balances.find((b) => b.token === token)?.hold ?? '0');

  for (const [dex, state] of Object.entries(input.dexStates)) {
    const token = input.dexCollateral.get(dex) ?? 0;
    for (const { position: p } of state.assetPositions) {
      const asset = input.assets.get(p.coin);
      if (!asset) throw new Error(`unknown asset ${p.coin}`);
      const size = num(p.szi);
      if (size === 0) continue;
      const mark = num(p.positionValue) / Math.abs(size);
      const isolated = p.leverage.type === 'isolated';
      const key = `${dex}|${p.coin}`;
      const poolId = isolated ? `iso:${key}` : mode === 'unified' ? `token:${token}` : `dex:${dex}`;
      positions.push({
        key,
        dex,
        coin: p.coin,
        size,
        markAtSnapshot: mark,
        entryPx: num(p.entryPx),
        leverageType: p.leverage.type,
        leverage: p.leverage.value,
        isolatedRawUsd: isolated ? num(p.leverage.rawUsd) : null,
        poolId,
        asset,
        tiers: tiersForPosition(asset.tiers, p.maxLeverage),
        api: {
          liquidationPx: p.liquidationPx === null ? null : num(p.liquidationPx),
          marginUsed: num(p.marginUsed),
          unrealizedPnl: num(p.unrealizedPnl),
          positionValue: num(p.positionValue),
        },
      });
      if (isolated) {
        pools.set(poolId, { id: poolId, kind: 'isolated', dex, token: null, equityAtSnapshot: num(p.marginUsed) });
      }
    }
  }

  if (mode === 'standard') {
    for (const [dex, state] of Object.entries(input.dexStates)) {
      const hasCross = positions.some((p) => p.dex === dex && p.leverageType === 'cross');
      if (hasCross) {
        pools.set(`dex:${dex}`, {
          id: `dex:${dex}`,
          kind: 'dex',
          dex,
          token: null,
          equityAtSnapshot: num(state.crossMarginSummary.accountValue),
        });
      }
      const withdrawable = num(state.withdrawable);
      if (withdrawable > 0) {
        idle.push({ id: `dex:${dex}`, kind: 'dex', dex, token: input.dexCollateral.get(dex) ?? 0, availableAtSnapshot: withdrawable });
      }
    }
    const usdc = Math.max(0, spotTotal(0) - spotHold(0));
    if (usdc > 0) idle.push({ id: 'spot', kind: 'spot', dex: null, token: 0, availableAtSnapshot: usdc });
  } else if (mode === 'unified') {
    // Equity for a token pool = spot total − isolated margin on dexes using that token
    // (official computeUnifiedAccountRatio).
    const tokens = new Set(positions.filter((p) => p.leverageType === 'cross').map((p) => input.dexCollateral.get(p.dex) ?? 0));
    for (const token of tokens) {
      const isolated = positions
        .filter((p) => p.leverageType === 'isolated' && (input.dexCollateral.get(p.dex) ?? 0) === token)
        .reduce((s, p) => s + p.api.marginUsed, 0);
      pools.set(`token:${token}`, { id: `token:${token}`, kind: 'token', dex: null, token, equityAtSnapshot: spotTotal(token) - isolated });
    }
    for (const [token, available] of input.spot.tokenToAvailableAfterMaintenance ?? []) {
      const a = num(available);
      if (a > 0) idle.push({ id: `token:${token}`, kind: 'token', dex: null, token, availableAtSnapshot: a });
    }
  }

  const collateralTokens = new Set(input.dexCollateral.values());
  const accountValueAtSnapshot =
    mode === 'standard'
      ? Object.values(input.dexStates).reduce((s, st) => s + num(st.marginSummary.accountValue), 0) + spotTotal(0)
      : [...collateralTokens].reduce((s, t) => s + spotTotal(t), 0);

  return {
    mode,
    time: input.time ?? Math.max(0, ...Object.values(input.dexStates).map((s) => s.time)),
    positions,
    pools: [...pools.values()],
    idle,
    accountValueAtSnapshot,
  };
}
