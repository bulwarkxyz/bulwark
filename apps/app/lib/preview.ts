import { assessRisk, guardActsAt, tiersForPosition, type AccountSnapshot, type AssetIndex, type GuardLevel, type Position } from '@bulwarkxyz/guard-core';

export interface OrderPreview {
  bufferBefore: number | null;
  bufferAfter: number;
  /** The first of the user's lines this position would cross, as a price (null with no lines in reach). */
  guardAt: GuardLevel | null;
  liquidationPx: number | null;
}

/**
 * The account as it would be right after a fill of `delta` at `mark` (fees ignored), so the ticket
 * can show what the guard will see. Cross positions join their pool; isolated-only markets get their
 * own pool with margin = notional / leverage.
 */
export function previewOrder(args: {
  snapshot: AccountSnapshot;
  assets: AssetIndex;
  coin: string;
  delta: number;
  mark: number;
  leverage: number;
  /** The user's buffer lines. */
  lines: readonly number[];
}): OrderPreview | null {
  const { snapshot, assets, coin, delta, mark, leverage, lines } = args;
  const asset = assets.get(coin);
  if (!asset || !delta || !(mark > 0)) return null;
  const before = assessRisk(snapshot);
  const existing = snapshot.positions.find((p) => p.coin === coin);
  const positions = snapshot.positions.map((p) => ({ ...p }));
  const pools = snapshot.pools.map((p) => ({ ...p }));
  const isolated = existing ? existing.leverageType === 'isolated' : asset.onlyIsolated;
  const poolId = existing?.poolId ?? (isolated ? `iso:${asset.dex}|${coin}` : snapshot.mode === 'unified' ? `token:${asset.collateralToken}` : `dex:${asset.dex}`);

  if (existing) {
    const p = positions.find((x) => x.coin === coin) as Position;
    // Revalue at the current mark first, then change size; equity is unchanged by the fill itself.
    const pool = pools.find((x) => x.id === p.poolId);
    if (pool && pool.kind !== 'isolated') pool.equityAtSnapshot += p.size * (mark - p.markAtSnapshot);
    p.markAtSnapshot = mark;
    p.size += delta;
    if (isolated && p.isolatedRawUsd !== null) p.isolatedRawUsd -= delta * mark;
  } else {
    const margin = (Math.abs(delta) * mark) / Math.max(1, leverage);
    positions.push({
      key: `${asset.dex}|${coin}`,
      dex: asset.dex,
      coin,
      size: delta,
      markAtSnapshot: mark,
      entryPx: mark,
      leverageType: isolated ? 'isolated' : 'cross',
      leverage,
      isolatedRawUsd: isolated ? margin - delta * mark : null,
      poolId,
      asset,
      tiers: tiersForPosition(asset.tiers, asset.maxLeverage),
      api: { liquidationPx: null, marginUsed: margin, unrealizedPnl: 0, positionValue: Math.abs(delta) * mark },
    });
    if (!pools.some((x) => x.id === poolId)) {
      const idle = before.idle.find((s) => (snapshot.mode === 'unified' ? s.kind === 'token' : s.kind === 'dex' && s.dex === asset.dex));
      pools.push(isolated ? { id: poolId, kind: 'isolated', dex: asset.dex, token: null, equityAtSnapshot: margin } : { id: poolId, kind: snapshot.mode === 'unified' ? 'token' : 'dex', dex: snapshot.mode === 'unified' ? null : asset.dex, token: snapshot.mode === 'unified' ? asset.collateralToken : null, equityAtSnapshot: idle?.available ?? 0 });
    }
  }
  const live = positions.filter((p) => p.size !== 0);
  const after = assessRisk({ ...snapshot, positions: live, pools: pools.filter((p) => live.some((x) => x.poolId === p.id)) });
  const pool = after.pools.find((p) => p.pool.id === poolId);
  const row = pool?.positions.find((r) => r.position.coin === coin);
  const poolBefore = before.pools.find((p) => p.pool.id === poolId);
  return {
    bufferBefore: poolBefore ? poolBefore.buffer : null,
    bufferAfter: pool ? pool.buffer : Number.POSITIVE_INFINITY,
    guardAt: pool && row && lines.length ? guardActsAt(pool, row, lines) : null,
    liquidationPx: row?.liquidationPx ?? null,
  };
}
