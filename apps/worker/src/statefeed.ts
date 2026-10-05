import type { RawClearinghouseState } from '@bulwarkxyz/guard-core';
import WebSocket from 'ws';
import type { SocketFactory, SocketLike } from './stream.js';

/**
 * Account state for the guard from two sources, chosen per account and per dex:
 *
 * - Hydromancer (primary, https://docs.hydromancer.xyz): `batchClearinghouseStates` polled for the
 *   dexes "" and "xyz", up to 1000 users a request, plus its builderApproved streams, which trigger
 *   an immediate refresh when one of our users trades, is funded, moves money or is liquidated.
 *   A state is used only if it is fresh: its own `time` no more than HYDRO_MAX_LAG_MS behind when
 *   it arrives, and received within HYDRO_STALE_MS.
 * - Hyperliquid directly (fallback): the `allDexsClearinghouseState` WebSocket, which Hyperliquid
 *   allows for 10 users per IP, and for everyone else `clearinghouseState` over REST within a weight
 *   budget. Native states are always kept, and used whenever the Hydromancer state is stale or
 *   missing, and for every dex Hydromancer is not polled for.
 */
export const HYDRO_POLL_MS = 5_000;
export const HYDRO_MAX_LAG_MS = 5_000;
export const HYDRO_STALE_MS = 15_000;
/** Hydromancer weights (docs: rate limits): 2 points a user, at most 100 points a request, 1000 users. */
export const HYDRO_USERS_PER_REQUEST = 1000;
export const hydroWeight = (users: number) => Math.min(2 * users, 100);
/** REST fallback: Hyperliquid allows 1200 weight a minute per IP; clearinghouseState weighs 2. Half is ours. */
export const NATIVE_FALLBACK_WEIGHT_PER_MIN = 600;
export const NATIVE_FALLBACK_EVERY_MS = 5_000;

export type StateSource = 'hydromancer' | 'native';
type Entry = { state: RawClearinghouseState; at: number };
type Emit = (user: string, states: Array<[string, RawClearinghouseState]>, at: number) => void;

/** A sliding one-minute budget of request weight. */
export class WeightBudget {
  private readonly spent: Array<{ at: number; w: number }> = [];
  constructor(
    readonly perMinute: number,
    private readonly now: () => number,
  ) {}
  used(): number {
    const t = this.now();
    while (this.spent.length && this.spent[0]!.at <= t - 60_000) this.spent.shift();
    return this.spent.reduce((n, s) => n + s.w, 0);
  }
  take(w: number): boolean {
    if (this.used() + w > this.perMinute) return false;
    this.spent.push({ at: this.now(), w });
    return true;
  }
}

export class StateArbiter {
  private readonly acc = new Map<string, Map<string, { hydromancer?: Entry; native?: Entry }>>();
  private readonly last = new Map<string, string>();

  constructor(
    private readonly emit: Emit,
    private readonly now: () => number = Date.now,
  ) {}

  hydromancer(user: string, dex: string, state: RawClearinghouseState, at: number): void {
    this.put(user, dex, 'hydromancer', { state, at });
  }

  native(user: string, states: Array<[string, RawClearinghouseState]>, at: number): void {
    for (const [dex, state] of states) this.slot(user, dex).native = { state, at };
    this.publish(user.toLowerCase());
  }

  /** True when this account's Hydromancer state for `dex` is fresh. */
  hydroFresh(user: string, dex: string): boolean {
    const h = this.acc.get(user.toLowerCase())?.get(dex)?.hydromancer;
    return Boolean(h && this.now() - h.at <= HYDRO_STALE_MS);
  }

  /** True when the native state for `dex` is fresh (it can stand in for Hydromancer). */
  nativeFresh(user: string, dex: string): boolean {
    const n = this.acc.get(user.toLowerCase())?.get(dex)?.native;
    return Boolean(n && this.now() - n.at <= HYDRO_STALE_MS);
  }

  /** Which source each dex of an account is using now. */
  sources(user: string): Record<string, StateSource> {
    const out: Record<string, StateSource> = {};
    for (const [dex] of this.acc.get(user.toLowerCase()) ?? []) {
      const pick = this.pick(user.toLowerCase(), dex);
      if (pick) out[dex] = pick.source;
    }
    return out;
  }

  /** Re-chooses for every account (call periodically, so a stale Hydromancer state falls back by itself). */
  republish(): void {
    for (const user of this.acc.keys()) this.publish(user);
  }

  private slot(user: string, dex: string) {
    const k = user.toLowerCase();
    let m = this.acc.get(k);
    if (!m) this.acc.set(k, (m = new Map()));
    let s = m.get(dex);
    if (!s) m.set(dex, (s = {}));
    return s;
  }

