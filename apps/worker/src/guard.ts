import { currentVerdict } from '@bulwarkxyz/config';
import { executeActions, planUnwind, stopCancels, verifyCommandSignature, verifyPolicySignature, type CommandSigner, type Exchange, type ExecutionRecord, type GuardedSigner } from '@bulwarkxyz/executor';
import {
  assessRisk,
  buildSnapshot,
  evaluate,
  planBackstops,
  needsRepeatChoice,
  planRetries,
  recordFill,
  windowContains,
  windowStart,
  type AccountSnapshot,
  type AssetIndex,
  type BackstopPricing,
  type ExecutionContext,
  type GuardAction,
  type GuardContext,
  type OpenOrder,
  type RawClearinghouseState,
  type RawSpotState,
  type RetryChain,
} from '@bulwarkxyz/guard-core';
import type { BuilderWire, Hex, Network, NonceManager } from '@bulwarkxyz/hyperliquid';
import type { AuditInput, GuardState, PausedReason, PendingCommand } from '@bulwarkxyz/store';
import { formatRun, type Notifier } from './notify.js';
import type { GuardStore } from '@bulwarkxyz/store';

/** Engine constants (not user thresholds). */
export const MARK_MAX_AGE_MS = 10_000;
export const STATE_MAX_AGE_MS = 30_000;
export const DEGRADED_ALERT_EVERY_MS = 5 * 60_000;
/**
 * How long the account's mode (standard or unified) is trusted before it is read again. The user can switch it at
 * any time (the app's Settings > Account mode); until 6 Oct 2026 it was read once, so after a switch the guard kept
 * pricing a unified account as standard (testnet run: a 10x buffer alert and a backstop for a ~1,999x account).
 * Every 10 minutes, not 30 s: each read costs 20 of Hyperliquid's 1,200 weight a minute per IP, and at 30 s these
 * reads alone capped a worker at about 16 guarded accounts (8 Oct 2026). The cost: after a switch the guard can price
 * the account on its old mode for up to 10 minutes (in the testnet case, it erred towards closing early).
 */
export const ABSTRACTION_TTL_MS = 10 * 60_000;
/** Data must be past its limit this long before the user is told (a reconnect's few seconds are not news). */
export const DEGRADED_ALERT_AFTER_MS = 20_000;
export const BACKSTOP_EVERY_MS = 60_000;
export const OPEN_ORDERS_TTL_MS = 15_000;
export const CHOICE_NOTICE_WHY = 'A new setting needs your choice';
/** Audit reasons for the one-time notices when the guard will not act (each sent once per cause, across restarts). */
export const RESIGN_NOTICE_WHY = 'Your rules need a new signature';
export const OPERATOR_STOP_WHY = 'Bulwark paused the guard for everyone';
/** How often the worker re-reads the operator's global stop. */
export const OPERATOR_STOP_TTL_MS = 3_000;
/** After Hyperliquid refuses an open-orders request, wait this long before that account asks again. */
export const OPEN_ORDERS_RETRY_MS = 5_000;
/** The status is written when it changes, and at least this often while the account is evaluated. */
export const STATUS_WRITE_EVERY_MS = 15_000;
/**
 * How often the guard key is checked: still approved on Hyperliquid, not expired, loadable by the signer. Every 10
 * minutes (each check costs 20 weight); an exchange refusal that names the agent triggers a check at once anyway.
 */
export const KEY_CHECK_EVERY_MS = 10 * 60_000;
/** After the exchange did not answer, the guard shows as paused this long unless a later request gets through. */
export const EXCHANGE_DOWN_HOLD_MS = 120_000;
/** Exchange errors that mean the guard key is no longer approved for the account. */
const AGENT_GONE = /does not exist|agent.*expired|api wallet.*(expired|invalid)/i;

/** Size an order record actually filled (0 when it missed, was held back or failed). */
export function filledSize(r: ExecutionRecord): number {
  if (r.assumedFilled !== undefined) return r.assumedFilled;
  if (r.status !== 'sent') return 0;
  return (r.result?.statuses ?? []).reduce((n, s) => n + (s.kind === 'filled' ? Number(s.totalSz) : 0), 0);
}

export interface EngineDeps {
  network: Network;
  assets: AssetIndex;
  collateral: ReadonlyMap<string, number>;
  store: GuardStore;
  notifier: Notifier;
  exchange: Exchange;
  nonces: NonceManager;
  /** Open orders for a user on one dex, as frontendOpenOrders returns them. */
  openOrders(user: Hex, dex: string): Promise<OpenOrder[]>;
  abstraction(user: Hex): Promise<string>;
  signerFor(user: Hex): Promise<GuardedSigner>;
  commandSignerFor(user: Hex): Promise<CommandSigner>;
  /** Builder field from config (null while the mainnet switch is off). */
  builder: BuilderWire | null;
  /**
   * How backstops are priced for pools with several positions: 'together' (as if every position moves
   * against the user at once; fires earlier) or 'single' (each position alone). Default 'single'.
   */
  backstopPricing?: BackstopPricing;
  /** Ask users of older policies to make the per-stage repeat choice (once the app can offer it). */
  askRepeatChoice?: boolean;
  /**
   * The exchange no longer accepts this account's guard key. Usually the user has just approved a
   * replacement under the same name (which replaces the old one on Hyperliquid): promote it now
   * rather than at the next periodic check.
   */
  onAgentGone?(account: Hex): Promise<void>;
  /** Agents the user has approved on Hyperliquid (`extraAgents`), to tell when the guard key expired or was removed. */
  agents?(user: Hex): Promise<Array<{ address: string; validUntil?: number | null }>>;
  /**
   * An order's state by its client order id: null when Hyperliquid has no such order (it never arrived).
   * Used after a send that got no answer, before anything is retried.
   */
  orderStatus?(user: Hex, cloid: Hex): Promise<{ status: string; origSz: number; sz: number } | null>;
  now(): number;
}

