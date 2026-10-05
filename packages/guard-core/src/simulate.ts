import { planBackstops } from './backstop.js';
import { evaluate, type Decision, type GuardAction } from './evaluate.js';
import { MAX_ACTIONS_PER_MINUTE } from './invariants.js';
import type { Policy } from './policy.js';
import { planRetries, positionKey, recordFill, type RetryChain } from './retry.js';
import { assessRisk, type Marks } from './risk.js';
import type { AccountSnapshot } from './snapshot.js';
import { clone, fill } from './sim-state.js';
import { planStageTriggers } from './stage-triggers.js';
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
  /** Guard IOC orders that reached the exchange after the price had moved past their limit. */
  missedOrders: number;
  /** Retry orders sent for earlier orders that did not fully fill. */
  retryOrders: number;
  /** Step of the first "cannot fill within your slippage" alert, or null. */
  retryAlertAt: number | null;
  /** Actions held back by the I6 rate cap (only counted when `stepMs` is set). */
  rateCapped: number;
  /** Resting exchange orders (backstops, stage triggers) that fired and filled. */
  triggerFills: number;
  /** Stage triggers that fired but could not fill within the exchange's 10% market-trigger tolerance. */
  triggerMisses: number;
  /** Times the guard re-placed its resting orders. */
  resyncs: number;
  /** Every fill and missed order, in order (for tracing a run). */
  events: Array<{ step: number; kind: 'server' | 'backstop' | 'stage' | 'missed' | 'stage-missed'; coin: string; size: number; px: number; mark: number }>;
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
  /**
   * Congestion model: the guard's actions reach the exchange this many path steps after they were
   * decided. A delayed IOC fills (at its limit price) only if the mark is still within its limit;
   * otherwise it is missed. As in the worker, which runs one evaluation per account at a time and
   * waits for the exchange's answer, the guard does not evaluate again while actions are in flight
   * (backstops and liquidation are still checked every step). 0 = immediate.
   */
  delaySteps?: number;
  /** Retry orders that did not fully fill while their stage still holds (the guard's behaviour). Default true. */
  retry?: boolean;
  /** Length of one path step in ms. When set, the I6 cap (actions per minute) is applied. */
  stepMs?: number;
  /**
   * The live guard's resting backstop: a reduce-only stop on the exchange at the lowest line, as a
   * limit at the user's slippage (planBackstops). Once triggered it rests as a limit order and fills
   * only when the mark is back within its limit. Re-placed `delaySteps` after positions or latches change.
   */
  backstops?: boolean;
  /** How the backstop is priced in pools with several positions (default 'single'). */
  backstopPricing?: 'single' | 'together';
  /**
   * EXPERIMENTAL: every buffer stage as a resting reduce-only market trigger (planStageTriggers),
   * fired by the exchange on the mark. Fill model (conservative): at the mark of the first round at or
   * past the trigger, worse by `gapPct`; if that is worse than the trigger by more than
   * `tolerancePct` (Hyperliquid's market-trigger tolerance, 10%), it does not fill.
   */
  stageTriggers?: { gapPct: number; tolerancePct?: number; /** Fill gap assumed when pricing lower stages (default `gapPct`). */ planGapPct?: number };
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
  let breaches: Decision['breaches'] = {};
  let fires: Decision['fires'] = {};
  const resting: GuardAction[] = [];
  const steps: SimStep[] = [];
  let liquidatedAt: number | null = null;
  let feesPaid = 0;
  let missedOrders = 0;
  const delay = Math.max(0, Math.floor(input.delaySteps ?? 0));
  const pending: Array<{ due: number; action: GuardAction }> = [];
  const retry = input.retry ?? true;
  let chains: RetryChain[] = [];
  const inFlight = new Set<string>();
  let retryOrders = 0;
  let retryAlertAt: number | null = null;
  let rateCapped = 0;
  const sentAt: number[] = [];
  // Resting exchange orders (backstop, stage triggers) and their re-sync by the server.
  type Rest = { kind: 'backstop' | 'stage'; coin: string; isBuy: boolean; size: number; triggerPx: number; limitPx?: number; key?: string; triggered?: boolean };
  const exchangeModel = Boolean(input.backstops || input.stageTriggers);
  let exchange: Rest[] = [];
  let resyncDue: number | null = exchangeModel ? 0 : null;
  let triggerFills = 0;
  let triggerMisses = 0;
  let resyncs = 0;
  const events: SimResult['events'] = [];
  const scheduleResync = (i: number) => {
    if (exchangeModel && resyncDue === null) resyncDue = i + delay;
  };
  const resync = (marks: Marks) => {
    const fresh: Rest[] = [];
    if (input.stageTriggers) for (const t of planStageTriggers(policy, s, marks, { latched, gapPct: input.stageTriggers.planGapPct ?? input.stageTriggers.gapPct, now })) fresh.push({ kind: 'stage', ...t });
    if (input.backstops) for (const b of planBackstops(policy, s, marks, [], input.backstopPricing ?? 'single').place) fresh.push({ kind: 'backstop', coin: b.coin, isBuy: b.isBuy, size: b.size, triggerPx: b.triggerPx, limitPx: b.limitPx });
    exchange = [...exchange.filter((r) => r.triggered), ...fresh]; // a triggered limit is already on the book
    resyncs++;
  };
  const settle = (a: GuardAction, filled: number, i: number) => {
    if (a.type !== 'order') return;
    inFlight.delete(positionKey(a.dex, a.coin));
    if (retry) chains = recordFill(chains, a, filled, i);
  };

  for (let i = 0; i < path.length && liquidatedAt === null; i++) {
    const marks = path[i]!;
    // Delayed actions reach the exchange now; an IOC whose limit the mark has passed does not fill.
    for (const p of pending.filter((x) => x.due <= i)) {
      pending.splice(pending.indexOf(p), 1);
      const a = p.action;
      if (a.type === 'order') {
        const m = marks[a.coin];
        const fillable = m !== undefined && (a.isBuy ? m <= a.limitPx : m >= a.limitPx);
        const pos = s.positions.find((x) => x.coin === a.coin);
        if (!fillable || !pos) {
          missedOrders++;
          events.push({ step: i, kind: 'missed', coin: a.coin, size: a.size, px: a.limitPx, mark: m ?? NaN });
          settle(a, 0, i);
          continue;
        }
        const size = Math.min(a.size, Math.abs(pos.size));
        feesPaid += fill(s, a.coin, (a.isBuy ? 1 : -1) * size, a.limitPx, m, feeRate);
        events.push({ step: i, kind: 'server', coin: a.coin, size, px: a.limitPx, mark: m });
        settle(a, size, i);
        scheduleResync(i); // positions changed: the server re-prices its resting orders (late, like everything it sends)
      } else if (a.type === 'transfer') {
        const src = s.idle.find((x) => x.id === a.source);
        const amount = Math.min(a.amount, Math.max(0, src?.availableAtSnapshot ?? a.amount));
        if (amount > 0) feesPaid += apply(s, { ...a, amount }, marks, feeRate, resting);
        if (amount > 0) scheduleResync(i);
      } else {
        feesPaid += apply(s, a, marks, feeRate, resting);
      }
    }
    // Resting exchange orders fire on the mark, before the guard's next look; most protective first.
    for (const r of [...exchange].sort((a, b) => (a.isBuy ? a.triggerPx - b.triggerPx : b.triggerPx - a.triggerPx))) {
      const m = marks[r.coin];
      const pos = s.positions.find((x) => x.coin === r.coin);
      if (m === undefined) continue;
      if (!pos) {
        exchange.splice(exchange.indexOf(r), 1);
        continue;
      }
      if (!r.triggered && !(r.isBuy ? m >= r.triggerPx : m <= r.triggerPx)) continue;
      if (r.kind === 'stage') {
        const { gapPct, tolerancePct = 10 } = input.stageTriggers!;
        const px = r.isBuy ? m * (1 + gapPct / 100) : m * (1 - gapPct / 100);
        const bound = r.isBuy ? r.triggerPx * (1 + tolerancePct / 100) : r.triggerPx * (1 - tolerancePct / 100);
        exchange.splice(exchange.indexOf(r), 1);
        scheduleResync(i);
        if (r.isBuy ? px > bound : px < bound) {
          triggerMisses++; // the stage did not act: the server sees its line crossed and acts as the second line
          events.push({ step: i, kind: 'stage-missed', coin: r.coin, size: r.size, px, mark: m });
          continue;
        }
        const size = Math.min(r.size, Math.abs(pos.size));
        feesPaid += fill(s, r.coin, (r.isBuy ? 1 : -1) * size, px, m, feeRate);
        events.push({ step: i, kind: 'stage', coin: r.coin, size, px, mark: m });
        latched.add(r.key as string);
        triggerFills++;
      } else {
        r.triggered = true;
        if (!(r.isBuy ? m <= (r.limitPx as number) : m >= (r.limitPx as number))) continue; // rests as a limit below the market
        const size = Math.min(r.size, Math.abs(pos.size));
        feesPaid += fill(s, r.coin, (r.isBuy ? 1 : -1) * size, r.limitPx as number, m, feeRate);
        events.push({ step: i, kind: 'backstop', coin: r.coin, size, px: r.limitPx as number, mark: m });
        exchange.splice(exchange.indexOf(r), 1);
        triggerFills++;
        scheduleResync(i);
      }
    }
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
    if (pending.length) {
      // The server's re-sync of resting orders lands when due (its lateness is already in `resyncDue`).
      if (resyncDue !== null && i >= resyncDue) {
        resyncDue = null;
        resync(marks);
      }
      // Waiting for the exchange's answer: no new decision until it arrives.
      const now_ = assessRisk(s, marks);
      steps.push({ step: i, marks, buffer: now_.worst?.buffer ?? Number.POSITIVE_INFINITY, accountValue: now_.accountValue, fired: [], actions: [], liquidated: false });
      continue;
    }
    // Rule time advances with the path (for "at most N times in H hours" limits).
    const t = now + (input.stepMs ? i * input.stepMs : 0);
    const d = evaluate(policy, s, marks, { now: t, baselines, openOrders: [], latched, breaches, fires, automationAllowed: input.automationAllowed ?? true, guardOwnedOids: new Set() });
    breaches = d.breaches;
    fires = d.fires;
    if ([...d.latched].sort().join() !== [...latched].sort().join()) scheduleResync(i);
    latched = d.latched;
    let actions = d.actions;
    if (retry) {
      const planned = planRetries(d, chains, { slippagePct: policy.execution.maxSlippagePct, automationAllowed: input.automationAllowed ?? true, inFlight });
      actions = planned.actions;
      chains = planned.chains;
      retryOrders += actions.filter((a) => a.type === 'order' && (a.attempt ?? 1) > 1).length;
      if (retryAlertAt === null && actions.some((a) => a.type === 'alert' && a.level === 'critical' && a.reason.includes('cannot fill'))) retryAlertAt = i;
    }
    for (const a of actions) {
      if (a.type === 'alert') continue;
      if (input.stepMs) {
        // I6: at most MAX_ACTIONS_PER_MINUTE guard actions in any minute; a capped order counts as unfilled.
        const t = i * input.stepMs;
        while (sentAt.length && sentAt[0]! <= t - 60_000) sentAt.shift();
        if (sentAt.length >= MAX_ACTIONS_PER_MINUTE) {
          rateCapped++;
          settle(a, 0, i);
          continue;
        }
        sentAt.push(t);
      }
      if (delay) {
        pending.push({ due: i + delay, action: a });
        if (a.type === 'order') inFlight.add(positionKey(a.dex, a.coin));
      } else {
        feesPaid += apply(s, a, marks, feeRate, resting);
        if (a.type === 'order') {
          settle(a, a.size, i);
          events.push({ step: i, kind: 'server', coin: a.coin, size: a.size, px: a.limitPx, mark: marks[a.coin] ?? NaN });
        }
      }
      if (a.type === 'order' || a.type === 'transfer' || a.type === 'isolatedMargin') scheduleResync(i);
    }
    prune(s);
    if (resyncDue !== null && i >= resyncDue) {
      resyncDue = null;
      resync(marks);
    }
    const after = assessRisk(s, marks);
    steps.push({ step: i, marks, buffer: after.worst?.buffer ?? Number.POSITIVE_INFINITY, accountValue: after.accountValue, fired: d.fired.map((f) => f.ruleId), actions, liquidated: false });
  }

  const unguarded = path.findIndex((m) => assessRisk(input.snapshot, m).pools.some((p) => p.maintenance > 0 && p.buffer <= 1));
  const last = assessRisk(s, path[Math.min(path.length - 1, steps.length - 1)] ?? start);
  return {
    steps,
    liquidatedAt,
    unguardedLiquidatedAt: unguarded === -1 ? null : unguarded,
    final: { buffer: last.worst?.buffer ?? Number.POSITIVE_INFINITY, accountValue: last.accountValue, positions: s.positions.map((p) => ({ coin: p.coin, size: p.size })) },
    feesPaid,
    missedOrders,
    retryOrders,
    retryAlertAt,
    rateCapped,
    triggerFills,
    triggerMisses,
    resyncs,
    events,
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
