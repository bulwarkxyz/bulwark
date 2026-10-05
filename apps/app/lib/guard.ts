'use client';

import { bufferLines, guardActsAt, type Action, type GuardLevel, type PoolRisk, type PositionRisk, type Rule } from '@bulwarkxyz/guard-core';
import { useEffect, useState } from 'react';
import { useAccountView, useXyzMarkets } from './hl';
import { useMe } from './me';
import { REVIEW_WEEKEND, useReview, useViewer } from './review';

/**
 * One reading of the guard for the whole UI (guard bar, phone strip, position rows, chart lines).
 * Colour follows the rule in app.css: only `protected` is lime.
 */
export type GuardState =
  | 'disconnected' // no wallet
  | 'loading'
  | 'norules' // connected, no signed policy: the guard is not armed
  | 'alertsonly' // EU: trading and alerts, the guard does not trade
  | 'unsupported' // portfolio margin: read-only
  | 'stopped' // kill switch on
  | 'paused' // data too old to act on
  | 'protected' // armed and above every line
  | 'acting' // below at least one line
  | 'risk'; // below the last line

export const GUARD_LABEL: Record<GuardState, string> = {
  disconnected: 'Not connected',
  loading: 'Loading',
  norules: 'No rules yet',
  alertsonly: 'Alerts only',
  unsupported: 'Read-only account',
  stopped: 'Guard stopped',
  paused: 'Guard paused',
  protected: 'Protected',
  acting: 'Guard acting',
  risk: 'At risk',
};
export const GUARD_CHIP: Record<GuardState, string> = {
  disconnected: 'chip-off',
  loading: 'chip-off',
  norules: 'chip-off',
  alertsonly: 'chip-off',
  unsupported: 'chip-off',
  stopped: 'chip-risk',
  paused: 'chip-risk',
  protected: 'chip-protected',
  acting: 'chip-acting',
  risk: 'chip-risk',
};

/** The engine holds off when account state is older than this (apps/worker staleness rule, 30 s). */
export const STATE_STALE_MS = 30_000;

export interface NextAction extends GuardLevel {
  coin: string;
  ticker: string;
  /** What the rule at that line does, in the user's own terms. */
  does: string;
}

/** A pool already below one of the user's lines: what that line's rule does. */
export interface Crossed {
  line: number;
  ticker: string;
  does: string;
}

export interface GuardView {
  state: GuardState;
  /** The worst pool's highest crossed line, when it is below any line. */
  crossed: Crossed | null;
  lines: number[];
  rules: Rule[];
  exampleRules: boolean;
  worst: PoolRisk | null;
  next: NextAction | null;
  /** Data age of the account state, ms. */
  ageMs: number | null;
  /** Per position: the price at which the guard acts next. */
  levelFor: (pool: PoolRisk, row: PositionRisk) => GuardLevel | null;
}

const pct = (x: number) => `${+(x * 100).toFixed(4)}%`;
export function describeAction(a: Action): string {
  switch (a.kind) {
    case 'alert':
      return 'alert';
    case 'close':
      return a.target.kind === 'all' ? 'close all' : 'close';
    case 'reduce':
      return `reduce ${pct(a.fraction)}`;
    case 'reduceToBuffer':
      return `reduce to ${a.buffer}×`;
    case 'reduceToLeverage':
      return `cut leverage to ${a.leverage}×`;
    case 'topUp':
      return `top up ${a.maxUsdc} USDC`;
    case 'cancelOpeningOrders':
      return 'cancel opening orders';
  }
}

export const tickerOf = (coin: string) => coin.replace(/^[a-z]+:/, '');

/** The real clock, ticking every `stepMs` (data ages). */
export function useClock(stepMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(id);
  }, [stepMs]);
  return now;
}

/** Now for market sessions, ticking every 30 s. Review "closed" pins it to a Saturday; never use it for data ages. */
export function useNow(stepMs = 30_000): number {
  const review = useReview();
  const now = useClock(stepMs);
  return review.state === 'closed' ? REVIEW_WEEKEND : now;
}

export function useGuardView(): GuardView {
  const review = useReview();
  const { address } = useViewer();
  const me = useMe();
  const view = useAccountView(address);
  const markets = useXyzMarkets();
  const now = useClock(5_000);
  const rules = me.data?.policy?.policy.rules ?? [];
  const lines = bufferLines(rules);
  const levelFor = (pool: PoolRisk, row: PositionRisk) => (lines.length ? guardActsAt(pool, row, lines) : null);

  const risk = view.data?.risk;
  const worst = risk?.worst ?? null;
  const ageMs = view.dataUpdatedAt ? now - view.dataUpdatedAt : null;

  let next: NextAction | null = null;
  for (const pool of risk?.pools ?? []) {
    for (const row of pool.positions) {
      const lvl = levelFor(pool, row);
      if (!lvl) continue;
      if (next && Math.abs(lvl.move) >= Math.abs(next.move)) continue;
      const rule = rules.find((r) => r.when.kind === 'buffer' && r.when.below === lvl.line);
      next = { ...lvl, coin: row.position.coin, ticker: tickerOf(row.position.coin), does: rule ? rule.then.map(describeAction).join(', then ') : 'act' };
    }
  }

  let crossed: Crossed | null = null;
  if (worst && lines.some((l) => worst.buffer < l)) {
    const line = Math.min(...lines.filter((l) => worst.buffer < l));
    const rule = rules.find((r) => r.when.kind === 'buffer' && r.when.below === line);
    const coins = worst.positions.map((r) => tickerOf(r.position.coin));
    crossed = { line, ticker: coins.length === 1 ? coins[0]! : `${coins.length} positions`, does: rule ? rule.then.map(describeAction).join(', then ') : 'act' };
  }

  let state: GuardState;
  if (review.state === 'loading') state = 'loading';
  else if (!address) state = 'disconnected';
  else if (!view.data || !me.isFetched) state = view.isError ? 'paused' : 'loading';
  else if (review.state === 'error' || view.isError || markets.isError || (ageMs !== null && ageMs > STATE_STALE_MS)) state = 'paused';
  else if (me.data?.user?.killSwitch) state = 'stopped';
  else if (me.data?.user?.region === 'guardOff') state = 'alertsonly';
  else if (!risk?.supported) state = 'unsupported';
  else if (!lines.length && !rules.length) state = 'norules';
  else if (!worst || !lines.length) state = 'protected';
  else if (worst.buffer < Math.min(...lines)) state = 'risk';
  else if (worst.buffer < Math.max(...lines)) state = 'acting';
  else state = 'protected';

  return { state, crossed, lines, rules, exampleRules: me.data?.policy?.hash === 'example', worst, next, ageMs, levelFor };
}

/** Position on the log meter (liquidation at 0%, `top` at 100%). */
export function meterPos(buffer: number, top: number): number {
  if (!(buffer > 1)) return 0;
  return Math.min(100, (Math.log(buffer) / Math.log(top)) * 100);
}
/** Meter top: 6× or a little above the highest line, so every line fits. */
export const meterTop = (lines: readonly number[]) => Math.max(6, (Math.max(0, ...lines) || 0) * 1.4);