interface AccountCache {
  abstraction?: string;
  abstractionAt?: number;
  dexStates: Record<string, RawClearinghouseState>;
  stateAt: number;
  spot?: RawSpotState;
  spotAt: number;
  /** Open orders per dex, each cached on its own; cleared as a whole after the guard acts. */
  openOrders?: { at: number; orders: OpenOrder[] } | undefined;
  openByDex?: Map<string, { at: number; orders: OpenOrder[] }> | undefined;
  /** After a failed fetch, the account waits this long before asking again. */
  openOrdersFailedAt?: number | undefined;
  lastBackstopAt: number;
  positionsKey: string;
  lastDegradedAlert: number;
  /** Undefined until read back from the store after a restart. */
  lastEvaluatedAt?: number | null;
  status?: { key: string; at: number };
  exchangeDownAt: number;
  signerError: boolean;
  agentExpired: boolean;
  keyCheckedAt: number;
  /** Hash of the signed policy the backstops were last priced for. */
  policyHash?: string;
  /** Policy hash we last asked the user to make the repeat choice for. */
  choiceNoticeFor?: string;
  /** One-time notices already sent by this process. */
  notices?: Set<string>;
}

const coinsOf = (c: AccountCache) => new Set(Object.values(c.dexStates).flatMap((s) => s.assetPositions.map((p) => p.position.coin)));
/**
 * What the backstops are priced from, apart from prices: positions, each pool's cash (moves with fills,
 * transfers, deposits, withdrawals and funding, not with the mark) and isolated margin. When it changes,
 * the backstops are re-priced on the next run.
 */
export const positionsKey = (c: Pick<AccountCache, 'dexStates'>) =>
  Object.entries(c.dexStates)
    .flatMap(([dex, s]) => [
      `${dex}$${Number(s.crossMarginSummary.totalRawUsd).toFixed(2)}`,
      // Isolated margin as posted: Hyperliquid's marginUsed includes unrealised PnL, which moves with every price
      // and made this key change on every update (a backstop re-plan and an open-orders fetch each time).
      ...s.assetPositions.map((p) => `${p.position.coin}:${p.position.szi}${p.position.leverage.type === 'isolated' ? `@${(Number(p.position.marginUsed) - Number(p.position.unrealizedPnl)).toFixed(2)}` : ''}`),
    ])
    .sort()
    .join('|');

/** An order, transfer, margin or alert action in words, for its audit entry: "Reduce xyz:GOLD: sell order sent". */
export function actionWords(a: GuardAction, status: string): string {
  switch (a.type) {
    case 'order':
      return `Reduce ${a.coin}: ${a.isBuy ? 'buy' : 'sell'} order ${status}`;
    case 'transfer':
      return `Move ${a.amount} USDC to the ${a.toDex || 'main'} pool: ${status}`;
    case 'isolatedMargin':
      return `Add ${a.amount} USDC margin to ${a.coin}: ${status}`;
    case 'alert':
      return 'Alert sent';
    default:
      return `${a.type} ${status}`;
  }
}

export class GuardEngine {
  private readonly marks = new Map<string, { px: number; at: number }>();
  private readonly cache = new Map<string, AccountCache>();
  private readonly busy = new Set<string>();
  private readonly again = new Set<string>();

  constructor(private readonly deps: EngineDeps) {}

  // ---------------------------------------------------------------- inputs

  onMarks(marks: ReadonlyMap<string, number>, at: number): Promise<void[]> {
    const changed = new Set<string>();
    for (const [coin, px] of marks) {
      const prev = this.marks.get(coin);
      if (!prev || prev.px !== px) changed.add(coin);
      this.marks.set(coin, { px, at });
    }
    const runs: Array<Promise<void>> = [];
    for (const [account, c] of this.cache) {
      if ([...coinsOf(c)].some((coin) => changed.has(coin))) runs.push(this.schedule(account));
    }
    return Promise.all(runs);
  }

  /** Every market some watched account holds, for the per-market mark streams. */
  heldCoins(): Set<string> {
    const out = new Set<string>();
    for (const c of this.cache.values()) for (const coin of coinsOf(c)) out.add(coin);
    return out;
  }

  onUserState(account: string, states: Array<[string, RawClearinghouseState]>, at: number): Promise<void> {
    const c = this.entry(account);
    c.dexStates = Object.fromEntries(states);
    c.stateAt = at;
    const key = positionsKey(c);
    if (key !== c.positionsKey) {
      c.positionsKey = key;
      c.lastBackstopAt = 0; // positions changed: re-plan backstops
      c.openOrders = c.openByDex = undefined;
    }
    return this.schedule(account);
  }

  onSpotState(account: string, spot: RawSpotState, at: number): Promise<void> {
    const c = this.entry(account);
    c.spot = spot;
    c.spotAt = at;
    return this.schedule(account);
  }

