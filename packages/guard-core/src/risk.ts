import { liquidationPrice, maintenanceMargin, priceForBuffer } from './margin.js';
import type { AccountMode, AccountSnapshot, IdleSource, Pool, Position } from './snapshot.js';

/** Current marks by coin. Missing coins keep their snapshot mark. */
export type Marks = Readonly<Record<string, number>>;

export interface PositionRisk {
  position: Position;
  mark: number;
  notional: number;
  maintenance: number;
  unrealizedPnl: number;
  /** Liquidation price with every other position held still. */
  liquidationPx: number | null;
}

export interface PoolRisk {
  pool: Pool;
  equity: number;
  maintenance: number;
  /** maintenance / equity. Liquidation at 1. Infinity when equity <= 0. */
  ratio: number;
  /** equity / maintenance — the number users set lines on. Infinity when nothing is at risk. */
  buffer: number;
  positions: PositionRisk[];
}

export interface AccountRisk {
  mode: AccountMode;
  /** False for portfolio margin and discontinued modes: shown read-only, the guard does not act. */
  supported: boolean;
  pools: PoolRisk[];
  /** Pool with the lowest buffer. */
  worst: PoolRisk | null;
  accountValue: number;
  idle: Array<IdleSource & { available: number }>;
}

export const markOf = (p: Position, marks: Marks | undefined): number => marks?.[p.coin] ?? p.markAtSnapshot;

/**
 * Revalues a snapshot at new marks and computes per-pool maintenance, ratio and buffer.
 * Cross pool equity moves by Σ size·Δmark of its cross positions; isolated margin = rawUsd + size·mark.
 */
export function assessRisk(snapshot: AccountSnapshot, marks?: Marks): AccountRisk {
  const supported = snapshot.mode === 'standard' || snapshot.mode === 'unified';
  const pools: PoolRisk[] = snapshot.pools.map((pool) => {
    const members = snapshot.positions.filter((p) => p.poolId === pool.id);
    let equity: number;
    if (pool.kind === 'isolated') {
      const p = members[0] as Position;
      equity = (p.isolatedRawUsd ?? 0) + p.size * markOf(p, marks);
    } else {
      equity = pool.equityAtSnapshot + members.reduce((s, p) => s + p.size * (markOf(p, marks) - p.markAtSnapshot), 0);
    }
    const rows = members.map((p) => {
      const mark = markOf(p, marks);
      const notional = Math.abs(p.size) * mark;
      return { position: p, mark, notional, maintenance: maintenanceMargin(p.tiers, notional), unrealizedPnl: p.size * (mark - p.entryPx), liquidationPx: null as number | null };
    });
    const maintenance = rows.reduce((s, r) => s + r.maintenance, 0);
    for (const r of rows) {
      r.liquidationPx = liquidationPrice({ mark: r.mark, size: r.position.size, equity, otherMaintenance: maintenance - r.maintenance, tiers: r.position.tiers });
    }
    const ratio = equity > 0 ? maintenance / equity : Number.POSITIVE_INFINITY;
    const buffer = maintenance > 0 ? Math.max(0, equity) / maintenance : Number.POSITIVE_INFINITY;
    return { pool, equity, maintenance, ratio, buffer, positions: rows };
  });

  const worst = pools.reduce<PoolRisk | null>((w, p) => (w === null || p.buffer < w.buffer ? p : w), null);
  const delta = snapshot.positions.reduce((s, p) => s + p.size * (markOf(p, marks) - p.markAtSnapshot), 0);
  // Idle balances at current marks.
  // - dex (standard): transferable = equity − max(initial margin, 10% of notional)
  //   https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margining (transfer_margin_required)
  // - token (unified): equity − maintenance, i.e. tokenToAvailableAfterMaintenance.
  // - spot: cash.
  const idle = snapshot.idle.map((src) => {
    if (src.kind === 'dex') {
      const pool = pools.find((p) => p.pool.kind === 'dex' && p.pool.dex === src.dex);
      if (!pool) return { ...src, available: src.availableAtSnapshot };
      const initial = pool.positions.reduce((s, r) => s + r.notional / Math.max(1, r.position.leverage), 0);
      const tenPct = 0.1 * pool.positions.reduce((s, r) => s + r.notional, 0);
      return { ...src, available: Math.max(0, Math.min(src.availableAtSnapshot + Math.max(0, pool.equity - pool.pool.equityAtSnapshot), pool.equity - Math.max(initial, tenPct))) };
    }
    if (src.kind === 'token') {
      const pool = pools.find((p) => p.pool.kind === 'token' && p.pool.token === src.token);
      return { ...src, available: pool ? Math.max(0, pool.equity - pool.maintenance) : src.availableAtSnapshot };
    }
    return { ...src, available: src.availableAtSnapshot };
  });

  return { mode: snapshot.mode, supported, pools, worst, accountValue: snapshot.accountValueAtSnapshot + delta, idle };
}

/** Effective leverage of one position against its pool's equity. */
export function positionLeverage(risk: AccountRisk, coin: string): number | null {
  for (const pool of risk.pools) {
    const row = pool.positions.find((r) => r.position.coin === coin);
    if (row) return pool.equity > 0 ? row.notional / pool.equity : Number.POSITIVE_INFINITY;
  }
  return null;
}

/** Where one of the user's buffer lines sits in price terms for one position. */
export interface GuardLevel {
  /** The user's line (buffer, ×). */
  line: number;
  /** Mark of this position at which its pool reaches the line, every other mark held. */
  price: number;
  /** (price − mark) / mark: negative for a fall, positive for a rise. */
  move: number;
}

/**
 * The mark at which `row`'s pool reaches `line`, moving only this position against itself
 * (down for a long, up for a short). Null when the pool is already at or below the line, or when
 * no adverse price reaches it (for example a line at or above 2 × max leverage).
 */
export function priceAtLine(pool: PoolRisk, row: PositionRisk, line: number): GuardLevel | null {
  if (!(line > 0) || !(pool.buffer > line) || !Number.isFinite(pool.equity)) return null;
  const price = priceForBuffer({
    mark: row.mark,
    size: row.position.size,
    equity: pool.equity,
    otherMaintenance: pool.maintenance - row.maintenance,
    tiers: row.position.tiers,
    buffer: line,
  });
  if (price === null) return null;
  const adverse = row.position.size > 0 ? price < row.mark : price > row.mark;
  if (!adverse) return null;
  return { line, price, move: (price - row.mark) / row.mark };
}

/**
 * "Guard acts at": the first of the user's lines this position's pool would cross as the position
 * moves against itself, i.e. the highest line still below the pool's buffer that a price can reach.
 * Lines are the numbers the user typed in buffer rules; there are no defaults.
 */
export function guardActsAt(pool: PoolRisk, row: PositionRisk, lines: readonly number[]): GuardLevel | null {
  const below = [...new Set(lines)].filter((l) => l < pool.buffer).sort((a, b) => b - a);
  for (const line of below) {
    const level = priceAtLine(pool, row, line);
    if (level) return level;
  }
  return null;
}

/** Every buffer line the user typed, from their policy's buffer triggers. */
export function bufferLines(rules: ReadonlyArray<{ when: { kind: string; below?: number } }>): number[] {
  return [...new Set(rules.flatMap((r) => (r.when.kind === 'buffer' && typeof r.when.below === 'number' ? [r.when.below] : [])))].sort((a, b) => b - a);
}
