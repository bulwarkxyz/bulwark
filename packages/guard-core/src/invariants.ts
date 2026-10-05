import type { GuardAction, GuardContext } from './evaluate.js';
import { policyHash, type Policy } from './policy.js';
import { assessRisk, type AccountRisk, type Marks } from './risk.js';
import { MIN_ORDER_NOTIONAL } from './rounding.js';
import type { AccountSnapshot } from './snapshot.js';

/**
 * Invariants checked on every action before it is signed — once here and again in the signer.
 *
 * I1 Every order is reduce-only, opposes the open position and is no larger than it.
 * I2 Nothing raises leverage or changes margin mode; isolated margin can only be added.
 * I3 Funds move only between the user's own balances, only into a pool that needs margin, and never
 *    take a source pool below the policy's highest line.
 * I4 Act only under a policy whose hash matches the user's verified signature, with the kill switch off
 *    and automation allowed for the user's region.
 * I5 Every action traces to a rule in the confirmed policy (the compile-time half is compiler-check.ts).
 * I6 At most MAX_ACTIONS_PER_MINUTE guard actions per user; orders meet the $10 minimum unless closing.
 * I7 A builder code is attached only when enabled and approved; a builder rejection is retried without it.
 */

export const MAX_ACTIONS_PER_MINUTE = 20;

export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7';

export interface Violation {
  invariant: InvariantId;
  message: string;
}

export interface ExecutionContext extends GuardContext {
  /** Hash and verification state of the user's stored confirmation signature. */
  confirmation: { policyHash: string; signatureVerified: boolean } | null;
  killSwitch: boolean;
  /** Timestamps (ms) of guard actions already sent for this user. */
  recentActions: readonly number[];
  /** Builder attached to orders, if any. */
  builder: { enabled: boolean; approvedMaxTenthsBps: number; feeTenthsBps: number } | null;
}

export interface WireBuilder {
  b: string;
  f: number;
}

const EPS = 1e-9;