  /** Hyperliquid liquidated (part of) a position: log it and tell the user. */
  async onLiquidation(account: string, fill: Record<string, unknown>): Promise<void> {
    const user = await this.deps.store.user(account);
    if (!user) return;
    const at = this.deps.now();
    const what = `Hyperliquid liquidated ${fill.sz ?? 'part of your'} ${fill.coin ?? ''} position${fill.px ? ` at ${fill.px}` : ''}`.replace(/\s+/g, ' ');
    await this.audit({ account: account as Hex, at, kind: 'alert', why: 'Liquidation reported by the exchange', what, proof: { fill } });
    if (user.telegramChatId) await this.deps.notifier.send(user.telegramChatId, `Bulwark: ${what}.`).catch(() => undefined);
  }

  /** The account's guard key changed (created, replaced or wiped): check it again on the next run. */
  keyChanged(account: string): void {
    const c = this.entry(account);
    c.keyCheckedAt = 0;
    c.agentExpired = false;
    c.signerError = false;
  }

  /** Re-runs every known account, so the status stays current while nothing moves. */
  heartbeat(): Promise<void[]> {
    return Promise.all([...this.cache.keys()].map((k) => this.schedule(k)));
  }

  private entry(account: string): AccountCache {
    const k = account.toLowerCase();
    let c = this.cache.get(k);
    if (!c) {
      c = { dexStates: {}, stateAt: 0, spotAt: 0, lastBackstopAt: 0, positionsKey: '', lastDegradedAlert: 0, exchangeDownAt: 0, signerError: false, agentExpired: false, keyCheckedAt: 0 };
      this.cache.set(k, c);
    }
    return c;
  }

  /** One run at a time per account; a request during a run triggers exactly one more run after it. */
  private async schedule(account: string): Promise<void> {
    const k = account.toLowerCase();
    if (this.busy.has(k)) {
      this.again.add(k);
      return;
    }
    this.busy.add(k);
    try {
      do {
        this.again.delete(k);
        try {
          await this.run(k as Hex);
        } catch (e) {
          // One account's failure (for example Hyperliquid refusing a request) never stops the others or the process.
          // Its status then ages and reads as paused (stale data) until a run succeeds.
          console.error(JSON.stringify({ msg: 'guard run failed', account: k, error: String(e) }));
        }
      } while (this.again.has(k));
    } finally {
      this.busy.delete(k);
    }
  }

  // ---------------------------------------------------------------- one run

  private async audit(e: AuditInput) {
    await this.deps.store.audit.append(e);
  }

  private snapshot(account: Hex, c: AccountCache): AccountSnapshot {
    return buildSnapshot({
      abstraction: c.abstraction ?? 'default',
      dexStates: c.dexStates,
      spot: c.spot ?? { balances: [] },
      assets: this.deps.assets,
      dexCollateral: this.deps.collateral,
      time: c.stateAt,
    });
  }

  /**
   * Open orders on the dexes where the account has a position or a guard order resting; nothing to fetch otherwise.
   * Each dex is cached on its own, so when Hyperliquid refuses one request the other's answer isn't thrown away.
   * Before, a refused request left nothing cached and the next run, a second later, asked again: a loop that
   * spent the whole rate budget on open orders and starved everything else.
   */
  private async openOrders(account: Hex, c: AccountCache): Promise<OpenOrder[]> {
    const now = this.deps.now();
    if (c.openOrders && now - c.openOrders.at < OPEN_ORDERS_TTL_MS) return c.openOrders.orders;
    if (c.openOrdersFailedAt !== undefined && now - c.openOrdersFailedAt < OPEN_ORDERS_RETRY_MS) throw new Error('open orders unavailable (retrying shortly)');
    const guardOrders = await this.deps.store.guardOrders(account);
    const dexOf = (coin: string) => (coin.includes(':') ? (coin.split(':')[0] as string) : '');
    const dexes = new Set<string>([
      ...Object.entries(c.dexStates)
        .filter(([, st]) => st.assetPositions.length > 0)
        .map(([d]) => d),
      ...guardOrders.map((o) => dexOf(o.coin)),
    ]);
    const byDex = (c.openByDex ??= new Map());
    try {
      for (const d of dexes) {
        const hit = byDex.get(d);
        if (hit && now - hit.at < OPEN_ORDERS_TTL_MS) continue;
        byDex.set(d, { at: now, orders: await this.deps.openOrders(account, d) });
      }
    } catch (e) {
      c.openOrdersFailedAt = now;
      throw e;
    }
    c.openOrdersFailedAt = undefined;
    const orders = [...dexes].flatMap((d) => byDex.get(d)?.orders ?? []);
    c.openOrders = { at: now, orders };
    return orders;
  }

