import type { Action, Policy, Rule, Target, Trigger } from './policy.js';
import { assessRisk, markOf, positionLeverage, type AccountRisk, type Marks, type PoolRisk, type PositionRisk } from './risk.js';
import { MIN_ORDER_NOTIONAL, ceilSize, floorSize, roundPrice } from './rounding.js';
import type { AccountSnapshot, IdleSource } from './snapshot.js';
import { windowContains } from './windows.js';

/** A resting order of the user's, as returned by `frontendOpenOrders`. */
export interface OpenOrder {
  coin: string;
  oid: number;
  /** `B` buy, `A` sell. */
  side: 'B' | 'A';
  reduceOnly: boolean;
  isTrigger: boolean;
  /** Present on trigger orders. */
  triggerPx?: number;
  /** Remaining size (absolute). */
  size?: number;
}

export interface GuardContext {
  now: number;
  /** Values captured when a rule's baseline started (window start or confirmation), keyed by rule id. */
  baselines: Readonly<Record<string, { accountValue?: number; prices?: Readonly<Record<string, number>> }>>;
  openOrders: readonly OpenOrder[];
  /** Fire keys (`ruleId@scope`) that already fired and have not re-armed. */
  latched: ReadonlySet<string>;
  /** False for regions where automatic action is off (EU, decision D4): actions become alerts. */
  automationAllowed: boolean;
  /**
   * Order ids the guard itself placed (from its own records, never inferred from a client order id,
   * which anyone can set). Only these reduce-only orders may be cancelled by the guard.
   */
  guardOwnedOids?: ReadonlySet<number>;
}

interface Base {
  ruleId: string;
  reason: string;
}

export type GuardAction =
  | (Base & { type: 'cancel'; dex: string; coin: string; oid: number })
  | (Base & {
      type: 'order';
      dex: string;
      coin: string;
      assetId: number;
      isBuy: boolean;
      size: number;
      limitPx: number;
      reduceOnly: true;
      tif: 'Ioc';
      /** True when the order closes the whole position. */
      closesPosition: boolean;
    })
  | (Base & {
      /** A reduce-only stop resting on the exchange that fires on mark even if Bulwark is unreachable. */
      type: 'trigger';
      dex: string;
      coin: string;
      assetId: number;
      isBuy: boolean;
      size: number;
      triggerPx: number;
      limitPx: number;
      reduceOnly: true;
      tpsl: 'sl';
    })
  | (Base & { type: 'transfer'; source: IdleSource['id']; toDex: string; amount: number; token: number })
  | (Base & { type: 'isolatedMargin'; dex: string; coin: string; assetId: number; amount: number })
  | (Base & { type: 'alert'; level: 'info' | 'warn' | 'critical' });

export interface Decision {
  risk: AccountRisk;
  fired: Array<{ key: string; ruleId: string; reason: string }>;
  actions: GuardAction[];
  /** The latch set to carry into the next evaluation. */
  latched: Set<string>;
}

interface Scope {
  id: string;
  pools: PoolRisk[];
}

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : '∞';
}

/** Which pools a rule's trigger fires on right now, with a human-readable reason per scope. */
function firing(trigger: Trigger, rule: Rule, risk: AccountRisk, ctx: GuardContext): Array<{ scope: Scope; reason: string }> {
  switch (trigger.kind) {
    case 'buffer':
      return risk.pools
        .filter((p) => p.maintenance > 0 && p.buffer < trigger.below)
        .map((p) => ({ scope: { id: p.pool.id, pools: [p] }, reason: `buffer ${fmt(p.buffer)}× below your ${trigger.below}× line` }));
    case 'drawdown': {
      const base = ctx.baselines[rule.id]?.accountValue;
      if (!(base && base > 0)) return [];
      const dd = ((base - risk.accountValue) / base) * 100;
      return dd >= trigger.atLeastPct ? [{ scope: { id: 'account', pools: risk.pools }, reason: `account down ${fmt(dd)}% (your limit ${trigger.atLeastPct}%)` }] : [];
    }
    case 'priceMove': {
      const ref = ctx.baselines[rule.id]?.prices?.[trigger.market];
      const pool = risk.pools.find((p) => p.positions.some((r) => r.position.coin === trigger.market));
      const row = pool?.positions.find((r) => r.position.coin === trigger.market);
      if (!ref || !pool || !row) return [];
      const move = ((row.mark - ref) / ref) * 100;
      const hit = trigger.direction === 'down' ? -move >= trigger.movePct : move >= trigger.movePct;
      return hit ? [{ scope: { id: pool.pool.id, pools: [pool] }, reason: `${trigger.market} ${move >= 0 ? '+' : ''}${fmt(move)}% (your line ${trigger.direction === 'down' ? '−' : '+'}${trigger.movePct}%)` }] : [];
    }
    case 'leverageAbove': {
      const lev = positionLeverage(risk, trigger.market);
      const pool = risk.pools.find((p) => p.positions.some((r) => r.position.coin === trigger.market));
      if (lev === null || !pool || lev <= trigger.leverage) return [];
      return [{ scope: { id: pool.pool.id, pools: [pool] }, reason: `${trigger.market} at ${fmt(lev, 1)}× (your cap ${trigger.leverage}×)` }];
    }
  }
}

