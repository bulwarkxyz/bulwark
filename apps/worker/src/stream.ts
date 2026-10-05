import type { RawClearinghouseState, RawSpotState } from '@bulwarkxyz/guard-core';
import WebSocket from 'ws';

/**
 * One WebSocket connection to Hyperliquid with resubscribe-on-reconnect and a heartbeat.
 * Limits per IP: 10 connections, 1000 subscriptions, 10 unique users across user subscriptions.
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
 * Channels used (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions):
 *   allDexsAssetCtxs              → marks for every dex, ~1 s
 *   allDexsClearinghouseState{u}  → per-dex state for a user, ~5 s and on events
 *   spotState{u}                  → spot balances (the collateral for unified accounts)
 */
export const MAX_USERS_PER_CONNECTION = 10;

export interface SocketLike {
  on(event: 'open' | 'close' | 'error' | 'message', cb: (arg?: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;
const defaultFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

export interface StreamHandlers {
  onMarks?(ctxs: Array<[string, Array<{ markPx: string; oraclePx: string }>]>, at: number): void;
  onUserState?(user: string, states: Array<[string, RawClearinghouseState]>, at: number): void;
  onSpotState?(user: string, spot: RawSpotState, at: number): void;
  onStatus?(status: 'open' | 'closed', at: number): void;
}

export class HyperliquidStream {
  private socket: SocketLike | null = null;
  private readonly subs: Array<Record<string, unknown>> = [];
  private readonly users = new Set<string>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private backoff = 500;
  private closed = false;
  private isOpen = false;
  lastMessageAt = 0;

  constructor(
    private readonly url: string,
    private readonly handlers: StreamHandlers,
    private readonly factory: SocketFactory = defaultFactory,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
  }

  subscribeMarks(): void {
    this.add({ type: 'allDexsAssetCtxs' });
  }

  subscribeUser(user: string): void {
    const u = user.toLowerCase();
    if (this.users.has(u)) return;
    if (this.users.size >= MAX_USERS_PER_CONNECTION) throw new Error('connection already tracks 10 users');
    this.users.add(u);
    this.add({ type: 'allDexsClearinghouseState', user: u });
    this.add({ type: 'spotState', user: u });
  }

  get userCount(): number {
    return this.users.size;
  }

  private add(sub: Record<string, unknown>) {
    this.subs.push(sub);
    // While connecting, subscriptions wait and are sent on open with the rest.
    if (this.isOpen) this.socket?.send(JSON.stringify({ method: 'subscribe', subscription: sub }));
  }

  private connect() {
    const s = this.factory(this.url);
    this.socket = s;
    s.on('open', () => {
      this.isOpen = true;
      this.backoff = 500;
      for (const sub of this.subs) s.send(JSON.stringify({ method: 'subscribe', subscription: sub }));
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => s.send(JSON.stringify({ method: 'ping' })), 30_000);
      this.handlers.onStatus?.('open', this.now());
    });
    s.on('message', (raw) => this.dispatch(String(raw)));
    s.on('close', () => {
      this.isOpen = false;
      this.handlers.onStatus?.('closed', this.now());
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15_000);
    });
    s.on('error', () => s.close());
  }

  /** Exposed for tests. */
  dispatch(raw: string): void {
    const at = this.now();
    this.lastMessageAt = at;
    let msg: { channel?: string; data?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const d = msg.data;
    if (!d) return;
    switch (msg.channel) {
      case 'allDexsAssetCtxs':
        this.handlers.onMarks?.(d.ctxs as never, at);
        break;
      case 'allDexsClearinghouseState':
        this.handlers.onUserState?.(String(d.user).toLowerCase(), d.clearinghouseStates as never, at);
        break;
      case 'spotState':
        this.handlers.onSpotState?.(String(d.user).toLowerCase(), d.spotState as never, at);
        break;
    }
  }
}

/** Turns an allDexsAssetCtxs payload into coin → mark using each dex's universe order. */
export function marksFromCtxs(ctxs: Array<[string, Array<{ markPx: string }>]>, universe: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [dex, list] of ctxs) {
    const coins = universe.get(dex);
    if (!coins) continue;
    list.forEach((c, i) => {
      const coin = coins[i];
      const m = Number(c.markPx);
      if (coin && Number.isFinite(m) && m > 0) out.set(coin, m);
    });
  }
  return out;
}