  async run(account: Hex): Promise<void> {
    const { store } = this.deps;
    const [user, confirmed] = await Promise.all([store.user(account), store.policy(account)]);
    if (!user) return;
    const c = this.entry(account);
    const now = this.deps.now();
    if (c.lastEvaluatedAt === undefined) c.lastEvaluatedAt = (await store.guardStatus(account))?.lastEvaluatedAt ?? null;
    const report = (state: GuardState, reason: PausedReason | null = null) => this.report(account, c, user.killSwitch ? 'stopped' : state, user.killSwitch ? null : reason, now);
    if (!confirmed || confirmed.policy.rules.length === 0) return report('no_rules');
    // The operator's global stop: nothing is evaluated, signed or cancelled for anyone; resting backstops stand.
    const stop = await this.operatorStop(now);
    if (stop) {
      await this.noticeOnce(account, user.telegramChatId, OPERATOR_STOP_WHY, `stop:${stop.at}`, `Bulwark has paused the guard for every account${stop.reason ? ` (${stop.reason})` : ''}. Nothing is being signed. Your resting backstops stay on Hyperliquid.`, now);
      return report('paused', 'operator_stop');
    }
    // The rules' own signature, verified here (security review F3: a stored "verified" flag is never trusted) and for
    // this network (F5). Rules signed before signatures named the network need a new signature; until then the
    // guard takes no new action and leaves its resting backstops as they are.
    const sig = await this.policySignature(account, confirmed);
    if (sig !== 'ok') {
      const what = sig === 'resign'
        ? 'Your rules were signed before signatures named the network. Sign them again in Guard rules; until then the guard takes no new action, and its resting backstops stay on Hyperliquid.'
        : 'Your rules\' signature could not be verified for this network, so the guard takes no action under them. Sign them again in Guard rules.';
      await this.noticeOnce(account, user.telegramChatId, RESIGN_NOTICE_WHY, confirmed.hash, what, now);
      return report('paused', 'resign_required');
    }
    // The region now, not only at onboarding: the strictest of the declarations and the latest request's country.
    const region = currentVerdict(user);
    if (c.stateAt === 0) return report('paused', 'stale_data');
    if (!c.abstraction || now - (c.abstractionAt ?? 0) >= ABSTRACTION_TTL_MS) {
      // A failed re-read keeps the last known mode; with none known yet, the run fails and is retried.
      const mode = c.abstraction ? await this.deps.abstraction(account).catch(() => c.abstraction as string) : await this.deps.abstraction(account);
      if (c.abstraction && mode !== c.abstraction) {
        // The account changed mode: its pools are different now, so re-plan backstops from scratch.
        c.lastBackstopAt = 0;
        c.openOrders = c.openByDex = undefined;
        console.log(JSON.stringify({ msg: 'account mode changed', account, from: c.abstraction, to: mode }));
      }
      c.abstraction = mode;
      c.abstractionAt = now;
    }

    // Never act on stale data: hold off and tell the user (throttled). Backstops on the exchange still stand.
    const held = [...coinsOf(c)];
    // Before the first price for a held coin arrives there is nothing to judge yet: wait quietly.
    if (held.some((coin) => !this.marks.has(coin))) return report('paused', 'stale_data');
    const staleMark = held.find((coin) => now - (this.marks.get(coin) as { at: number }).at > MARK_MAX_AGE_MS);
    const needsSpot = c.abstraction === 'unifiedAccount';
    const staleState = now - c.stateAt > STATE_MAX_AGE_MS || (needsSpot && now - c.spotAt > STATE_MAX_AGE_MS);
    if (held.length && (staleMark || staleState)) {
      // The guard holds off at once; the user hears about it only once the data has stayed late for a while, and
      // at most every 5 minutes.
      const markLate = staleMark ? now - (this.marks.get(staleMark) as { at: number }).at - MARK_MAX_AGE_MS : 0;
      const stateLate = Math.max(now - c.stateAt, needsSpot ? now - c.spotAt : 0) - STATE_MAX_AGE_MS;
      const lateFor = Math.max(markLate, staleState ? stateLate : 0);
      if (lateFor >= DEGRADED_ALERT_AFTER_MS && now - c.lastDegradedAlert > DEGRADED_ALERT_EVERY_MS) {
        c.lastDegradedAlert = now;
        const why = staleState ? 'account data from Hyperliquid is late' : `no fresh price for ${staleMark}`;
        await this.audit({ account, at: now, kind: 'degraded', why, what: 'The guard held off; backstop orders on the exchange still stand.' });
        if (user.telegramChatId) await this.deps.notifier.send(user.telegramChatId, `Bulwark: ${why}. The guard is holding off until data is fresh; your backstop orders on Hyperliquid still stand.`).catch(() => undefined);
      }
      return report('paused', 'stale_data');
    }

    const snapshot = this.snapshot(account, c);
    const marks = Object.fromEntries(held.map((coin) => [coin, (this.marks.get(coin) as { px: number }).px]));
    const risk = assessRisk(snapshot, marks);
    const policy = confirmed.policy;

    // Window baselines: set at the start of each window instance, cleared when it ends.
    const baselines = await store.baselines(account);
    for (const rule of policy.rules) {
      if (!rule.window || rule.when.kind === 'buffer' || rule.when.kind === 'leverageAbove') continue;
      const fromWindow = (rule.when.kind === 'drawdown' && rule.when.baseline === 'window_start') || (rule.when.kind === 'priceMove' && rule.when.from === 'window_start');
      if (!fromWindow) continue;
      if (windowContains(rule.window, now)) {
        const start = windowStart(rule.window, now) as number;
        if (baselines[rule.id]?.windowStart !== start) {
          baselines[rule.id] = { windowStart: start, accountValue: risk.accountValue, prices: { ...marks } };
          await store.setBaseline(account, rule.id, baselines[rule.id] as never);
          await this.audit({ account, at: now, kind: 'window', why: `${rule.window} window opened`, what: `Baseline set: account value ${risk.accountValue.toFixed(2)}`, proof: { ruleId: rule.id, windowStart: start } });
        }
      } else if (baselines[rule.id]) {
        delete baselines[rule.id];
        await store.setBaseline(account, rule.id, null);
      }
    }

    const guardOrders = await store.guardOrders(account);
    const needsOrders = policy.rules.some((r) => r.then.some((a) => a.kind === 'cancelOpeningOrders'));
    const memory = await store.ruleMemory(account);
    const ctx: GuardContext = {
      now,
      baselines,
      openOrders: needsOrders ? await this.openOrders(account, c) : [],
      latched: await store.latched(account),
      breaches: memory.breaches,
      fires: memory.fires,
      automationAllowed: region === 'allowed',
      guardOwnedOids: new Set(guardOrders.map((o) => o.oid)),
    };
    const decision = evaluate(policy, snapshot, marks, ctx);
    await store.saveLatched(account, decision.latched);
    if (JSON.stringify({ b: decision.breaches, f: decision.fires }) !== JSON.stringify({ b: memory.breaches, f: memory.fires }))
      await store.saveRuleMemory(account, { breaches: decision.breaches, fires: decision.fires });
    // Rules signed before the repeat choice existed keep running as they did (every crossing); ask once per version.
    const unchosen = this.deps.askRepeatChoice ? needsRepeatChoice(policy) : [];
    // Once per policy version, across restarts: the audit log is checked once per process for a notice already sent.
    if (unchosen.length && c.choiceNoticeFor !== confirmed.hash) {
      c.choiceNoticeFor = confirmed.hash;
      if (!(await this.choiceNoticeLogged(account, policy.version))) {
      const what = `${unchosen.length} of your stages (${unchosen.join(', ')}) need a choice: act once per fall and then leave the rest to the backstop, or act every time the line is crossed. Until you choose and sign, they act every time the line is crossed, as before.`;
      await this.audit({ account, at: now, kind: 'alert', why: CHOICE_NOTICE_WHY, what, proof: { ruleIds: unchosen, policyVersion: policy.version } });
      if (user.telegramChatId) await this.deps.notifier.send(user.telegramChatId, `Bulwark: ${what} Open Guard rules to choose.`).catch(() => undefined);
      }
    }
    c.lastEvaluatedAt = now;
    await this.checkKey(account, user, c, now);

    // Orders that did not fully fill are retried, re-priced, while their stage still holds (guard-core retry.ts).
    const before = await store.retries(account);
    const plan = planRetries(decision, before, { slippagePct: policy.execution.maxSlippagePct, automationAllowed: ctx.automationAllowed && !user.killSwitch, stateAt: c.stateAt });
    let chains: RetryChain[] = plan.chains;
    let records: ExecutionRecord[] = [];
    if (plan.actions.length) {
      records = await this.execute(account, user, confirmed, snapshot, marks, ctx, plan.actions);
      c.openOrders = c.openByDex = undefined;
      if (!user.killSwitch) for (const r of records) if (r.action.type === 'order') chains = recordFill(chains, r.action, filledSize(r), now);
      // A retry that missed again is in the audit log; the user hears about fills, and the alert after repeated misses.
      const told = records.filter((r) => !(r.action.type === 'order' && (r.action.attempt ?? 1) > 1 && filledSize(r) === 0));
      const text = formatRun(told);
      if (text && user.telegramChatId) await this.deps.notifier.send(user.telegramChatId, text).catch(() => undefined);
    }
    if (JSON.stringify(chains) !== JSON.stringify(before)) await store.saveRetries(account, chains);

    if (c.policyHash !== confirmed.hash) {
      c.policyHash = confirmed.hash;
      c.lastBackstopAt = 0; // rules changed: re-price backstops now
    }
    if (now - c.lastBackstopAt >= BACKSTOP_EVERY_MS && region === 'allowed' && !user.killSwitch) {
      c.lastBackstopAt = now;
      await this.backstops(account, user, confirmed, snapshot, marks, ctx);
    }

    const paused = this.pausedReason(c, now);
    const acting = chains.length > 0 || records.some((r) => r.action.type !== 'alert' && r.status !== 'rejected');
    if (paused) return report('paused', paused);
    if (region !== 'allowed') return report('alerts_only');
    if (acting) return report('acting');
    if (decision.active.size > 0) return report('at_risk');
    return report('protected');
  }