function targets(target: Target, pools: PoolRisk[]): PositionRisk[] {
  const out: PositionRisk[] = [];
  for (const pool of pools) {
    const rows = pool.positions;
    if (rows.length === 0) continue;
    switch (target.kind) {
      case 'all':
        out.push(...rows);
        break;
      case 'market':
        out.push(...rows.filter((r) => r.position.coin === target.market));
        break;
      case 'worst_pnl':
        out.push([...rows].sort((a, b) => a.unrealizedPnl - b.unrealizedPnl)[0] as PositionRisk);
        break;
      case 'first_position':
        out.push([...rows].sort((a, b) => b.maintenance - a.maintenance || a.unrealizedPnl - b.unrealizedPnl)[0] as PositionRisk);
        break;
    }
  }
  return out;
}

/** Size to sell/buy back, respecting lot size and the $10 minimum (a too-small trim becomes the minimum or a full close). */
function sizedOrder(row: PositionRisk, wanted: number, slipPct: number, rule: Rule, reason: string, rounding: 'floor' | 'ceil' = 'floor'): GuardAction | null {
  const p = row.position;
  const full = Math.abs(p.size);
  const d = p.asset.szDecimals;
  // A fraction the user typed rounds down to the lot; "back to a line" targets round up so the line is reached.
  let size = Math.min(full, rounding === 'ceil' ? ceilSize(wanted, d) : floorSize(wanted, d));
  if (size * row.mark < MIN_ORDER_NOTIONAL && size < full) {
    size = Math.min(full, ceilSize(MIN_ORDER_NOTIONAL / row.mark, d));
  }
  if (!(size > 0)) return null;
  const closes = size >= full - 1e-12;
  if (!closes && size * row.mark < MIN_ORDER_NOTIONAL) size = full; // remaining too small to leave a valid partial
  const isBuy = p.size < 0;
  const raw = isBuy ? row.mark * (1 + slipPct / 100) : row.mark * (1 - slipPct / 100);
  // Round outward to the tick (more likely to fill); if the tick is coarse enough to cross the user's
  // slippage, round inward instead — the order may not fill, but it never exceeds what the user allowed.
  const within = (px: number) => Math.abs(px - row.mark) / row.mark <= slipPct / 100 + 1e-12;
  let limitPx = roundPrice(raw, d, isBuy ? 'up' : 'down');
  if (!within(limitPx)) limitPx = roundPrice(raw, d, isBuy ? 'down' : 'up');
  if (!within(limitPx)) {
    return { type: 'alert', ruleId: rule.id, reason: `${reason}; no ${p.coin} price within your ${slipPct}% slippage at this tick size — act manually`, level: 'critical' };
  }
  return {
    type: 'order',
    ruleId: rule.id,
    reason,
    dex: p.dex,
    coin: p.coin,
    assetId: p.asset.assetId,
    isBuy,
    size: size >= full - 1e-12 ? full : size,
    limitPx,
    reduceOnly: true,
    tif: 'Ioc',
    closesPosition: size >= full - 1e-12,
  };
}

/** Greedy trim, largest maintenance first, until the pool buffer reaches `line` after slippage. */
function reduceToBuffer(pool: PoolRisk, line: number, slipPct: number, rule: Rule, reason: string): GuardAction[] {
  const out: GuardAction[] = [];
  let equity = pool.equity;
  let maintenance = pool.maintenance;
  const sigma = slipPct / 100;
  for (const row of [...pool.positions].sort((a, b) => b.maintenance - a.maintenance)) {
    if (maintenance <= 0 || equity / maintenance >= line) break;
    const full = Math.abs(row.position.size);
    const rate = row.maintenance / row.notional; // effective maintenance rate of this position
    const per = row.mark * (rate - sigma / line); // buffer gained per unit size
    let size = per > 0 ? (maintenance - equity / line) / per : full;
    size = Math.min(full, Math.max(0, size));
    const order = sizedOrder(row, size, slipPct, rule, reason, 'ceil');
    if (!order) continue;
    out.push(order);
    if (order.type !== 'order') continue;
    maintenance -= order.size * row.mark * rate;
    equity -= order.size * row.mark * sigma;
  }
  return out;
}

