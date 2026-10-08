'use client';

import { bufferLines, guardActsAt, nextTimeIn, priceAtLine, whyNoBackstop, type WindowName, type Action, type GuardLevel, type NoBackstop, type PoolRisk, type PositionRisk, type Rule } from '@bulwarkxyz/guard-core';
import type { GuardOrder } from '@bulwarkxyz/store';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, useSignedIn } from './api';
import { NETWORK } from './env';
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

/**
 * The guard's own reading: GET /v1/guard/status (main, 8a4d0c9). It is the source of truth; the API
 * already reports a silent worker (no status for 60 s, or one older than the user's latest change) as
 * paused / stale_data. The app's own data-age check below is used only when this endpoint can't be reached.
 */
export type ApiGuardState = 'protected' | 'acting' | 'at_risk' | 'paused' | 'stopped' | 'no_rules' | 'alerts_only';
export type PauseReason = 'stale_data' | 'exchange_unreachable' | 'signer_error' | 'agent_expired' | 'resign_required' | 'operator_stop';
export interface GuardStatus {
  state: ApiGuardState;
  reason?: PauseReason | null;
  /** Last evaluation on fresh data, ms since epoch (null if never). */
  lastEvaluatedAt: number | null;
  /** When the worker last wrote this status, ms since epoch. */
  updatedAt: number | null;
}
const FROM_API: Record<ApiGuardState, GuardState> = {
  protected: 'protected',
  acting: 'acting',
  at_risk: 'risk',
  paused: 'paused',
  stopped: 'stopped',
  no_rules: 'norules',
  alerts_only: 'alertsonly',
};
export const PAUSE_TEXT: Record<PauseReason, string> = {
  stale_data: 'The guard’s data is too old to act on.',
  exchange_unreachable: 'The guard can’t reach Hyperliquid.',
  signer_error: 'The guard’s signer failed.',
  agent_expired: 'Your guard key’s approval on Hyperliquid has expired. Approve it again in setup.',
  resign_required: 'Your rules were signed before signatures named the network. Sign them again in Guard rules; until then the guard takes no new action, and its resting backstops stay on Hyperliquid.',
  operator_stop: 'Bulwark has paused the guard for everyone. Your resting backstops stay on Hyperliquid.',
};
/**
 * The guard reports agent_expired both when an approval has run out and before a key was ever approved;
 * /v1/me tells them apart (agent.validUntil in the past vs. never approved).
 */
export function pauseText(reason: PauseReason, agent: { approved: boolean; validUntil: number | null } | null | undefined, now = Date.now()): string {
  if (reason !== 'agent_expired') return PAUSE_TEXT[reason];
  // The worker reports agent_expired for a user who never had a key too (CONTRACT.md).
  if (!agent) return 'You don’t have a guard key yet. Create it in setup.';
  if (agent.validUntil !== null && agent.validUntil < now) return PAUSE_TEXT.agent_expired;
  if (!agent.approved) return 'Your guard key isn’t approved on Hyperliquid. Approve it in setup.';
  return PAUSE_TEXT.agent_expired;
}

/**
 * The guard's own orders resting on the exchange (GET /v1/guard-orders). This is what the positions
 * table, the chart and the guard actions panel draw for "resting on Hyperliquid": they take whatever
 * the API returns, of whatever kind, so a change in how the guard places orders needs no screen change.
 * The solver (guardActsAt) is only used for lines with no resting order: the price at which the engine
 * itself would act.
 */
export interface RestingOrders {
  orders: GuardOrder[];
  /** True for review builds, where the orders are worked out from the example rules, not read. */
  example: boolean;
  /** The list was actually read (signed in and answered): only then can the app tell the guard's orders from others. */
  known: boolean;
  forCoin(coin: string): GuardOrder[];
  isLoading: boolean;
  error: Error | null;
}
const ORDER_KIND_LABEL: Record<string, string> = { backstop: 'Backstop stop' };
export const orderKindLabel = (kind: string) => ORDER_KIND_LABEL[kind] ?? kind.replace(/_/g, ' ');
/** "Backstop stop at your 1.8× line" (reports/B9.md); the plain kind for orders from before lines were recorded. */
export const orderLabel = (o: Pick<GuardOrder, 'kind' | 'line'>) => (o.line ? `${orderKindLabel(o.kind)} at your ${o.line}× line` : orderKindLabel(o.kind));
/** Shown when a backstop was priced for the whole pool (B9, decision 1). */
export const TOGETHER_NOTE = 'Priced as if every position in this pool moves against you at once. If only one falls, it fires earlier than strictly needed.';
export function useGuardOrders(address: `0x${string}` | undefined): RestingOrders {
  const review = useReview();
  const signedIn = useSignedIn();
  const me = useMe();
  const view = useAccountView(address);
  const q = useQuery({
    queryKey: ['guard-orders', address],
    enabled: Boolean(address && signedIn && !review.on),
    queryFn: () => api<GuardOrder[]>('/v1/guard-orders'),
    refetchInterval: 15_000,
  });
  let orders = q.data ?? [];
  const example = review.on;
  if (review.on) {
    // Review only: one reduce-only stop per position at the lowest example line, as the engine places them.
    const lines = bufferLines(me.data?.policy?.policy.rules ?? []);
    const low = lines.length ? Math.min(...lines) : null;
    orders = [];
    if (low !== null && review.state !== 'empty')
      for (const pool of view.data?.risk?.pools ?? [])
        for (const row of pool.positions) {
          const lvl = priceAtLine(pool, row, low);
          if (lvl) orders.push({ oid: -orders.length - 1, coin: row.position.coin, kind: 'backstop', triggerPx: lvl.price, size: -row.position.size, placedAt: REVIEW_PLACED_AT, line: low, pricing: 'single' }); // priced for the position alone, so labelled single
        }
  }
  return { orders, example, known: review.on || (signedIn && q.isSuccess), forCoin: (coin) => orders.filter((o) => o.coin === coin), isLoading: q.isLoading, error: (q.error as Error | null) ?? null };
}
const REVIEW_PLACED_AT = Date.UTC(2026, 9, 5, 7, 29);

