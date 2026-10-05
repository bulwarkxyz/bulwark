import { evaluate, type GuardAction } from './evaluate.js';
import type { Policy } from './policy.js';
import { assessRisk, type Marks } from './risk.js';
import type { AccountSnapshot, Position } from './snapshot.js';
import { windowContains, type WindowName } from './windows.js';

/**
 * Replays a price path against an account with the same `evaluate` the worker runs, applying the
 * guard's own actions as it goes. Fills are assumed at the order's limit price (the worst price the
 * guard would accept), resting backstops fill at their limit price once the mark crosses the
 * trigger, and the user's fee rate is charged on every fill. Funding and order-book depth are not
 * modelled. Every rule baseline starts at the first step.
 */

export interface SimStep {
  step: number;
  marks: Marks;
  /** Lowest pool buffer after this step's actions. */
  buffer: number;
  accountValue: number;
  fired: string[];
  actions: GuardAction[];
  /** A pool reached buffer 1 (Hyperliquid would liquidate it) before the guard could act. */
  liquidated: boolean;
}

export interface SimResult {
  steps: SimStep[];
  /** First step where a pool reached liquidation, or null. */
  liquidatedAt: number | null;
  /** The same path with no guard: first step a pool reaches liquidation, or null. */
  unguardedLiquidatedAt: number | null;
  final: { buffer: number; accountValue: number; positions: Array<{ coin: string; size: number }> };
  feesPaid: number;
}

export interface SimInput {
  policy: Policy;
  snapshot: AccountSnapshot;
  /** Marks at each step; step 0 is the start. */
  path: readonly Marks[];
  /** Time the rules see (for windows). */
  now: number;
  /** Taker fee as a fraction of notional (e.g. the user's realised rate). */
  feeRate: number;
  automationAllowed?: boolean;
}

function clone(s: AccountSnapshot): AccountSnapshot {
  return { ...s, positions: s.positions.map((p) => ({ ...p })), pools: s.pools.map((p) => ({ ...p })), idle: s.idle.map((i) => ({ ...i })) };
}