  /** Whether the "needs your choice" notice for this policy version is already in the audit log. */
  private verifiedPolicies = new Map<string, 'ok' | 'resign' | 'bad'>();
  /** 'ok' when the stored signature recovers to the account for this network; cached by policy hash. */
  private async policySignature(account: Hex, confirmed: NonNullable<Awaited<ReturnType<GuardStore['policy']>>>): Promise<'ok' | 'resign' | 'bad'> {
    // Keyed by everything the verdict depends on: the same rules with another signature are checked again.
    const key = `${account.toLowerCase()}:${confirmed.hash}:${confirmed.signature}:${confirmed.chainId ?? ''}:${confirmed.signedNetwork ?? ''}`;
    const known = this.verifiedPolicies.get(key);
    if (known) return known;
    let v: 'ok' | 'resign' | 'bad';
    if (!confirmed.signedNetwork || !confirmed.chainId) v = 'resign';
    else if (confirmed.signedNetwork !== this.deps.network) v = 'bad';
    else v = (await verifyPolicySignature({ account, policy: confirmed.policy, signature: confirmed.signature, chainId: confirmed.chainId, network: confirmed.signedNetwork })) ? 'ok' : 'bad';
    this.verifiedPolicies.set(key, v);
    return v;
  }

  private stopCache: { at: number; value: { at: number; reason: string | null } | null } | null = null;
  /** The operator's global stop, if on (re-read every few seconds). */
  async operatorStop(now: number): Promise<{ at: number; reason: string | null } | null> {
    if (this.stopCache && now - this.stopCache.at < OPERATOR_STOP_TTL_MS) return this.stopCache.value;
    try {
      const st = await this.deps.store.operatorState<{ on: boolean; reason?: string | null }>('global_stop');
      this.stopCache = { at: now, value: st?.value.on ? { at: st.at, reason: st.value.reason ?? null } : null };
    } catch {
      // The database could not be read: keep the last known value (and try again next time).
      this.stopCache = { at: now, value: this.stopCache?.value ?? null };
    }
    return this.stopCache.value;
  }