  private put(user: string, dex: string, source: StateSource, e: Entry) {
    this.slot(user, dex)[source] = e;
    this.publish(user.toLowerCase());
  }

  private pick(user: string, dex: string): (Entry & { source: StateSource }) | null {
    const s = this.acc.get(user)?.get(dex);
    if (!s) return null;
    if (s.hydromancer && this.now() - s.hydromancer.at <= HYDRO_STALE_MS) return { ...s.hydromancer, source: 'hydromancer' };
    if (s.native) return { ...s.native, source: 'native' };
    return s.hydromancer ? { ...s.hydromancer, source: 'hydromancer' } : null;
  }

  private publish(user: string) {
    const chosen: Array<[string, Entry & { source: StateSource }]> = [];
    for (const [dex] of this.acc.get(user) ?? []) {
      const p = this.pick(user, dex);
      if (p) chosen.push([dex, p]);
    }
    if (!chosen.length) return;
    const sig = chosen.map(([d, p]) => `${d}:${p.source}:${p.at}`).join('|');
    if (this.last.get(user) === sig) return;
    this.last.set(user, sig);
    // The account is only as fresh as its oldest chosen dex state.
    this.emit(user, chosen.map(([d, p]) => [d, p.state]), Math.min(...chosen.map(([, p]) => p.at)));
  }
}

export interface HydromancerFeedDeps {
  url: string;
  apiKey: string;
  dexes: readonly string[];
  /** The key's tier limit (points a minute); the feed keeps to this. */
  pointsPerMinute: number;
  onState(user: string, dex: string, state: RawClearinghouseState, at: number): void;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: Record<string, unknown>) => void;
}

/** Polls `batchClearinghouseStates`; `refresh` asks for some users at once (coalesced to one request a second). */
export class HydromancerFeed {
  private users: string[] = [];
  private readonly queued = new Set<string>();
  private flushing: ReturnType<typeof setTimeout> | null = null;
  readonly budget: WeightBudget;
  disabled: string | null = null;
  readonly stats = { requests: 0, points: 0, failures: 0, staleStates: 0, skippedForBudget: 0, lastOkAt: 0 };
  private readonly now: () => number;

  constructor(private readonly deps: HydromancerFeedDeps) {
    this.now = deps.now ?? Date.now;
    this.budget = new WeightBudget(deps.pointsPerMinute, this.now);
  }

  setUsers(users: Iterable<string>): void {
    this.users = [...new Set([...users].map((u) => u.toLowerCase()))];
  }

  async poll(): Promise<void> {
    await this.fetchStates(this.users);
  }

  refresh(users: Iterable<string>): void {
    const known = new Set(this.users);
    for (const u of users) if (known.has(u.toLowerCase())) this.queued.add(u.toLowerCase());
    if (!this.queued.size || this.flushing) return;
    this.flushing = setTimeout(() => {
      this.flushing = null;
      const batch = [...this.queued];
      this.queued.clear();
      void this.fetchStates(batch);
    }, 1_000);
  }

  stop(): void {
    if (this.flushing) clearTimeout(this.flushing);
  }

  async fetchStates(users: readonly string[]): Promise<void> {
    if (this.disabled || !users.length) return;
    for (const dex of this.deps.dexes) {
      for (let i = 0; i < users.length; i += HYDRO_USERS_PER_REQUEST) {
        const batch = users.slice(i, i + HYDRO_USERS_PER_REQUEST);
        const weight = hydroWeight(batch.length);
        if (!this.budget.take(weight)) {
          this.stats.skippedForBudget++;
          continue;
        }
        await this.request(batch, dex, weight);
        if (this.disabled) return;
      }
    }
  }