export function useGuardStatus(enabled: boolean) {
  const review = useReview();
  return useQuery({
    queryKey: ['guard-status', review.on ? review.guard : 'live'],
    enabled: enabled || Boolean(review.guard),
    queryFn: async (): Promise<GuardStatus> => {
      if (review.on && review.guard) {
        const [state, reason] = review.guard.split(':') as [ApiGuardState, PauseReason | undefined];
        return { state, reason: reason ?? null, lastEvaluatedAt: Date.now() - 2_000, updatedAt: Date.now() - 1_000 };
      }
      return api<GuardStatus>('/v1/guard/status');
    },
    staleTime: 4_000,
    refetchInterval: 5_000,
    retry: 0,
  });
}

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
  /** The account has no guard key at all (never created, or wiped). */
  noKey: boolean;
  /** Where the state came from: the guard's own report, or the app's fallback data-age check. */
  source: 'guard' | 'fallback';
  reason: PauseReason | null;
  /** The pause reason in words, for this user (see pauseText). */
  reasonText: string | null;
  /** The guard's last evaluation and last status write (from the API), ms since epoch. */
  lastEvaluatedAt: number | null;
  statusUpdatedAt: number | null;
  /** The worst pool's highest crossed line, when it is below any line. */
  crossed: Crossed | null;
  lines: number[];
  rules: Rule[];
  exampleRules: boolean;
  worst: PoolRisk | null;
  /** Positions the guard leaves without a backstop, and why (guard-core whyNoBackstop), by coin. */
  noBackstop: Record<string, NoBackstop>;
  /** Hyperliquid didn't answer the account read and there's no earlier answer: unknown, not empty. */
  accountUnavailable: boolean;
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
  const signedIn = useSignedIn();
  const status = useGuardStatus(Boolean(address) && signedIn && !review.on);
  const now = useClock(5_000);
  const rules = me.data?.policy?.policy.rules ?? [];
  const lines = bufferLines(rules);
  const levelFor = (pool: PoolRisk, row: PositionRisk) => (lines.length ? guardActsAt(pool, row, lines) : null);

  const risk = view.data?.risk;
  const worst = risk?.worst ?? null;
  // The same planner the worker runs: 'together' pricing on testnet (BACKSTOP_PRICING), 'single' on mainnet.
  const policy = me.data?.policy?.policy;
  const snapshot = view.data?.snapshot;
  const noBackstop = useMemo(() => (policy && snapshot ? whyNoBackstop(policy, snapshot, undefined, NETWORK === 'testnet' ? 'together' : 'single') : {}), [policy, snapshot]);
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

  // The guard's own report wins once it answers; the data-age check above is only the fallback.
  const reported = status.data && !status.isError ? status.data : null;
  const clientOnly = state === 'disconnected' || state === 'loading' || state === 'unsupported';
  if (reported && !clientOnly) state = FROM_API[reported.state];

  return { state, source: reported && !clientOnly ? 'guard' : 'fallback', reason: reported?.state === 'paused' ? (reported.reason ?? null) : null, reasonText: reported?.state === 'paused' && reported.reason ? pauseText(reported.reason, me.data?.agent, now) : null, noKey: !me.data?.agent, lastEvaluatedAt: reported?.lastEvaluatedAt ?? null, statusUpdatedAt: reported?.updatedAt ?? null, crossed, lines, rules, exampleRules: me.data?.policy?.hash === 'example', worst, noBackstop, accountUnavailable: Boolean(address) && !view.data && view.isError, next, ageMs, levelFor };
}

/** Position on the log meter (liquidation at 0%, `top` at 100%). */
export function meterPos(buffer: number, top: number): number {
  if (!(buffer > 1)) return 0;
  return Math.min(100, (Math.log(buffer) / Math.log(top)) * 100);
}
/** Meter top: 6× or a little above the highest line, so every line fits. */
export const meterTop = (lines: readonly number[]) => Math.max(6, (Math.max(0, ...lines) || 0) * 1.4);

/** When a fixed window next opens (null if it is open now), to the engine's 15-minute resolution. */
export function nextWindowOpen(name: WindowName, now: number): number | null {
  const t = nextTimeIn(name, now);
  return t === now ? null : t;
}

// ------------------------------------------------------------------ no backstop needed (wording: the guard session)

/** Whole numbers above 10, otherwise one decimal. */
const roundX = (x: number) => (!Number.isFinite(x) ? '∞' : x > 10 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1));
/** One line, for the positions table and the chart. */
export const NO_BACKSTOP_LINE = 'No backstop needed: a fall can’t bring this pool to your line';
/** The full reason, for the guard panels. */
export const noBackstopText = (nb: Extract<NoBackstop, { reason: 'margin_too_large' }>) =>
  `Your margin is large next to this position (buffer ${roundX(nb.buffer)}×, above ${roundX(nb.ceiling)}×), so a falling price raises the buffer instead of lowering it, and a stop below the price would never be reached. The guard still watches the position and places a backstop by itself if the buffer drops below ${roundX(nb.ceiling)}×, for example after you add to the position or move margin out.`;
/** The margin-too-large case only: a crossed line keeps its own wording (the guard is acting). */
export const marginTooLarge = (g: Pick<GuardView, 'noBackstop'>, coin: string) => {
  const nb = g.noBackstop[coin];
  return nb?.reason === 'margin_too_large' ? nb : null;
};