  /** One alert (audit and Telegram) per cause, also across restarts. */
  private async noticeOnce(account: Hex, chatId: string | null, why: string, key: string, what: string, now: number): Promise<void> {
    const c = this.entry(account);
    const id = `${why}|${key}`;
    if (c.notices?.has(id)) return;
    (c.notices ??= new Set()).add(id);
    const recent = await this.deps.store.audit.list(account, 200).catch(() => []);
    if (recent.some((e) => e.why === why && (e.proof as { key?: string } | undefined)?.key === key)) return;
    await this.audit({ account, at: now, kind: 'alert', why, what, proof: { key } });
    if (chatId) await this.deps.notifier.send(chatId, `Bulwark: ${what}`).catch(() => undefined);
  }

  private async choiceNoticeLogged(account: Hex, version: number): Promise<boolean> {
    const recent = await this.deps.store.audit.list(account, 200).catch(() => []);
    return recent.some((e) => e.kind === 'alert' && e.why === CHOICE_NOTICE_WHY && (e.proof as { policyVersion?: number } | undefined)?.policyVersion === version);
  }

  private pausedReason(c: AccountCache, now: number): PausedReason | null {
    if (c.agentExpired) return 'agent_expired';
    if (c.signerError) return 'signer_error';
    if (c.exchangeDownAt && now - c.exchangeDownAt < EXCHANGE_DOWN_HOLD_MS) return 'exchange_unreachable';
    return null;
  }

  /** Writes the guard status when it changes, and at least every STATUS_WRITE_EVERY_MS. */
  private async report(account: Hex, c: AccountCache, state: GuardState, reason: PausedReason | null, now: number): Promise<void> {
    const key = `${state}|${reason}`;
    if (c.status?.key === key && now - c.status.at < STATUS_WRITE_EVERY_MS) return;
    c.status = { key, at: now };
    await this.deps.store.setGuardStatus(account, { state, reason: state === 'paused' ? reason : null, lastEvaluatedAt: c.lastEvaluatedAt ?? null, updatedAt: now });
  }

  /** Every KEY_CHECK_EVERY_MS: the guard key loads, and is still approved and unexpired on Hyperliquid. */
  private async checkKey(account: Hex, user: NonNullable<Awaited<ReturnType<GuardStore['user']>>>, c: AccountCache, now: number): Promise<void> {
    if (now - c.keyCheckedAt < KEY_CHECK_EVERY_MS) return;
    c.keyCheckedAt = now;
    if (!user.agentAddress || user.agentKeyRef === 'pending') {
      c.agentExpired = true;
      return;
    }
    try {
      await this.deps.signerFor(account);
    } catch {
      c.signerError = true;
    }
    if (!this.deps.agents) return;
    try {
      const mine = (await this.deps.agents(account)).find((a) => a.address.toLowerCase() === (user.agentAddress as string).toLowerCase());
      c.agentExpired = !mine || (typeof mine.validUntil === 'number' && mine.validUntil <= now);
    } catch {
      // Could not ask Hyperliquid: keep the last known answer.
    }
  }

