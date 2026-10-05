/**
 * Keeps a process under Hyperliquid's REST limit: 1200 weight a minute per IP, shared by every request.
 * Weights (docs: rate limits and user limits): l2Book, allMids, clearinghouseState, orderStatus,
 * spotClearinghouseState and exchangeStatus weigh 2; userRole 60; every other info request 20.
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
 */
import type { Fetch } from './clients.js';

const LIGHT = new Set(['l2Book', 'allMids', 'clearinghouseState', 'orderStatus', 'spotClearinghouseState', 'exchangeStatus']);

/** The documented base weight of one info request (the per-item extras of history endpoints aren't counted). */
export function infoWeight(body: { type?: string } | null | undefined): number {
  const t = body?.type ?? '';
  return LIGHT.has(t) ? 2 : t === 'userRole' ? 60 : 20;
}

export class RateBudgetError extends Error {
  constructor(readonly waitedMs: number) {
    super(`rate budget: would wait more than ${waitedMs} ms`);
  }
}

/** A sliding one-minute weight window. Requests queue in order; a 429 pauses everyone briefly. */
export class WeightLimiter {
  private readonly spent: Array<{ at: number; w: number }> = [];
  private pausedUntil = 0;
  private queue: Promise<void> = Promise.resolve();
  readonly stats = { requests: 0, waited: 0, refused: 0, throttled: 0 };

  constructor(
    readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  used(): number {
    const t = this.now();
    while (this.spent.length && this.spent[0]!.at <= t - 60_000) this.spent.shift();
    return this.spent.reduce((n, s) => n + s.w, 0);
  }

  /** How long until `w` more weight fits (0 if now). */
  private waitFor(w: number): number {
    const t = this.now();
    if (t < this.pausedUntil) return this.pausedUntil - t;
    let used = this.used();
    if (used + w <= this.perMinute) return 0;
    for (const s of this.spent) {
      used -= s.w;
      if (used + w <= this.perMinute) return s.at + 60_000 - t;
    }
    return 60_000;
  }

  /** Waits its turn and for room in the window; refuses if that would take longer than maxWaitMs. */
  acquire(w: number, maxWaitMs: number): Promise<void> {
    const turn = this.queue.then(async () => {
      const start = this.now();
      for (;;) {
        const wait = this.waitFor(w);
        if (wait === 0) break;
        if (this.now() - start + wait > maxWaitMs) {
          this.stats.refused++;
          throw new RateBudgetError(maxWaitMs);
        }
        this.stats.waited++;
        await this.sleep(wait);
      }
      this.spent.push({ at: this.now(), w });
      this.stats.requests++;
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  /** Hyperliquid answered 429: hold every request for a while. */
  backoff(ms: number): void {
    this.stats.throttled++;
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }
}

/** A fetch for InfoClient that takes each request's weight from the limiter first. */
export function limitedFetch(limiter: WeightLimiter, base: Fetch = fetch, maxWaitMs = 20_000, backoffMs = 10_000): Fetch {
  return (async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    let body: { type?: string } | null = null;
    try {
      body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { type?: string }) : null;
    } catch {
      body = null;
    }
    await limiter.acquire(infoWeight(body), maxWaitMs);
    const res = await base(input, init);
    if (res.status === 429) limiter.backoff(backoffMs);
    return res;
  }) as Fetch;
}