function reduceToLeverage(pool: PoolRisk, coin: string, cap: number, slipPct: number, rule: Rule, reason: string): GuardAction[] {
  const row = pool.positions.find((r) => r.position.coin === coin);
  if (!row) return [];
  const sigma = slipPct / 100;
  const excess = row.notional - cap * pool.equity;
  if (excess <= 0) return [];
  const denom = row.mark * (1 - cap * sigma);
  const size = denom > 0 ? excess / denom : Math.abs(row.position.size);
  const order = sizedOrder(row, size, slipPct, rule, reason, 'ceil');
  return order ? [order] : [];
}

/** Top-up into a pool from the user's own idle balances. Never drains a source pool below the policy's highest line. */
function topUp(pool: PoolRisk, maxUsdc: number, line: number | null, risk: AccountRisk, highestLine: number, rule: Rule, reason: string): GuardAction[] {
  const needed = line !== null ? Math.max(0, line * pool.maintenance - pool.equity) : maxUsdc;
  let want = Math.min(maxUsdc, needed);
  if (!(want > 0)) return [];
  const out: GuardAction[] = [];

  const sourceRoom = (src: AccountRisk['idle'][number]): number => {
    if (src.kind === 'spot') return src.available;
    const srcPool = risk.pools.find((p) => (src.kind === 'dex' ? p.pool.kind === 'dex' && p.pool.dex === src.dex : p.pool.kind === 'token' && p.pool.token === src.token));
    if (!srcPool || srcPool.maintenance === 0) return src.available;
    // keep the source pool at or above the highest stage line
    return Math.max(0, Math.min(src.available, srcPool.equity - highestLine * srcPool.maintenance));
  };

  if (pool.pool.kind === 'isolated') {
    const row = pool.positions[0];
    if (!row) return [];
    const dex = row.position.dex;
    // Isolated margin is drawn from the dex's cross balance (standard) or the token balance (unified).
    const local = risk.idle.find((s) => (risk.mode === 'unified' ? s.kind === 'token' : s.kind === 'dex' && s.dex === dex));
    let localRoom = local ? sourceRoom(local) : 0;
    if (risk.mode === 'standard' && localRoom < want) {
      for (const src of risk.idle.filter((s) => !(s.kind === 'dex' && s.dex === dex))) {
        const amt = round2down(Math.min(want - localRoom, sourceRoom(src)));
        if (amt <= 0) continue;
        out.push({ type: 'transfer', ruleId: rule.id, reason, source: src.id, toDex: dex, amount: amt, token: src.token });
        localRoom += amt;
      }
    }
    want = round2down(Math.min(want, localRoom));
    if (want > 0) out.push({ type: 'isolatedMargin', ruleId: rule.id, reason, dex, coin: row.position.coin, assetId: row.position.asset.assetId, amount: want });
    return out;
  }

  if (pool.pool.kind === 'dex') {
    for (const src of risk.idle.filter((s) => !(s.kind === 'dex' && s.dex === pool.pool.dex))) {
      if (want <= 0) break;
      const amt = round2down(Math.min(want, sourceRoom(src)));
      if (amt <= 0) continue;
      out.push({ type: 'transfer', ruleId: rule.id, reason, source: src.id, toDex: pool.pool.dex as string, amount: amt, token: src.token });
      want -= amt;
    }
    return out;
  }

  // Unified token pool: every cross position already shares the whole balance; nothing to move.
  return [{ type: 'alert', ruleId: rule.id, reason: `${reason}; unified account already uses your whole balance, so there is nothing to top up from`, level: 'warn' }];
}

const round2down = (x: number) => Math.floor(x * 100 + 1e-9) / 100;

function translate(action: Action, rule: Rule, scope: Scope, reason: string, risk: AccountRisk, policy: Policy, ctx: GuardContext, highestLine: number): GuardAction[] {
  const slip = policy.execution.maxSlippagePct;
  const line = rule.when.kind === 'buffer' ? rule.when.below : null;
  switch (action.kind) {
    case 'reduce':
      return targets(action.target, scope.pools).flatMap((row) => {
        const o = sizedOrder(row, Math.abs(row.position.size) * action.fraction, slip, rule, reason);
        return o ? [o] : [];
      });
    case 'close':
      return targets(action.target, scope.pools).flatMap((row) => {
        const o = sizedOrder(row, Math.abs(row.position.size), slip, rule, reason);
        return o ? [o] : [];
      });
    case 'reduceToBuffer':
      return scope.pools.flatMap((p) => reduceToBuffer(p, action.buffer, slip, rule, reason));
    case 'reduceToLeverage':
      return scope.pools.flatMap((p) => reduceToLeverage(p, action.market, action.leverage, slip, rule, reason));
    case 'topUp':
      return scope.pools.flatMap((p) => topUp(p, action.maxUsdc, line, risk, highestLine, rule, reason));
    case 'cancelOpeningOrders': {
      const coins = new Set(scope.pools.flatMap((p) => p.positions.map((r) => r.position.coin)));
      const dexOf = (coin: string) => (coin.includes(':') ? (coin.split(':')[0] as string) : '');
      return ctx.openOrders
        .filter((o) => !o.reduceOnly && (scope.id === 'account' || coins.has(o.coin)))
        .map((o) => ({ type: 'cancel' as const, ruleId: rule.id, reason, dex: dexOf(o.coin), coin: o.coin, oid: o.oid }));
    }
    case 'alert':
      return [{ type: 'alert', ruleId: rule.id, reason, level: 'warn' }];
  }
}

