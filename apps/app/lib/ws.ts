'use client';

import { NETWORK } from './env';

/**
 * One shared WebSocket to Hyperliquid for live market data (l2Book and trades), with ref-counted
 * subscriptions, a keep-alive ping and reconnects with backoff. Screens read it through hooks in hl.tsx,
 * which fall back to polling the REST endpoint whenever the stream is down or silent.
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket
 */
const URL = NETWORK === 'mainnet' ? 'wss://api.hyperliquid.xyz/ws' : 'wss://api.hyperliquid-testnet.xyz/ws';
const PING_MS = 30_000; // the server closes connections idle for 60 s

export type Sub = { type: 'l2Book'; coin: string } | { type: 'trades'; coin: string };
type Listener = (data: unknown) => void;

const keyOf = (s: Sub) => `${s.type}:${s.coin}`;

class Stream {
  private ws: WebSocket | null = null;
  private subs = new Map<string, { sub: Sub; listeners: Set<Listener> }>();
  private retry = 0;
  private ping: ReturnType<typeof setInterval> | null = null;
  private statusListeners = new Set<() => void>();
  /** Whether the socket is open, how many subscriptions are active, and when the last data message arrived (ms). */
  status = { open: false, active: 0, lastMessageAt: 0 };

  subscribe(sub: Sub, fn: Listener): () => void {
    const k = keyOf(sub);
    let entry = this.subs.get(k);
    if (!entry) {
      entry = { sub, listeners: new Set() };
      this.subs.set(k, entry);
      this.send({ method: 'subscribe', subscription: sub });
    }
    entry.listeners.add(fn);
    this.setStatus({ active: this.subs.size });
    this.ensure();
    return () => {
      const e = this.subs.get(k);
      if (!e) return;
      e.listeners.delete(fn);
      if (e.listeners.size === 0) {
        this.subs.delete(k);
        this.send({ method: 'unsubscribe', subscription: sub });
        this.setStatus({ active: this.subs.size });
      }
    };
  }

  onStatus(fn: () => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(patch: Partial<Stream['status']>) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.statusListeners) fn();
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private ensure() {
    if (typeof window === 'undefined' || this.ws) return;
    const ws = new WebSocket(URL);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus({ open: true });
      for (const { sub } of this.subs.values()) this.send({ method: 'subscribe', subscription: sub });
      this.ping = setInterval(() => this.send({ method: 'ping' }), PING_MS);
    };
    ws.onmessage = (ev) => {
      let msg: { channel?: string; data?: { coin?: string } | Array<{ coin?: string }> };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.channel !== 'l2Book' && msg.channel !== 'trades') return;
      const coin = Array.isArray(msg.data) ? msg.data[0]?.coin : msg.data?.coin;
      if (!coin) return;
      const entry = this.subs.get(`${msg.channel}:${coin}`);
      if (!entry) return;
      this.setStatus({ lastMessageAt: Date.now() });
      for (const fn of entry.listeners) fn(msg.data);
    };
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      this.ws = null;
      this.setStatus({ open: false });
      if (this.subs.size === 0) return;
      const wait = Math.min(15_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.ensure(), wait);
    };
    ws.onerror = () => ws.close();
  }
}

export const stream = new Stream();
