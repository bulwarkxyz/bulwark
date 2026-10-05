import type { AccountSnapshot, Position } from './snapshot.js';

/** Simulator state helpers (not part of the guard). */

export function clone(s: AccountSnapshot): AccountSnapshot {
  return { ...s, positions: s.positions.map((p) => ({ ...p })), pools: s.pools.map((p) => ({ ...p })), idle: s.idle.map((i) => ({ ...i })) };
}

/** Moves a position by `delta` at `px`, keeping pool equity consistent with assessRisk. */
export function fill(s: AccountSnapshot, coin: string, delta: number, px: number, mark: number, feeRate: number): number {
  const p = s.positions.find((x) => x.coin === coin) as Position | undefined;
  if (!p || !delta) return 0;
  const pool = s.pools.find((x) => x.id === p.poolId);
  const fee = Math.abs(delta) * px * feeRate;
  // Realise PnL to the current mark, then pay the gap between mark and fill price, and the fee.
  const realised = p.size * (mark - p.markAtSnapshot);
  const cost = delta * (px - mark) + fee;
  s.accountValueAtSnapshot += realised - cost;
  if (pool && pool.kind !== 'isolated') pool.equityAtSnapshot += realised - cost;
  else if (p.isolatedRawUsd !== null) p.isolatedRawUsd -= delta * px + fee; // isolated equity = rawUsd + size × mark
  p.markAtSnapshot = mark;
  p.size = Math.abs(p.size + delta) < 1e-12 ? 0 : p.size + delta;
  return fee;
}