  private async execute(
    account: Hex,
    user: NonNullable<Awaited<ReturnType<GuardStore['user']>>>,
    confirmed: NonNullable<Awaited<ReturnType<GuardStore['policy']>>>,
    snapshot: AccountSnapshot,
    marks: Record<string, number>,
    ctx: GuardContext,
    actions: Parameters<typeof executeActions>[0],
  ): Promise<ExecutionRecord[]> {
    const { store, now } = this.deps;
    const builder = this.deps.builder && user.builderApproved ? this.deps.builder : null;
    const execCtx: ExecutionContext = {
      ...ctx,
      // I4 checks the signature this worker verified itself (F3), never the stored flag.
      confirmation: { policyHash: confirmed.hash, signatureVerified: (await this.policySignature(account, confirmed)) === 'ok' },
      killSwitch: user.killSwitch,
      recentActions: await store.recentActions(account, now() - 60_000),
      builder: builder ? { enabled: true, approvedMaxTenthsBps: Math.max(builder.f, 0), feeTenthsBps: builder.f } : null,
    };
    const c = this.entry(account);
    let signer: GuardedSigner;
    try {
      signer = await this.deps.signerFor(account);
    } catch (e) {
      // The signer could not load this account's key: nothing can be signed.
      c.signerError = true;
      const error = e instanceof Error ? e.message : String(e);
      const failed = actions.map((action): ExecutionRecord => (action.type === 'alert' ? { action, status: 'alert', builderRetried: false, latencyMs: 0 } : { action, status: 'failed', error, failedAt: 'sign', builderRetried: false, latencyMs: 0 }));
      await this.auditRecords(account, failed);
      return failed;
    }
    const records = await executeActions(actions, { policy: confirmed.policy, snapshot, marks, ctx: execCtx }, {
      network: this.deps.network,
      account,
      signer,
      exchange: this.deps.exchange,
      nonces: this.deps.nonces,
      assets: this.deps.assets,
      builder,
      now,
    });
    for (const r of records) {
      // Sent but no answer came back (a timeout, a dropped connection): the order may have filled. Find out by its
      // client order id before anything retries it; if that can't be read either, treat it as filled. A missed
      // trim leaves the backstop resting; a second trim would act twice on one fall.
      if (r.status === 'failed' && r.failedAt === 'send' && r.cloid && r.action.type === 'order') {
        let known: { status: string; origSz: number; sz: number } | null | undefined;
        try {
          known = this.deps.orderStatus ? await this.deps.orderStatus(account, r.cloid) : undefined;
        } catch {
          known = undefined;
        }
        if (known === null) r.error = `${r.error}; Hyperliquid has no such order, so it never arrived`;
        else if (known) {
          r.assumedFilled = Math.max(0, known.origSz - known.sz);
          r.error = `${r.error}; Hyperliquid shows it ${known.status}, filled ${r.assumedFilled}`;
        } else {
          r.assumedFilled = r.action.size;
          r.error = `${r.error}; its outcome could not be read, so it is treated as filled and not retried`;
        }
      }
      if (r.status === 'sent' || r.status === 'failed') await store.addAction(account, now());
      // Health: an answer from the exchange means it is reachable and the key signed.
      if (r.result) {
        c.exchangeDownAt = 0;
        c.signerError = false;
        if (!r.result.ok && AGENT_GONE.test(r.error ?? '')) {
          c.agentExpired = true; // cleared only by the key check
          await this.deps.onAgentGone?.(account).catch(() => undefined);
        }
      } else if (r.failedAt === 'send') c.exchangeDownAt = now();
      else if (r.failedAt === 'sign') c.signerError = true;
    }
    await this.auditRecords(account, records);
    return records;
  }

  /** One audit entry per attempt, with what it filled. Entries name the market and side (10 Oct 2026; older entries keep their words, which the chain hashes). */
  private async auditRecords(account: Hex, records: readonly ExecutionRecord[]): Promise<void> {
    const now = this.deps.now;
    for (const r of records) {
      const a = r.action;
      const order = a.type === 'order' ? a : null;
      const fill = order && r.result ? `, filled ${filledSize(r)} of ${order.size}` : '';
      const attempt = order && (order.attempt ?? 1) > 1 ? ` (attempt ${order.attempt})` : '';
      await this.audit({
        account,
        at: now(),
        kind: r.status === 'rejected' ? 'rejected' : r.status === 'alert' ? 'alert' : a.type === 'trigger' ? 'backstop' : 'guard_action',
        why: a.reason,
        what:
          r.status === 'rejected'
            ? `Held back by ${r.violation?.invariant}: ${r.violation?.message}${attempt}`
            : a.type === 'trigger'
              ? `Stop ${r.status === 'sent' ? 'resting' : r.status}: ${a.isBuy ? 'buy' : 'sell'} ${a.size} ${a.coin} if the mark ${a.isBuy ? 'rises to' : 'falls to'} ${a.triggerPx} (limit ${a.limitPx})${r.error ? `: ${r.error}` : ''}`
              : a.type === 'cancel'
                ? `Cancel ${r.status === 'sent' ? 'done' : r.status}: ${a.coin} order ${a.oid}${r.error ? `: ${r.error}` : ''}`
                : `${actionWords(a, r.status)}${fill}${attempt}${r.error ? `: ${r.error}` : ''}`,
        proof: { ruleId: a.ruleId, nonce: r.nonce, cloid: r.cloid, statuses: r.result?.statuses, latencyMs: r.latencyMs, builderRetried: r.builderRetried, ...(order ? { attempt: order.attempt ?? 1, filled: filledSize(r), limitPx: order.limitPx, keys: order.keys } : {}), ...(a.type === 'trigger' ? { coin: a.coin, triggerPx: a.triggerPx, limitPx: a.limitPx, size: a.size, line: a.line, pricing: a.pricing } : {}), ...(a.type === 'cancel' ? { coin: a.coin, oid: a.oid } : {}), ...(r.failedAt ? { failedAt: r.failedAt } : {}) },
      });
    }
  }