export function checkAction(
  action: GuardAction & { builder?: WireBuilder | null },
  policy: Policy,
  snapshot: AccountSnapshot,
  marks: Marks | undefined,
  ctx: ExecutionContext,
  risk: AccountRisk = assessRisk(snapshot, marks),
): Violation | null {
  // I4
  if (ctx.killSwitch) return { invariant: 'I4', message: 'kill switch is on' };
  if (action.type !== 'alert') {
    if (!ctx.automationAllowed) return { invariant: 'I4', message: 'automatic action is off for this region' };
    if (!ctx.confirmation?.signatureVerified) return { invariant: 'I4', message: 'policy confirmation signature not verified' };
    if (ctx.confirmation.policyHash !== policyHash(policy)) return { invariant: 'I4', message: 'policy hash does not match the confirmed policy' };
  }

  // I5 (action-time half)
  if (!policy.rules.some((r) => r.id === action.ruleId)) return { invariant: 'I5', message: `rule ${action.ruleId} is not in the confirmed policy` };

  // I6
  if (action.type !== 'alert') {
    const recent = ctx.recentActions.filter((t) => ctx.now - t < 60_000).length;
    if (recent >= MAX_ACTIONS_PER_MINUTE) return { invariant: 'I6', message: `rate cap: ${recent} actions in the last minute` };
  }

  switch (action.type) {
    case 'alert':
      return null;

    case 'order': {
      const pos = snapshot.positions.find((p) => p.dex === action.dex && p.coin === action.coin);
      if (action.reduceOnly !== true) return { invariant: 'I1', message: 'order is not reduce-only' };
      if (action.tif !== 'Ioc') return { invariant: 'I1', message: 'guard orders must be IOC' };
      if (!pos) return { invariant: 'I1', message: `no open position on ${action.coin}` };
      if (action.isBuy !== pos.size < 0) return { invariant: 'I1', message: 'order side does not oppose the position' };
      if (!(action.size > 0) || action.size > Math.abs(pos.size) + EPS) return { invariant: 'I1', message: `size ${action.size} exceeds position ${Math.abs(pos.size)}` };
      if (action.assetId !== pos.asset.assetId) return { invariant: 'I1', message: 'asset id does not match the position' };
      const row = risk.pools.flatMap((p) => p.positions).find((r) => r.position.key === pos.key);
      const mark = row?.mark ?? pos.markAtSnapshot;
      const closes = action.size >= Math.abs(pos.size) - EPS;
      if (!closes && action.size * mark < MIN_ORDER_NOTIONAL - EPS) return { invariant: 'I6', message: 'partial order below the $10 minimum' };
      // limit price within the user's slippage, exactly
      if (Math.abs(action.limitPx - mark) / mark > policy.execution.maxSlippagePct / 100 + 1e-12) {
        return { invariant: 'I1', message: 'limit price outside your max slippage' };
      }
      // I7
      if (action.builder) {
        if (!ctx.builder?.enabled) return { invariant: 'I7', message: 'builder code attached while disabled' };
        if (action.builder.f > ctx.builder.approvedMaxTenthsBps) return { invariant: 'I7', message: 'builder fee above the user-approved maximum' };
      }
      return null;
    }

    case 'cancel': {
      const order = ctx.openOrders.find((o) => o.oid === action.oid);
      if (!order) return { invariant: 'I2', message: `order ${action.oid} is not open` };
      const own = ctx.guardOwnedOids?.has(action.oid) === true;
      if (order.reduceOnly && !own) return { invariant: 'I2', message: 'never cancel the user’s reduce-only orders' };
      return null;
    }

    case 'trigger': {
      const pos = snapshot.positions.find((p) => p.dex === action.dex && p.coin === action.coin);
      if (action.reduceOnly !== true || action.tpsl !== 'sl') return { invariant: 'I1', message: 'backstop must be a reduce-only stop' };
      if (!pos) return { invariant: 'I1', message: `no open position on ${action.coin}` };
      if (action.isBuy !== pos.size < 0) return { invariant: 'I1', message: 'backstop side does not oppose the position' };
      if (!(action.size > 0) || action.size > Math.abs(pos.size) + EPS) return { invariant: 'I1', message: 'backstop larger than the position' };
      if (action.assetId !== pos.asset.assetId) return { invariant: 'I1', message: 'asset id does not match the position' };
      const row = risk.pools.flatMap((p) => p.positions).find((r) => r.position.key === pos.key);
      const mark = row?.mark ?? pos.markAtSnapshot;
      // must sit on the losing side of the mark, or it would fire at once
      if (pos.size > 0 ? !(action.triggerPx < mark) : !(action.triggerPx > mark)) return { invariant: 'I1', message: 'backstop trigger is not on the losing side of the mark' };
      if (Math.abs(action.limitPx - action.triggerPx) / action.triggerPx > policy.execution.maxSlippagePct / 100 + 1e-12) {
        return { invariant: 'I1', message: 'backstop limit outside your max slippage' };
      }
      if (action.builder) {
        if (!ctx.builder?.enabled) return { invariant: 'I7', message: 'builder code attached while disabled' };
        if (action.builder.f > ctx.builder.approvedMaxTenthsBps) return { invariant: 'I7', message: 'builder fee above the user-approved maximum' };
      }
      return null;
    }

    case 'isolatedMargin': {
      const pos = snapshot.positions.find((p) => p.dex === action.dex && p.coin === action.coin);
      if (!pos || pos.leverageType !== 'isolated') return { invariant: 'I2', message: 'isolated margin only for isolated positions' };
      if (!(action.amount > 0)) return { invariant: 'I2', message: 'isolated margin can only be added' };
      return null;
    }

    case 'transfer': {
      if (!(action.amount > 0)) return { invariant: 'I3', message: 'transfer amount must be positive' };
      const src = risk.idle.find((s) => s.id === action.source);
      if (!src) return { invariant: 'I3', message: `unknown source ${action.source}` };
      if (action.amount > src.available + EPS) return { invariant: 'I3', message: 'transfer exceeds the source balance' };
      if (src.kind === 'dex' && src.dex === action.toDex) return { invariant: 'I3', message: 'source and destination are the same dex' };
      // destination must hold a position that needs margin
      const needs = risk.pools.some(
        (p) => (p.pool.kind === 'dex' && p.pool.dex === action.toDex) || (p.pool.kind === 'isolated' && p.pool.dex === action.toDex),
      );
      if (!needs) return { invariant: 'I3', message: `no position on ${action.toDex || 'main'} needs margin` };
      // never drain a source pool below the policy's highest line
      const lines = policy.rules.filter((r) => r.when.kind === 'buffer').map((r) => (r.when as { below: number }).below);
      const highest = lines.length ? Math.max(...lines) : 1;
      const srcPool = risk.pools.find((p) => (src.kind === 'dex' ? p.pool.kind === 'dex' && p.pool.dex === src.dex : src.kind === 'token' && p.pool.kind === 'token' && p.pool.token === src.token));
      if (srcPool && srcPool.maintenance > 0 && (srcPool.equity - action.amount) / srcPool.maintenance < highest - EPS) {
        return { invariant: 'I3', message: 'transfer would take the source below your highest line' };
      }
      return null;
    }
  }
}

/** Splits a decision's actions into those that pass every invariant and those that do not. */
export function gate(
  actions: ReadonlyArray<GuardAction & { builder?: WireBuilder | null }>,
  policy: Policy,
  snapshot: AccountSnapshot,
  marks: Marks | undefined,
  ctx: ExecutionContext,
): { approved: GuardAction[]; rejected: Array<{ action: GuardAction; violation: Violation }> } {
  const risk = assessRisk(snapshot, marks);
  const approved: GuardAction[] = [];
  const rejected: Array<{ action: GuardAction; violation: Violation }> = [];
  const sent = [...ctx.recentActions];
  for (const action of actions) {
    const v = checkAction(action, policy, snapshot, marks, { ...ctx, recentActions: sent }, risk);
    if (v) rejected.push({ action, violation: v });
    else {
      approved.push(action);
      if (action.type !== 'alert') sent.push(ctx.now);
    }
  }
  return { approved, rejected };
}

/** I7: the exchange's error when an order carries a builder the user has not approved. */
export function isBuilderRejection(message: string): boolean {
  return /builder fee has not been approved|builder has insufficient balance/i.test(message);
}
