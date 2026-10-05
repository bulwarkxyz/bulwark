import { executeActions, planUnwind, stopCancels, type CommandSigner, type Exchange, type ExecutionRecord, type GuardedSigner } from '@bulwarkxyz/executor';
import {
  assessRisk,
  buildSnapshot,
  evaluate,
  planBackstops,
  planRetries,
  recordFill,
  windowContains,
  windowStart,
  type AccountSnapshot,
  type AssetIndex,
  type ExecutionContext,
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
export const BACKSTOP_EVERY_MS = 60_000;
export const OPEN_ORDERS_TTL_MS = 15_000;
/** The status is written when it changes, and at least this often while the account is evaluated. */
export const STATUS_WRITE_EVERY_MS = 15_000;
/** How often the guard key is checked: still approved on Hyperliquid, not expired, loadable by the signer. */
export const KEY_CHECK_EVERY_MS = 60_000;
/** After the exchange did not answer, the guard shows as paused this long unless a later request gets through. */
export const EXCHANGE_DOWN_HOLD_MS = 120_000;
/** Exchange errors that mean the guard key is no longer approved for the account. */
const AGENT_GONE = /does not exist|agent.*expired|api wallet.*(expired|invalid)/i;

/** Size an order record actually filled (0 when it missed, was held back or failed). */
export function filledSize(r: ExecutionRecord): number {
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
  /** Agents the user has approved on Hyperliquid (`extraAgents`), to tell when the guard key expired or was removed. */
  agents?(user: Hex): Promise<Array<{ address: string; validUntil?: number | null }>>;
  now(): number;
}

interface AccountCache {
  abstraction?: string;
  dexStates: Record<string, RawClearinghouseState>;
  stateAt: number;
  spot?: RawSpotState;
  spotAt: number;
  openOrders?: { at: number; orders: OpenOrder[] } | undefined;
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
}

const coinsOf = (c: AccountCache) => new Set(Object.values(c.dexStates).flatMap((s) => s.assetPositions.map((p) => p.position.coin)));
const positionsKey = (c: AccountCache) =>
  Object.values(c.dexStates)
    .flatMap((s) => s.assetPositions.map((p) => `${p.position.coin}:${p.position.szi}`))
    .sort()
    .join('|');

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

  onUserState(account: string, states: Array<[string, RawClearinghouseState]>, at: number): Promise<void> {
    const c = this.entry(account);
    c.dexStates = Object.fromEntries(states);
    c.stateAt = at;
    const key = positionsKey(c);
    if (key !== c.positionsKey) {
      c.positionsKey = key;
      c.lastBackstopAt = 0; // positions changed: re-plan backstops
      c.openOrders = undefined;
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
        await this.run(k as Hex);
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

  private async openOrders(account: Hex, c: AccountCache): Promise<OpenOrder[]> {
    const now = this.deps.now();
    if (c.openOrders && now - c.openOrders.at < OPEN_ORDERS_TTL_MS) return c.openOrders.orders;
    const dexes = new Set(['', ...Object.keys(c.dexStates)]);
    const orders = (await Promise.all([...dexes].map((d) => this.deps.openOrders(account, d)))).flat();
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
    if (c.stateAt === 0) return report('paused', 'stale_data');
    if (!c.abstraction) c.abstraction = await this.deps.abstraction(account);

    // Never act on stale data: hold off and tell the user (throttled). Backstops on the exchange still stand.
    const held = [...coinsOf(c)];
    // Before the first price for a held coin arrives there is nothing to judge yet: wait quietly.
    if (held.some((coin) => !this.marks.has(coin))) return report('paused', 'stale_data');
    const staleMark = held.find((coin) => now - (this.marks.get(coin) as { at: number }).at > MARK_MAX_AGE_MS);
    const needsSpot = c.abstraction === 'unifiedAccount';
    const staleState = now - c.stateAt > STATE_MAX_AGE_MS || (needsSpot && now - c.spotAt > STATE_MAX_AGE_MS);
    if (held.length && (staleMark || staleState)) {
      if (now - c.lastDegradedAlert > DEGRADED_ALERT_EVERY_MS) {
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
    const ctx: GuardContext = {
      now,
      baselines,
      openOrders: needsOrders ? await this.openOrders(account, c) : [],
      latched: await store.latched(account),
      automationAllowed: user.region === 'allowed',
      guardOwnedOids: new Set(guardOrders.map((o) => o.oid)),
    };
    const decision = evaluate(policy, snapshot, marks, ctx);
    await store.saveLatched(account, decision.latched);
    c.lastEvaluatedAt = now;
    await this.checkKey(account, user, c, now);

    // Orders that did not fully fill are retried, re-priced, while their stage still holds (guard-core retry.ts).
    const before = await store.retries(account);
    const plan = planRetries(decision, before, { slippagePct: policy.execution.maxSlippagePct, automationAllowed: ctx.automationAllowed && !user.killSwitch, stateAt: c.stateAt });
    let chains: RetryChain[] = plan.chains;
    let records: ExecutionRecord[] = [];
    if (plan.actions.length) {
      records = await this.execute(account, user, confirmed, snapshot, marks, ctx, plan.actions);
      c.openOrders = undefined;
      if (!user.killSwitch) for (const r of records) if (r.action.type === 'order') chains = recordFill(chains, r.action, filledSize(r), now);
      // A retry that missed again is in the audit log; the user hears about fills, and the alert after repeated misses.
      const told = records.filter((r) => !(r.action.type === 'order' && (r.action.attempt ?? 1) > 1 && filledSize(r) === 0));
      const text = formatRun(told);
      if (text && user.telegramChatId) await this.deps.notifier.send(user.telegramChatId, text).catch(() => undefined);
    }
    if (JSON.stringify(chains) !== JSON.stringify(before)) await store.saveRetries(account, chains);

    if (now - c.lastBackstopAt >= BACKSTOP_EVERY_MS && user.region === 'allowed' && !user.killSwitch) {
      c.lastBackstopAt = now;
      await this.backstops(account, user, confirmed, snapshot, marks, ctx);
    }

    const paused = this.pausedReason(c, now);
    const acting = chains.length > 0 || records.some((r) => r.action.type !== 'alert' && r.status !== 'rejected');
    if (paused) return report('paused', paused);
    if (user.region !== 'allowed') return report('alerts_only');
    if (acting) return report('acting');
    if (decision.active.size > 0) return report('at_risk');
    return report('protected');
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
      confirmation: { policyHash: confirmed.hash, signatureVerified: confirmed.signatureVerified },
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
      if (r.status === 'sent' || r.status === 'failed') await store.addAction(account, now());
      // Health: an answer from the exchange means it is reachable and the key signed.
      if (r.result) {
        c.exchangeDownAt = 0;
        c.signerError = false;
        if (!r.result.ok && AGENT_GONE.test(r.error ?? '')) c.agentExpired = true; // cleared only by the key check
      } else if (r.failedAt === 'send') c.exchangeDownAt = now();
      else if (r.failedAt === 'sign') c.signerError = true;
    }
    await this.auditRecords(account, records);
    return records;
  }

  /** One audit entry per attempt, with what it filled. */
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
        what: r.status === 'rejected' ? `Held back by ${r.violation?.invariant}: ${r.violation?.message}${attempt}` : `${a.type} ${r.status}${fill}${attempt}${r.error ? `: ${r.error}` : ''}`,
        proof: { ruleId: a.ruleId, nonce: r.nonce, cloid: r.cloid, statuses: r.result?.statuses, latencyMs: r.latencyMs, builderRetried: r.builderRetried, ...(order ? { attempt: order.attempt ?? 1, filled: filledSize(r), limitPx: order.limitPx, keys: order.keys } : {}), ...(r.failedAt ? { failedAt: r.failedAt } : {}) },
      });
    }
  }

  /** Carries out a command the user signed (the API verified the signature before queueing it). */
  async command(cmd: PendingCommand): Promise<Record<string, unknown>> {
    const account = cmd.account as Hex;
    const now = this.deps.now();
    const signer = await this.deps.commandSignerFor(account);
    const signed = { kind: cmd.command, minutes: cmd.minutes, issuedAt: cmd.issuedAt, verified: true } as const;
    if (cmd.command === 'stop') {
      const c = this.entry(account);
      const open = await this.openOrders(account, c);
      const mine = (await this.deps.store.guardOrders(account)).filter((o) => open.some((x) => x.oid === o.oid));
      const wire = stopCancels(mine.map((o) => ({ asset: (this.deps.assets.get(o.coin) as { assetId: number }).assetId, oid: o.oid })));
      if (!wire) return { cancelled: 0 };
      const nonce = this.deps.nonces.next(signer.address);
      const sig = await signer.signStopCancel({ kind: 'stop', issuedAt: cmd.issuedAt, verified: true }, wire, new Set(mine.map((o) => o.oid)), nonce, now);
      const res = await this.deps.exchange.send({ action: wire, nonce, signature: sig });
      if (res.ok) await this.deps.store.removeGuardOrders(account, mine.map((o) => o.oid));
      c.openOrders = undefined;
      await this.audit({ account, at: now, kind: 'command', why: 'Kill switch', what: `Cancelled ${mine.length} guard order(s)${res.ok ? '' : `: ${res.error}`}`, proof: { statuses: res.statuses } });
      return { cancelled: res.ok ? mine.length : 0, error: res.error ?? null };
    }
    if (cmd.command === 'unwind') {
      const confirmed = await this.deps.store.policy(account);
      const c = this.entry(account);
      if (!c.stateAt) return { error: 'no account state yet' };
      const snapshot = this.snapshot(account, c);
      const marks = Object.fromEntries([...coinsOf(c)].flatMap((coin) => (this.marks.has(coin) ? [[coin, (this.marks.get(coin) as { px: number }).px]] : [])));
      const steps = planUnwind({ ...signed, kind: 'unwind' }, snapshot, marks, confirmed?.policy.execution.maxSlippagePct ?? 1);
      const results: Array<Record<string, unknown>> = [];
      for (const step of steps) {
        const nonce = this.deps.nonces.next(signer.address);
        const sig = await signer.signUnwindStep({ ...signed, kind: 'unwind' }, step, snapshot, nonce, this.deps.now());
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
    const plan = planBackstops(confirmed.policy, snapshot, marks, existing);
    if (!plan.cancel.length && !plan.place.length) return;
    const records = await this.execute(account, user, confirmed, snapshot, marks, { ...ctx, openOrders: [...open, ...existing], guardOwnedOids: new Set(live.map((o) => o.oid)) }, [...plan.cancel, ...plan.place]);
    for (const r of records) {
      if (r.status !== 'sent') continue;
      if (r.action.type === 'cancel') await store.removeGuardOrders(account, [r.action.oid]);
      if (r.action.type === 'trigger') {
        const resting = r.result?.statuses.find((s) => s.kind === 'resting') as { oid: number } | undefined;
        if (resting) await store.addGuardOrder(account, { oid: resting.oid, coin: r.action.coin, kind: 'backstop', triggerPx: r.action.triggerPx, size: r.action.size, placedAt: this.deps.now() });
      }
    }
    c.openOrders = undefined;
  }
}
