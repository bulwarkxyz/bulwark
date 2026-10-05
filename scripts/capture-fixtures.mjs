#!/usr/bin/env node
// Captures golden-test fixtures from Hyperliquid mainnet using read-only /info calls.
// It finds recent xyz traders, classifies them by account abstraction mode and saves
// their full per-dex clearinghouse state plus spot state at one moment.
// Addresses are replaced by labels; every value is otherwise exactly as the API returned it.
import { writeFile, mkdir } from 'node:fs/promises';

const API = 'https://api.hyperliquid.xyz/info';
const OUT = new URL('../packages/guard-core/test/fixtures/', import.meta.url);
const PACE_MS = 1100; // keeps us far below the 1200 weight/min IP limit

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function info(body, { pace = true } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    if (pace) await sleep(PACE_MS);
    return res.json();
  }
  throw new Error('rate limited');
}

const COINS = ['xyz:CL', 'xyz:SP500', 'xyz:GOLD', 'xyz:NVDA', 'xyz:SKHX', 'xyz:COIN', 'xyz:SILVER', 'xyz:MU', 'xyz:TSLA', 'BTC', 'ETH'];
const WANT = { unifiedAccount: 4, default: 2, disabled: 2, portfolioMargin: 2 };

const perpDexs = await info({ type: 'perpDexs' });
const allPerpMetas = await info({ type: 'allPerpMetas' });
const dexNames = perpDexs.map((d) => (d === null ? '' : d.name));

const users = new Set();
for (const coin of COINS) {
  const trades = await info({ type: 'recentTrades', coin });
  for (const t of trades) for (const u of t.users ?? []) users.add(u.toLowerCase());
}
console.error(`candidates: ${users.size}`);

const picked = {};
const counts = {};
for (const user of users) {
  if (Object.entries(WANT).every(([m, n]) => (counts[m] ?? 0) >= n)) break;
  const mode = await info({ type: 'userAbstraction', user });
  if (!(mode in WANT) || (counts[mode] ?? 0) >= WANT[mode]) continue;
  const xyz = await info({ type: 'clearinghouseState', user, dex: 'xyz' });
  if (!xyz.assetPositions?.length) continue;
  counts[mode] = (counts[mode] ?? 0) + 1;
  picked[user] = mode;
  console.error(`picked ${mode} (${counts[mode]}/${WANT[mode]})`);
}

await mkdir(OUT, { recursive: true });
await writeFile(new URL('allPerpMetas.json', OUT), JSON.stringify(allPerpMetas, null, 1));
await writeFile(new URL('perpDexs.json', OUT), JSON.stringify(perpDexs, null, 1));

let i = 0;
for (const [user, mode] of Object.entries(picked)) {
  i++;
  // Fetch every dex and spot back-to-back (weight 2 each) so the snapshot is as close to one moment as possible.
  const [spot, ...states] = await Promise.all([
    info({ type: 'spotClearinghouseState', user }, { pace: false }),
    ...dexNames.map((dex) => info({ type: 'clearinghouseState', user, dex }, { pace: false })),
  ]);
  const dexes = Object.fromEntries(dexNames.map((d, k) => [d, states[k]]));
  await sleep(PACE_MS * 3);
  const label = `${mode}-${i}`;
  const fixture = { label, mode, capturedAt: new Date().toISOString(), dexNames, dexes, spot };
  await writeFile(new URL(`account-${label}.json`, OUT), JSON.stringify(fixture, null, 1));
  console.error(`saved ${label}`);
}