  /** Carries out a command the user signed (the API verified the signature before queueing it). */
  /**
   * Carries out a command the user signed. The worker verifies the command's own signature, for this network
   * (security review F3, F5), and never trusts the queue. `signedAs`: the command the user signed when it differs
   * (a wipe starts with the stop step).
   */
  async command(cmd: PendingCommand & { signedAs?: PendingCommand['command'] }): Promise<Record<string, unknown>> {
    const account = cmd.account as Hex;
    const now = this.deps.now();
    const verified =
      Boolean(cmd.signature && cmd.chainId && cmd.network === this.deps.network) &&
      (await verifyCommandSignature({ account, command: cmd.signedAs ?? cmd.command, minutes: cmd.minutes, issuedAt: cmd.issuedAt, signature: cmd.signature as Hex, chainId: cmd.chainId as number, network: cmd.network as 'mainnet' | 'testnet' }));
    if (!verified) {
      await this.audit({ account, at: now, kind: 'rejected', why: 'A queued command whose signature could not be verified', what: `Not carried out: ${cmd.signedAs ?? cmd.command}`, proof: { commandId: cmd.id } });
      return { error: 'the command signature could not be verified for this network; sign it again', unverified: true };
    }
    const signer = await this.deps.commandSignerFor(account);
    const signed = { kind: cmd.command, minutes: cmd.minutes, issuedAt: cmd.issuedAt, acceptedAt: cmd.acceptedAt, verified: true } as const;
    if (cmd.command === 'stop') {
      const c = this.entry(account);
      const open = await this.openOrders(account, c);
      const mine = (await this.deps.store.guardOrders(account)).filter((o) => open.some((x) => x.oid === o.oid));
      const wire = stopCancels(mine.map((o) => ({ asset: (this.deps.assets.get(o.coin) as { assetId: number }).assetId, oid: o.oid })));
      if (!wire) return { cancelled: 0 };
      const nonce = this.deps.nonces.next(signer.address);
      const sig = await signer.signStopCancel({ kind: 'stop', issuedAt: cmd.issuedAt, acceptedAt: cmd.acceptedAt, verified: true }, wire, new Set(mine.map((o) => o.oid)), nonce, now);
      const res = await this.deps.exchange.send({ action: wire, nonce, signature: sig });
      if (res.ok) await this.deps.store.removeGuardOrders(account, mine.map((o) => o.oid));
      c.openOrders = c.openByDex = undefined;
      await this.audit({ account, at: now, kind: 'command', why: 'Kill switch', what: `Cancelled ${mine.length} guard order(s)${res.ok ? '' : `: ${res.error}`}`, proof: { statuses: res.statuses } });
      return { cancelled: res.ok ? mine.length : 0, error: res.error ?? null };
    }
    if (cmd.command === 'unwind') {
      const confirmed = await this.deps.store.policy(account);
      const c = this.entry(account);
      if (!c.stateAt) return { error: 'no account state yet' };
      // The same freshness limits as the guard's own actions (F9): no unwind priced from old data.
      const held = [...coinsOf(c)];
      const staleMark = held.find((coin) => !this.marks.has(coin) || now - (this.marks.get(coin) as { at: number }).at > MARK_MAX_AGE_MS);
      if (now - c.stateAt > STATE_MAX_AGE_MS || staleMark) return { error: `account data or prices are too old to unwind safely${staleMark ? ` (${staleMark})` : ''}; sign it again in a moment` };
      const snapshot = this.snapshot(account, c);
      const marks = Object.fromEntries(held.map((coin) => [coin, (this.marks.get(coin) as { px: number }).px]));
      const slip = confirmed?.policy.execution.maxSlippagePct ?? 1;
      const steps = planUnwind({ ...signed, kind: 'unwind' }, snapshot, marks, slip);
      const results: Array<Record<string, unknown>> = [];
      for (const step of steps) {
        const nonce = this.deps.nonces.next(signer.address);
        const sig = await signer.signUnwindStep({ ...signed, kind: 'unwind' }, step, snapshot, nonce, this.deps.now(), { mark: marks[step.coin] as number, maxSlippagePct: slip });
        const res = await this.deps.exchange.send({ action: step.wire, nonce, signature: sig });
        results.push({ coin: step.coin, type: step.wire.type, ok: res.ok, error: res.error ?? null });
      }
      await this.audit({ account, at: now, kind: 'command', why: 'Panic unwind you signed', what: `Closing ${steps.length} position(s), reduce-only`, proof: { results } });
      return { steps: results };
    }
    return {};
  }

  private async backstops(
    account: Hex,
    user: NonNullable<Awaited<ReturnType<GuardStore['user']>>>,
    confirmed: NonNullable<Awaited<ReturnType<GuardStore['policy']>>>,
    snapshot: AccountSnapshot,
    marks: Record<string, number>,
    ctx: GuardContext,
  ): Promise<void> {
    const { store } = this.deps;
    const c = this.entry(account);
    const open = await this.openOrders(account, c);
    const mine = await store.guardOrders(account);
    // Forget guard orders that are no longer open (filled, cancelled or expired).
    const gone = mine.filter((o) => !open.some((x) => x.oid === o.oid)).map((o) => o.oid);
    if (gone.length) await store.removeGuardOrders(account, gone);
    const live = mine.filter((o) => !gone.includes(o.oid));
    const existing: OpenOrder[] = live.map((o) => ({ coin: o.coin, oid: o.oid, side: 'A', reduceOnly: true, isTrigger: true, triggerPx: o.triggerPx, size: o.size }));
    const plan = planBackstops(confirmed.policy, snapshot, marks, existing, this.deps.backstopPricing ?? 'single');
    if (!plan.cancel.length && !plan.place.length) return;
    const records = await this.execute(account, user, confirmed, snapshot, marks, { ...ctx, openOrders: [...open, ...existing], guardOwnedOids: new Set(live.map((o) => o.oid)) }, [...plan.cancel, ...plan.place]);
    for (const r of records) {
      if (r.status !== 'sent') continue;
      if (r.action.type === 'cancel') await store.removeGuardOrders(account, [r.action.oid]);
      if (r.action.type === 'trigger') {
        const resting = r.result?.statuses.find((s) => s.kind === 'resting') as { oid: number } | undefined;
        if (resting)
          await store.addGuardOrder(account, { oid: resting.oid, coin: r.action.coin, kind: 'backstop', triggerPx: r.action.triggerPx, size: r.action.size, placedAt: this.deps.now(), ruleId: r.action.ruleId, line: r.action.line ?? null, pricing: r.action.pricing ?? null });
      }
    }
    c.openOrders = c.openByDex = undefined;
  }
}
