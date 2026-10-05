import { sizedOrder, type Decision, type GuardAction } from './evaluate.js';

/**
 * Retries for guard orders that did not fill, or filled only partly.
 *
 * A stage's fire key stays latched while its condition holds, so without retries an IOC that missed
 * (the price ran past the user's slippage before it reached the book) left that stage done for the
 * whole breach. A retry chain keeps the unfilled size and re-sends it on each later evaluation while
 * one of the stages that wanted it still holds:
 * - every retry is a fresh reduce-only IOC priced from the current mark at the user's slippage
 *   (`sizedOrder`), never wider, and goes through the same gate (I1–I7, including the rate cap);
 * - it never exceeds the position, or the size still unfilled;
 * - after `RETRY_ALERT_AFTER` attempts that did not fully fill, a critical alert says so, and the
 *   guard keeps trying.
 * Both functions are pure; the worker and the simulator keep the chains between evaluations.
 */

/** Attempts that did not fully fill before the guard raises a critical alert (it keeps trying). */
export const RETRY_ALERT_AFTER = 3;

type OrderAction = Extract<GuardAction, { type: 'order' }>;

export interface RetryChain {
  /** Fire keys (`ruleId@scope`) of the stages that wanted the order; retried while any still holds. */
  keys: string[];
  ruleId: string;
  /** The stage's reason when it fired. */
  reason: string;
  dex: string;
  coin: string;
  isBuy: boolean;
  /** Size not yet filled. */
  remaining: number;
  /** Attempts so far that did not fully fill. */
  failures: number;
  /** When the last attempt was sent. */
  lastAttemptAt: number;
  /** The critical alert for this chain has been raised. */
  alerted: boolean;
}

export interface RetryOptions {
  slippagePct: number;
  /** False where automatic action is off or the user stopped the guard: chains are dropped. */
  automationAllowed: boolean;
  alertAfter?: number;
  /**
   * Time of the account state the decision was made from. A chain is retried only from state newer
   * than its last attempt, so a fill not yet visible in the state can never be sent twice.
   */
  stateAt?: number;
  /** Positions (`dex|coin`) with an order still on its way to the exchange: not retried this time. */
  inFlight?: ReadonlySet<string>;
}

export const positionKey = (dex: string, coin: string) => `${dex}|${coin}`;

/**
 * Adds retry orders to a decision's actions. A retry and a new order for the same position merge
 * into the larger one (like overlapping stages do), keeping both stages' keys.
 */
export function planRetries(decision: Decision, chains: readonly RetryChain[], opts: RetryOptions): { actions: GuardAction[]; chains: RetryChain[] } {
  if (!opts.automationAllowed) return { actions: decision.actions, chains: [] };
  const alertAfter = opts.alertAfter ?? RETRY_ALERT_AFTER;
  const actions = [...decision.actions];
  const alerts: GuardAction[] = [];
  const kept: RetryChain[] = [];
  const rows = decision.risk.pools.flatMap((p) => p.positions);

  for (const c of chains) {
    const keys = c.keys.filter((k) => decision.active.has(k));
    if (keys.length === 0) continue; // the stage's condition has cleared: nothing left to retry
    const row = rows.find((r) => r.position.dex === c.dex && r.position.coin === c.coin);
    if (!row || row.position.size < 0 !== c.isBuy) continue; // position closed
    const chain: RetryChain = { ...c, keys };
    kept.push(chain);
    const pk = positionKey(c.dex, c.coin);
    if (opts.inFlight?.has(pk)) continue;
    if (opts.stateAt !== undefined && opts.stateAt <= c.lastAttemptAt) continue;

    const reason = `${c.reason}; retry ${c.failures}: the last order did not fully fill`;
    const o = sizedOrder(row, Math.min(c.remaining, Math.abs(row.position.size)), opts.slippagePct, { id: c.ruleId }, reason, 'ceil');
    if (!o) continue;
    if (o.type !== 'order') {
      // No price within the slippage at this tick size: nothing can be sent; counts as an attempt.
      chain.failures += 1;
      continue;
    }
    const retry: OrderAction = { ...o, keys, attempt: c.failures + 1 };
    const i = actions.findIndex((a) => a.type === 'order' && a.dex === c.dex && a.coin === c.coin);
    if (i === -1) {
      const firstAlert = actions.findIndex((a) => a.type === 'alert');
      actions.splice(firstAlert === -1 ? actions.length : firstAlert, 0, retry);
    } else {
      const fresh = actions[i] as OrderAction;
      const union = [...new Set([...(fresh.keys ?? []), ...keys])];
      actions[i] = retry.size > fresh.size ? { ...retry, keys: union } : { ...fresh, keys: union };
    }
  }

  for (const chain of kept) {
    if (chain.alerted || chain.failures < alertAfter) continue;
    chain.alerted = true;
    alerts.push({
      type: 'alert',
      level: 'critical',
      ruleId: chain.ruleId,
      reason: `${chain.reason}. The guard has tried ${chain.failures} times and cannot fill ${chain.coin} within your ${opts.slippagePct}% slippage. It keeps trying while this holds; you may want to act yourself.`,
    });
  }
  return { actions: [...actions, ...alerts], chains: kept };
}

/** Records the result of one order attempt: a full fill ends its chain, anything less continues it. */
export function recordFill(chains: readonly RetryChain[], order: OrderAction, filled: number, at: number): RetryChain[] {
  const pk = positionKey(order.dex, order.coin);
  const prior = chains.find((c) => positionKey(c.dex, c.coin) === pk);
  const rest = chains.filter((c) => c !== prior);
  if (!order.keys?.length) return [...chains];
  const remaining = order.size - Math.max(0, filled);
  if (remaining <= order.size * 1e-9) return rest;
  return [
    ...rest,
    {
      keys: order.keys,
      ruleId: prior?.ruleId ?? order.ruleId,
      reason: prior?.reason ?? order.reason,
      dex: order.dex,
      coin: order.coin,
      isBuy: order.isBuy,
      remaining,
      failures: (prior?.failures ?? 0) + 1,
      lastAttemptAt: at,
      alerted: prior?.alerted ?? false,
    },
  ];
}