/** Moves a position by `delta` at `px`, keeping pool equity consistent with assessRisk. */
function fill(s: AccountSnapshot, coin: string, delta: number, px: number, mark: number, feeRate: number): number {
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

function apply(s: AccountSnapshot, a: GuardAction, marks: Marks, feeRate: number, resting: GuardAction[]): number {
  switch (a.type) {
    case 'order':
      return fill(s, a.coin, a.isBuy ? a.size : -a.size, a.limitPx, marks[a.coin] ?? a.limitPx, feeRate);
    case 'trigger':
      resting.splice(0, resting.length, ...resting.filter((r) => !(r.type === 'trigger' && r.coin === a.coin)), a);
      return 0;
    case 'cancel':
      return 0;
    case 'transfer': {
      const src = s.idle.find((i) => i.id === a.source);
      if (src) src.availableAtSnapshot -= a.amount;
      const from = a.source.startsWith('dex:') ? s.pools.find((p) => p.kind === 'dex' && `dex:${p.dex}` === a.source) : undefined;
      if (from) from.equityAtSnapshot -= a.amount;
      const to = s.pools.find((p) => p.kind === 'dex' && p.dex === a.toDex) ?? s.pools.find((p) => p.kind === 'token' && p.token === a.token);
      if (to) to.equityAtSnapshot += a.amount;
      return 0;
    }
    case 'isolatedMargin': {
      const p = s.positions.find((x) => x.coin === a.coin);
      if (p && p.isolatedRawUsd !== null) p.isolatedRawUsd += a.amount;
      const cross = s.pools.find((x) => x.kind !== 'isolated' && (x.dex === a.dex || x.kind === 'token'));
      if (cross) cross.equityAtSnapshot -= a.amount;
      return 0;
    }
    case 'alert':
      return 0;
  }
}

/** Drops closed positions; a closed isolated position's margin returns to its dex (cross pool or idle). */
function prune(s: AccountSnapshot) {
  for (const p of s.positions) {
    if (p.size !== 0 || p.leverageType !== 'isolated' || p.isolatedRawUsd === null) continue;
    const cross = s.pools.find((x) => x.kind === 'dex' && x.dex === p.dex) ?? s.pools.find((x) => x.kind === 'token' && x.token === p.asset.collateralToken);
    if (cross) cross.equityAtSnapshot += p.isolatedRawUsd;
    else {
      const idle = s.idle.find((i) => i.id === `dex:${p.dex}`) ?? s.idle.find((i) => i.kind === 'token' && i.token === p.asset.collateralToken);
      if (idle) idle.availableAtSnapshot += p.isolatedRawUsd;
    }
    p.isolatedRawUsd = 0;
  }
  s.positions = s.positions.filter((p) => p.size !== 0);
  s.pools = s.pools.filter((pool) => pool.kind !== 'isolated' || s.positions.some((p) => p.poolId === pool.id));
}

export function simulate(input: SimInput): SimResult {
  const { policy, path, now, feeRate } = input;
  const s = clone(input.snapshot);
  const start = path[0] ?? {};
  const baselineValue = assessRisk(s, start).accountValue;
  const baselines = Object.fromEntries(policy.rules.map((r) => [r.id, { accountValue: baselineValue, prices: { ...start } }]));
  let latched = new Set<string>();
  const resting: GuardAction[] = [];
  const steps: SimStep[] = [];
  let liquidatedAt: number | null = null;
  let feesPaid = 0;

  for (let i = 0; i < path.length && liquidatedAt === null; i++) {
    const marks = path[i]!;
    // Resting backstops fire on mark, before the guard's next look.
    for (const r of [...resting]) {
      if (r.type !== 'trigger') continue;
      const m = marks[r.coin];
      if (m === undefined) continue;
      const crossed = r.isBuy ? m >= r.triggerPx : m <= r.triggerPx;
      if (crossed) {
        const p = s.positions.find((x) => x.coin === r.coin);
        if (p) feesPaid += fill(s, r.coin, (r.isBuy ? 1 : -1) * Math.min(r.size, Math.abs(p.size)), r.limitPx, m, feeRate);
        resting.splice(resting.indexOf(r), 1);
      }
    }
    prune(s);
    const before = assessRisk(s, marks);
    if (before.pools.some((p) => p.maintenance > 0 && p.buffer <= 1)) {
      liquidatedAt = i;
      steps.push({ step: i, marks, buffer: before.worst?.buffer ?? Number.POSITIVE_INFINITY, accountValue: before.accountValue, fired: [], actions: [], liquidated: true });
      break;
    }
    const d = evaluate(policy, s, marks, { now, baselines, openOrders: [], latched, automationAllowed: input.automationAllowed ?? true, guardOwnedOids: new Set() });
    latched = d.latched;
    for (const a of d.actions) feesPaid += apply(s, a, marks, feeRate, resting);
    prune(s);
    const after = assessRisk(s, marks);
    steps.push({ step: i, marks, buffer: after.worst?.buffer ?? Number.POSITIVE_INFINITY, accountValue: after.accountValue, fired: d.fired.map((f) => f.ruleId), actions: d.actions, liquidated: false });
  }

  const unguarded = path.findIndex((m) => assessRisk(input.snapshot, m).pools.some((p) => p.maintenance > 0 && p.buffer <= 1));
  const last = assessRisk(s, path[Math.min(path.length - 1, steps.length - 1)] ?? start);
  return {
    steps,
    liquidatedAt,
    unguardedLiquidatedAt: unguarded === -1 ? null : unguarded,
    final: { buffer: last.worst?.buffer ?? Number.POSITIVE_INFINITY, accountValue: last.accountValue, positions: s.positions.map((p) => ({ coin: p.coin, size: p.size })) },
    feesPaid,
  };
}

/** A straight-line path from `from` to `from × (1 + move)` per coin over `steps` steps (step 0 = start). */
export function linearPath(from: Marks, movePct: Readonly<Record<string, number>>, steps: number): Marks[] {
  return Array.from({ length: steps + 1 }, (_, i) => Object.fromEntries(Object.entries(from).map(([c, m]) => [c, m * (1 + ((movePct[c] ?? 0) / 100) * (i / steps))])));
}

/** The first time at or after `from` (15-minute steps, up to 8 days) inside the window. */
export function nextTimeIn(window: WindowName, from: number): number | null {
  for (let t = from; t < from + 8 * 86_400_000; t += 15 * 60_000) if (windowContains(window, t)) return t;
  return null;
}