  private async request(batch: string[], dex: string, weight: number): Promise<void> {
    const f = this.deps.fetch ?? fetch;
    this.stats.requests++;
    this.stats.points += weight;
    try {
      const res = await f(`${this.deps.url}/info`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.deps.apiKey}`, 'content-type': 'application/json', 'user-agent': 'bulwark-worker/1.0' },
        body: JSON.stringify({ type: 'batchClearinghouseStates', users: batch, dex }),
        signal: AbortSignal.timeout(4_000),
      });
      if (res.status === 401 || res.status === 403) {
        this.disabled = `key refused (HTTP ${res.status})`;
        this.deps.log?.({ msg: 'hydromancer off', why: this.disabled, url: this.deps.url });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { successful_states?: Array<[string, RawClearinghouseState]>; failed_wallets?: string[] };
      const at = this.now();
      for (const [user, state] of body.successful_states ?? []) {
        // Staleness check: Hydromancer's own snapshot time must be recent.
        if (typeof state.time === 'number' && at - state.time > HYDRO_MAX_LAG_MS) {
          this.stats.staleStates++;
          continue;
        }
        this.deps.onState(user, dex, state, at);
      }
      this.stats.lastOkAt = at;
    } catch (e) {
      this.stats.failures++;
      this.deps.log?.({ msg: 'hydromancer request failed', dex, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** Native REST fallback for accounts with neither a fresh Hydromancer nor a fresh native WebSocket state. */
export class NativeFallbackPoller {
  readonly budget: WeightBudget;
  readonly stats = { requests: 0, skippedForBudget: 0, failures: 0 };
  constructor(
    private readonly arbiter: StateArbiter,
    private readonly clearinghouseState: (user: string, dex: string) => Promise<RawClearinghouseState>,
    private readonly dexes: readonly string[],
    private readonly now: () => number = Date.now,
    perMinute = NATIVE_FALLBACK_WEIGHT_PER_MIN,
  ) {
    this.budget = new WeightBudget(perMinute, now);
  }

  async poll(users: Iterable<string>): Promise<void> {
    for (const user of users) {
      for (const dex of this.dexes) {
        if (this.arbiter.hydroFresh(user, dex) || this.arbiter.nativeFresh(user, dex)) continue;
        if (!this.budget.take(2)) {
          this.stats.skippedForBudget++;
          return;
        }
        this.stats.requests++;
        try {
          const state = await this.clearinghouseState(user, dex);
          this.arbiter.native(user, [[dex, state]], this.now());
        } catch {
          this.stats.failures++;
        }
      }
    }
  }
}

export const BUILDER_STREAMS = ['builderApprovedFills', 'builderApprovedFundings', 'builderApprovedNonFundingLedgerEvents', 'builderLiquidations'] as const;
/** No message (events or the server's pings) for this long: reconnect. */
export const BUILDER_STREAM_SILENT_MS = 150_000;

export interface BuilderStreamHandlers {
  /** Users with a new fill, funding payment or ledger event: refresh their state now. */
  onActivity(users: string[]): void;
  /** A liquidation fill of one of the builder's users. */
  onLiquidation(user: string, fill: Record<string, unknown>): void;
  onStatus?(status: 'open' | 'closed', at: number): void;
}

/** Hydromancer's builderApproved streams for our builder address. */
export class BuilderStream {
  private socket: SocketLike | null = null;
  private closed = false;
  private backoff = 1_000;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  lastMessageAt = 0;
  events = 0;

  constructor(
    private readonly url: string,
    private readonly builder: string,
    private readonly handlers: BuilderStreamHandlers,
    private readonly factory: SocketFactory = (u) => new WebSocket(u) as unknown as SocketLike,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.socket && this.lastMessageAt && this.now() - this.lastMessageAt > BUILDER_STREAM_SILENT_MS) this.socket.close();
    }, 30_000);
  }

  stop(): void {
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.socket?.close();
  }

  private connect() {
    const s = this.factory(this.url);
    this.socket = s;
    s.on('open', () => {
      this.backoff = 1_000;
      this.lastMessageAt = this.now();
      for (const type of BUILDER_STREAMS) s.send(JSON.stringify({ type: 'subscribe', subscription: { type, builder: this.builder } }));
      this.handlers.onStatus?.('open', this.now());
    });
    s.on('message', (data) => this.onMessage(String(data)));
    s.on('error', () => undefined);
    s.on('close', () => {
      this.handlers.onStatus?.('closed', this.now());
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
  }

  onMessage(text: string): void {
    this.lastMessageAt = this.now();
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (m.type === 'ping' || m.channel === 'ping') {
      this.socket?.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    const kind = String(m.channel ?? m.type ?? '');
    if (!(BUILDER_STREAMS as readonly string[]).includes(kind)) return; // connected, subscriptionUpdate, …
    // Events come as [user, data] pairs (fills, fundings, liquidations) or objects with `user` (ledger events);
    // read them from any array field rather than rely on each stream's field name.
    const users = new Set<string>();
    for (const v of Object.values(m)) {
      if (!Array.isArray(v)) continue;
      for (const e of v) {
        if (Array.isArray(e) && typeof e[0] === 'string') {
          const user = e[0].toLowerCase();
          users.add(user);
          if (kind === 'builderLiquidations') this.handlers.onLiquidation(user, (e[1] ?? {}) as Record<string, unknown>);
        } else if (e && typeof e === 'object' && typeof (e as { user?: unknown }).user === 'string') users.add((e as { user: string }).user.toLowerCase());
      }
    }
    if (users.size) {
      this.events++;
      this.handlers.onActivity([...users]);
    }
  }
}
