/**
 * B3 parity run (read-only): does the guard's live margin model track Hyperliquid's own numbers?
 *
 * Watches N public accounts that hold xyz positions (mixed account modes) over WebSocket. On every state
 * push it compares, per pool:
 *   model   = previous snapshot revalued at the new push's marks (what the guard computes between pushes)
 *   actual  = the new push itself (Hyperliquid's own state)
 *   live    = previous snapshot revalued at the latest WebSocket marks when the push arrived
 * Pairs where positions changed size are skipped. Funding moves equity without moving marks, so pairs
 * spanning an hourly funding time are reported separately.
 *
 *   PARITY_MINUTES=60 PARITY_USERS=5 pnpm --filter @bulwarkxyz/worker parity
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { assessRisk, buildAssetIndex, buildSnapshot, dexCollateral, type AccountSnapshot, type RawClearinghouseState, type RawPerpDexs, type RawPerpMeta, type RawSpotState } from '@bulwarkxyz/guard-core';
import { InfoClient } from '@bulwarkxyz/hyperliquid';
import { HyperliquidStream, marksFromCtxs } from './stream.js';

const MINUTES = Number(process.env.PARITY_MINUTES ?? 60);
const USERS = Math.min(10, Number(process.env.PARITY_USERS ?? 5));
const info = new InfoClient('mainnet');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Sample {
  user: string;
  mode: string;
  pool: string;
  at: number;
  modelRatio: number;
  actualRatio: number;
  liveRatio: number;
  relModel: number;
  relLive: number;
  fundingCrossed: boolean;
}

const samples: Sample[] = [];
const skipped: Record<string, number> = {};
let status: Record<string, unknown> = { state: 'starting' };
http.createServer((_, res) => res.end(JSON.stringify(summary(), null, 1))).listen(Number(process.env.PORT ?? 8080));

function q(a: number[], p: number) {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s[Math.min(s.length - 1, Math.floor(p * s.length))] as number) : null;
}
function summary() {
  const clean = samples.filter((s) => !s.fundingCrossed);
  const rel = clean.map((s) => s.relModel);
  const live = clean.map((s) => s.relLive);
  return {
    ...status,
    samples: samples.length,
    comparedWithoutFunding: clean.length,
    skipped,
    model_vs_actual_rel_error: { p50: q(rel, 0.5), p90: q(rel, 0.9), p99: q(rel, 0.99), max: rel.length ? Math.max(...rel) : null, within_1e4: rel.filter((x) => x <= 1e-4).length },
    live_vs_actual_rel_error: { p50: q(live, 0.5), p90: q(live, 0.9), p99: q(live, 0.99), max: live.length ? Math.max(...live) : null },
    fundingCrossed: samples.filter((s) => s.fundingCrossed).length,
    perUser: [...new Set(samples.map((s) => s.user))].map((u) => ({ user: `${u.slice(0, 6)}…${u.slice(-4)}`, mode: samples.find((s) => s.user === u)?.mode, n: samples.filter((s) => s.user === u).length })),
  };
}

async function pickUsers(): Promise<Array<{ user: string; mode: string }>> {
  const coins = ['xyz:CL', 'xyz:SP500', 'xyz:GOLD', 'xyz:NVDA', 'xyz:SKHX', 'xyz:SILVER', 'xyz:BRENTOIL', 'xyz:XYZ100'];
  const seen = new Set<string>();
  for (const coin of coins) {
    const trades = await info.request<Array<{ users?: string[] }>>({ type: 'recentTrades', coin });
    for (const t of trades) for (const u of t.users ?? []) seen.add(u.toLowerCase());
    await sleep(1100);
  }
  const want: Record<string, number> = { unifiedAccount: Math.ceil(USERS / 2), default: USERS, disabled: USERS };
  const out: Array<{ user: string; mode: string }> = [];
  for (const user of seen) {
    if (out.length >= USERS) break;
    const mode = await info.userAbstraction(user as `0x${string}`);
    await sleep(1100);
    if (!(mode in want) || out.filter((o) => o.mode === mode).length >= (want[mode] ?? 0)) continue;
    const st = (await info.clearinghouseState(user as `0x${string}`, 'xyz')) as RawClearinghouseState;
    await sleep(1100);
    if (st.assetPositions.length) out.push({ user, mode });
  }
  return out;
}

const sizesKey = (snap: AccountSnapshot) => snap.positions.map((p) => `${p.key}:${p.size}`).sort().join('|');
const crossesFundingHour = (a: number, b: number) => Math.floor(a / 3_600_000) !== Math.floor(b / 3_600_000);

async function main() {
  const perpDexs = (await info.perpDexs()) as RawPerpDexs;
  const metas = (await info.allPerpMetas()) as RawPerpMeta[];
  const assets = buildAssetIndex(perpDexs, metas);
  const collateral = dexCollateral(perpDexs, metas);
  const universe = new Map(metas.map((m, i) => [perpDexs[i] === null ? '' : (perpDexs[i] as { name: string }).name, m.universe.map((u) => u.name)]));

  const users = await pickUsers();
  status = { state: 'running', startedAt: new Date().toISOString(), minutes: MINUTES, users: users.map((u) => ({ user: `${u.user.slice(0, 6)}…${u.user.slice(-4)}`, mode: u.mode })) };
  console.log(JSON.stringify(status));

  const modeOf = new Map(users.map((u) => [u.user, u.mode]));
  const spot = new Map<string, RawSpotState>();
  const prev = new Map<string, { snap: AccountSnapshot; at: number }>();
  let liveMarks = new Map<string, number>();

  const stream = new HyperliquidStream('wss://api.hyperliquid.xyz/ws', {
    onMarks: (ctxs) => {
      liveMarks = marksFromCtxs(ctxs, universe);
    },
    onSpotState: (user, s) => {
      spot.set(user, s);
    },
    onUserState: (user, states, at) => {
      const mode = modeOf.get(user) ?? 'default';
      if (mode === 'unifiedAccount' && !spot.has(user)) return;
      let snap: AccountSnapshot;
      try {
        snap = buildSnapshot({ abstraction: mode, dexStates: Object.fromEntries(states), spot: spot.get(user) ?? { balances: [] }, assets, dexCollateral: collateral, time: at });
      } catch (e) {
        skipped.unknownAsset = (skipped.unknownAsset ?? 0) + 1;
        return;
      }
      const before = prev.get(user);
      prev.set(user, { snap, at });
      if (!before) return;
      if (sizesKey(before.snap) !== sizesKey(snap)) {
        skipped.positionsChanged = (skipped.positionsChanged ?? 0) + 1;
        return;
      }
      const pushMarks = Object.fromEntries(snap.positions.map((p) => [p.coin, p.markAtSnapshot]));
      const wsMarks = Object.fromEntries(snap.positions.map((p) => [p.coin, liveMarks.get(p.coin) ?? p.markAtSnapshot]));
      const model = assessRisk(before.snap, pushMarks);
      const live = assessRisk(before.snap, wsMarks);
      const actual = assessRisk(snap);
      for (const pool of actual.pools) {
        if (pool.maintenance === 0) continue;
        const m = model.pools.find((p) => p.pool.id === pool.pool.id);
        const l = live.pools.find((p) => p.pool.id === pool.pool.id);
        if (!m || !l) {
          skipped.poolMissing = (skipped.poolMissing ?? 0) + 1;
          continue;
        }
        samples.push({
          user,
          mode,
          pool: pool.pool.id,
          at,
          modelRatio: m.ratio,
          actualRatio: pool.ratio,
          liveRatio: l.ratio,
          relModel: Math.abs(m.ratio - pool.ratio) / pool.ratio,
          relLive: Math.abs(l.ratio - pool.ratio) / pool.ratio,
          fundingCrossed: crossesFundingHour(before.at, at),
        });
      }
    },
  });
  stream.subscribeMarks();
  for (const u of users) stream.subscribeUser(u.user);
  stream.start();

  await sleep(MINUTES * 60_000);
  stream.stop();
  status = { ...status, state: 'done', endedAt: new Date().toISOString() };
  const result = { ...summary(), samplesDetail: samples.map((s) => ({ ...s, user: `${s.user.slice(0, 6)}…${s.user.slice(-4)}` })) };
  console.log(JSON.stringify(summary()));
  try {
    mkdirSync(new URL('../../../evidence/', import.meta.url), { recursive: true });
    writeFileSync(new URL(`../../../evidence/parity-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url), JSON.stringify(result, null, 1));
  } catch {
    /* read-only filesystem on the host: the summary is in the log */
  }
  // Keep serving the summary for a while so it can be fetched, then exit.
  setTimeout(() => process.exit(0), Number(process.env.PARITY_LINGER_MS ?? 5_000));
}

main().catch((e) => {
  status = { state: 'error', error: String(e) };
  console.error(e);
});
