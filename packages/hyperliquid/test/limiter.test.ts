import { describe, expect, it } from 'vitest';
import { RateBudgetError, WeightLimiter, infoWeight, limitedFetch } from '../src/limiter.js';

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}

describe('Hyperliquid weight limiter', () => {
  it('uses the documented weights', () => {
    expect(infoWeight({ type: 'clearinghouseState' })).toBe(2);
    expect(infoWeight({ type: 'allMids' })).toBe(2);
    expect(infoWeight({ type: 'userRole' })).toBe(60);
    expect(infoWeight({ type: 'frontendOpenOrders' })).toBe(20);
    expect(infoWeight({ type: 'extraAgents' })).toBe(20);
    expect(infoWeight(null)).toBe(20);
  });

  it('never lets more than the budget through in any minute; the rest wait their turn in order', async () => {
    const c = clock();
    const l = new WeightLimiter(100, c.now, c.sleep);
    const at: number[] = [];
    await Promise.all(Array.from({ length: 12 }, () => l.acquire(20, 300_000).then(() => at.push(c.now()))));
    expect(at.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(at[5]).toBe(60_000);
    for (const t of at) expect(at.filter((x) => x > t - 60_000 && x <= t).length * 20).toBeLessThanOrEqual(100);
  });

  it('refuses rather than wait past the limit, and a refusal does not block the queue', async () => {
    const c = clock();
    const l = new WeightLimiter(40, c.now, c.sleep);
    await l.acquire(20, 1000);
    await l.acquire(20, 1000);
    await expect(l.acquire(20, 1000)).rejects.toBeInstanceOf(RateBudgetError);
    c.advance(60_000);
    await expect(l.acquire(20, 1000)).resolves.toBeUndefined();
  });

  it('a 429 holds every request for the backoff', async () => {
    const c = clock();
    const l = new WeightLimiter(1000, c.now, c.sleep);
    let calls = 0;
    const f = limitedFetch(l, (async () => (calls++, new Response('null', { status: calls === 1 ? 429 : 200 }))) as never, 60_000, 10_000);
    await f('x', { method: 'POST', body: JSON.stringify({ type: 'allMids' }) });
    expect(l.stats.throttled).toBe(1);
    await f('x', { method: 'POST', body: JSON.stringify({ type: 'allMids' }) });
    expect(c.now()).toBe(10_000);
  });
});
