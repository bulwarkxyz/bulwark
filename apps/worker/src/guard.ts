import { executeActions, type Exchange, type ExecutionRecord, type GuardedSigner } from '@bulwarkxyz/executor';
import {
  assessRisk,
  buildSnapshot,
  evaluate,
  planBackstops,
  windowContains,
  windowStart,
  type AccountSnapshot,
  type AssetIndex,
  type ExecutionContext,
  type GuardContext,
  type OpenOrder,
  type RawClearinghouseState,
  type RawSpotState,
} from '@bulwarkxyz/guard-core';
import type { BuilderWire, Hex, Network, NonceManager } from '@bulwarkxyz/hyperliquid';
import type { AuditInput } from './audit.js';
import { formatRun, type Notifier } from './notify.js';
import type { GuardStore } from './store.js';

/** Engine constants (not user thresholds). */
export const MARK_MAX_AGE_MS = 10_000;
export const STATE_MAX_AGE_MS = 30_000;
export const DEGRADED_ALERT_EVERY_MS = 5 * 60_000;
export const BACKSTOP_EVERY_MS = 60_000;
export const OPEN_ORDERS_TTL_MS = 15_000;

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
  /** Builder field from config (null while the mainnet switch is off). */
  builder: BuilderWire | null;
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

  private entry(account: string): AccountCache {
    const k = account.toLowerCase();
    let c = this.cache.get(k);
    if (!c) {
      c = { dexStates: {}, stateAt: 0, spotAt: 0, lastBackstopAt: 0, positionsKey: '', lastDegradedAlert: 0 };
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
    if (!user || !confirmed) return;
    const c = this.entry(account);
    if (c.stateAt === 0) return;
    if (!c.abstraction) c.abstraction = await this.deps.abstraction(account);
    const now = this.deps.now();

    // Never act on stale data: hold off and tell the user (throttled). Backstops on the exchange still stand.
    const held = [...coinsOf(c)];
    // Before the first price for a held coin arrives there is nothing to judge yet: wait quietly.
    if (held.some((coin) => !this.marks.has(coin))) return;
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
      return;
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

    if (decision.actions.length) {
      const records = await this.execute(account, user, confirmed, snapshot, marks, ctx, decision.actions);
      c.openOrders = undefined;
      const text = formatRun(records);
      if (text && user.telegramChatId) await this.deps.notifier.send(user.telegramChatId, text).catch(() => undefined);
    }

    if (now - c.lastBackstopAt >= BACKSTOP_EVERY_MS && user.region === 'allowed' && !user.killSwitch) {
      c.lastBackstopAt = now;
      await this.backstops(account, user, confirmed, snapshot, marks, ctx);
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
    const records = await executeActions(actions, { policy: confirmed.policy, snapshot, marks, ctx: execCtx }, {
      network: this.deps.network,
      account,
      signer: await this.deps.signerFor(account),
      exchange: this.deps.exchange,
      nonces: this.deps.nonces,
      assets: this.deps.assets,
      builder,
      now,
    });
    for (const r of records) {
      if (r.status === 'sent' || r.status === 'failed') await store.addAction(account, now());
      await this.audit({
        account,
        at: now(),
        kind: r.status === 'rejected' ? 'rejected' : r.status === 'alert' ? 'alert' : r.action.type === 'trigger' ? 'backstop' : 'guard_action',
        why: r.action.reason,
        what: r.status === 'rejected' ? `Held back by ${r.violation?.invariant}: ${r.violation?.message}` : `${r.action.type} ${r.status}${r.error ? `: ${r.error}` : ''}`,
        proof: { ruleId: r.action.ruleId, nonce: r.nonce, cloid: r.cloid, statuses: r.result?.statuses, latencyMs: r.latencyMs, builderRetried: r.builderRetried },
      });
    }
    return records;
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