/** Keeps the strictest of overlapping actions: the largest order per position, the largest top-up per destination. */
function merge(actions: GuardAction[]): GuardAction[] {
  const orders = new Map<string, Extract<GuardAction, { type: 'order' }>>();
  const transfers = new Map<string, Extract<GuardAction, { type: 'transfer' }>>();
  const isolated = new Map<string, Extract<GuardAction, { type: 'isolatedMargin' }>>();
  const cancels = new Map<number, Extract<GuardAction, { type: 'cancel' }>>();
  const alerts: GuardAction[] = [];
  for (const a of actions) {
    if (a.type === 'order') {
      const k = `${a.dex}|${a.coin}`;
      const prev = orders.get(k);
      if (!prev || a.size > prev.size) orders.set(k, a);
    } else if (a.type === 'transfer') {
      const k = `${a.source}>${a.toDex}`;
      const prev = transfers.get(k);
      if (!prev || a.amount > prev.amount) transfers.set(k, a);
    } else if (a.type === 'isolatedMargin') {
      const k = `${a.dex}|${a.coin}`;
      const prev = isolated.get(k);
      if (!prev || a.amount > prev.amount) isolated.set(k, a);
    } else if (a.type === 'cancel') {
      cancels.set(a.oid, a);
    } else alerts.push(a);
  }
  // Orders on a position that will be fully closed make its top-ups pointless.
  const closing = new Set([...orders.values()].filter((o) => o.closesPosition).map((o) => `${o.dex}|${o.coin}`));
  for (const k of closing) isolated.delete(k);
  // Execution order: cancels (prioritised by the exchange), then margin, then reduce-only orders.
  return [...cancels.values(), ...transfers.values(), ...isolated.values(), ...orders.values(), ...alerts];
}

export function evaluate(policy: Policy, snapshot: AccountSnapshot, marks: Marks | undefined, ctx: GuardContext): Decision {
  const risk = assessRisk(snapshot, marks);
  const latched = new Set(ctx.latched);
  const fired: Decision['fired'] = [];
  const raw: GuardAction[] = [];
  if (!risk.supported) return { risk, fired, actions: [], latched };

  const lines = policy.rules.filter((r) => r.when.kind === 'buffer').map((r) => (r.when as { below: number }).below);
  const highestLine = lines.length ? Math.max(...lines) : 1;

  for (const rule of policy.rules) {
    const active = rule.window === undefined || windowContains(rule.window, ctx.now);
    const hits = active ? firing(rule.when, rule, risk, ctx) : [];
    const hitKeys = new Set(hits.map((h) => `${rule.id}@${h.scope.id}`));
    // Re-arm keys whose condition has cleared.
    for (const key of [...latched]) if (key.startsWith(`${rule.id}@`) && !hitKeys.has(key)) latched.delete(key);
    for (const hit of hits) {
      const key = `${rule.id}@${hit.scope.id}`;
      if (latched.has(key)) continue;
      latched.add(key);
      fired.push({ key, ruleId: rule.id, reason: hit.reason });
      for (const action of rule.then) raw.push(...translate(action, rule, hit.scope, hit.reason, risk, policy, ctx, highestLine));
    }
  }

  let actions = merge(raw);
  if (!ctx.automationAllowed) {
    // Decision D4: where automatic action is off, each fired rule becomes one alert.
    const seen = new Set<string>();
    actions = actions.flatMap((a): GuardAction[] => {
      if (a.type === 'alert') return [a];
      if (seen.has(a.ruleId)) return [];
      seen.add(a.ruleId);
      return [{ type: 'alert', ruleId: a.ruleId, reason: `${a.reason} — automatic action is off in your region; act manually`, level: 'critical' }];
    });
  }
  return { risk, fired, actions, latched };
}

export { markOf };
