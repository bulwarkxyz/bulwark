/**
 * How many guarded accounts the account-state feed keeps fresh when Hydromancer is off (testnet today): the first
 * MAX_USERS_PER_CONNECTION accounts on Hyperliquid's own WebSocket, the rest on the REST fallback poller and its
 * weight budget. Simulated clock; the exchange answers at once. Reports, per account count, how many accounts the
 * guard would hold off on (state older than STATE_MAX_AGE_MS) after a warm-up.
 *
 *   npx tsx bench/feed-capacity.ts
 */
import type { RawClearinghouseState } from '@bulwarkxyz/guard-core';
import { STATE_MAX_AGE_MS } from '../src/guard.js';
import { NATIVE_FALLBACK_EVERY_MS, NativeFallbackPoller, StateArbiter } from '../src/statefeed.js';
import { MAX_USERS_PER_CONNECTION } from '../src/stream.js';

const state = {} as RawClearinghouseState;
export function simulate(accounts: number, minutes = 5) {
  let t = 0;
  const last = new Map<string, number>();
  const arbiter = new StateArbiter((u, _s, at) => last.set(u, at), () => t);
  const poller = new NativeFallbackPoller(arbiter, async () => state, ['', 'xyz'], () => t);
  const users = Array.from({ length: accounts }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
  const ws = new Set(users.slice(0, MAX_USERS_PER_CONNECTION));
  let worstAge = 0;
  const stale = new Set<string>();
  return (async () => {
    for (t = 0; t <= minutes * 60_000; t += 1000) {
      // Native WebSocket users get a push about every 5 s.
      if (t % 5000 === 0) for (const u of ws) arbiter.native(u, [['', state], ['xyz', state]], t);
      if (t % NATIVE_FALLBACK_EVERY_MS === 0) {
        arbiter.republish();
        await poller.poll(users);
      }
      if (t > 60_000) for (const u of users) {
        const age = t - (last.get(u) ?? -Infinity);
        worstAge = Math.max(worstAge, age);
        if (age > STATE_MAX_AGE_MS) stale.add(u);
      }
    }
    return { accounts, staleAccounts: stale.size, worstAgeS: Number.isFinite(worstAge) ? Math.round(worstAge / 1000) : Infinity, requests: poller.stats.requests, skippedForBudget: poller.stats.skippedForBudget };
  })();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const n of [10, 25, 40, 50, 75, 85, 100, 150, 300]) console.log(JSON.stringify(await simulate(n)));
}
