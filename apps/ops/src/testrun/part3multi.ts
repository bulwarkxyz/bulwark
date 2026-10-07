/**
 * Test run: several positions in one cross pool (testnet, mock USDC only). A TEST CONFIGURATION, not a user setting:
 * margin is set so the guard's backstops rest about 3% below the price, to prove live that
 *   1. a pool with two positions (BTC and ETH, testnet's main dex) gets a backstop on each, priced as if both fall
 *      together (pricing "together"), at the level the planner computes;
 *   2. after a deposit into that pool, each is re-priced once, to the planner's new level;
 *   3. nothing more happens on a flat market.
 * A GOLD position in the xyz pool, at the same line, gives a single-position backstop to compare with and a
 * position for the app's TP/SL checks. Positions are left open; close them with `testrun part4 --no-switch`.
 * The account's raw states are recorded at each step for a deterministic CI test of the worker.
 *
 *   pnpm --filter @bulwarkxyz/ops testrun part3multi [--dry-run] [--owner-approved "note"]
 */
import { writeFileSync } from 'node:fs';
import { ceilSize, planBackstops, roundPrice, toWire, type Policy } from '@bulwarkxyz/guard-core';
import { USDC_TOKEN, orderAction, orderWire, sendAssetAction, updateLeverageAction, usdClassTransferAction, userSetAbstractionAction, type Hex } from '@bulwarkxyz/hyperliquid';
import { RUN_DIR, RunLog, WALLET, approveTestnetStepsInAdvance, checkDestination, confirm, loadWallet } from './guard.js';
import { CHAIN, SIGNATURE_CHAIN_ID, Session, auditSince } from './session.js';

export const MULTI_CONFIG = { main: [{ coin: 'BTC', usd: 15 }, { coin: 'ETH', usd: 15 }], xyz: [{ coin: 'xyz:GOLD', usd: 25 }], leverage: 5, line: 15, backstopFallPct: 3, depositMovesBackstopPct: 1 };
const NOT_MONEY = 'Testnet only, mock USDC, no real money. Does not count toward the 13 USDC limit.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type GuardOrder = { oid: number; coin: string; triggerPx: number; size: number; pricing: string | null; line: number | null };

export async function part3multi(opts: { dryRun: boolean; ownerApproved?: string }): Promise<void> {
  const log = new RunLog('part3-multi');
  if (opts.ownerApproved) approveTestnetStepsInAdvance(opts.ownerApproved, log);
  const s = new Session(log, opts.dryRun ? null : loadWallet());
  const f = MULTI_CONFIG.backstopFallPct / 100;
  const L = MULTI_CONFIG.line;
  const results: Record<string, unknown> = {};
  const recorded: Array<{ label: string; at: number; state: unknown }> = [];
  const record = async (label: string) => {
    const [main, xyz, spot, mids, xyzCtx] = await Promise.all([s.info.clearinghouseState(WALLET, ''), s.info.clearinghouseState(WALLET, 'xyz'), s.info.spotClearinghouseState(WALLET), s.info.request({ type: 'allMids' }), s.info.metaAndAssetCtxs('xyz')]);
    recorded.push({ label, at: Date.now(), state: { abstraction: await s.info.userAbstraction(WALLET), dexStates: { '': main, xyz }, spot, mids, xyzCtx } });
  };
  console.log(`\nTest wallet ${WALLET} on testnet. TEST CONFIGURATION (not a user setting): ${JSON.stringify(MULTI_CONFIG)}`);
  if (opts.dryRun) {
    console.log(`Plan: standard mode; BTC and ETH about $15 each in the main pool, GOLD about $25 in the xyz pool, ${MULTI_CONFIG.leverage}x cross; margin in each pool set so one line (${L}x) puts its backstops about ${MULTI_CONFIG.backstopFallPct}% below the price; check them against the planner; a small deposit into the main pool; check one re-price each. ${NOT_MONEY}`);
    return;
  }
  await s.signIn();
  const startSeq = Math.max(0, ...(await auditSince(s, 0)).map((e) => e.seq));
  const guardOrders = async () => {
    const b = (await s.api<GuardOrder[]>('/v1/guard-orders')).body;
    return Array.isArray(b) ? b : [];
  };

  // 0. standard mode (unified backs every position with the whole balance: no backstop could rest).
  if ((await s.info.userAbstraction(WALLET)) === 'unifiedAccount') {
    if (!(await confirm({ what: 'Switch the test account back to standard mode (each venue has its own balance).', amount: 'None.', limit: NOT_MONEY }))) return;
    const r = await s.userSigned('switch to standard', userSetAbstractionAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, user: WALLET, abstraction: 'disabled', nonce: Date.now() }));
    await sleep(2000);
    const now = await s.info.userAbstraction(WALLET);
    console.log(`  Mode: ${r.ok ? now : `refused: ${r.error}`}`);
    if (now === 'unifiedAccount') throw new Error(`could not switch to standard (${r.error ?? now})`);
    await sleep(35_000); // the guard re-reads the account mode every 30 s
  }

  // 0b. the line alone, signed before anything opens, so the previous version's canary cannot act during setup.
  const version = ((await s.api<{ policy: { version: number } | null }>('/v1/me')).body.policy?.version ?? 0) + 1;
  const policy: Policy = { version, account: WALLET.toLowerCase() as Hex, rules: [{ id: 'backstop-line', when: { kind: 'buffer', below: L }, then: [{ kind: 'alert' }], repeat: { mode: 'everyCrossing' } }], execution: { maxSlippagePct: 1 } };
  if (!(await confirm({ what: `Sign rules v${version} (test configuration, not a user setting): one alert line at ${L}x and nothing else, replacing the canary rules.`, amount: 'None.', limit: NOT_MONEY }))) return;
  await s.signPolicy(policy);
  await sleep(3000);

  // 1. working margin in each pool, moved to yourself (spot → main perps → xyz).
  checkDestination('self', WALLET);
  const fund = async (pool: '' | 'xyz', want: number) => {
    const st = (await s.info.clearinghouseState(WALLET, pool)) as { marginSummary: { accountValue: string } };
    const have = Number(st.marginSummary.accountValue);
    const add = Math.round((want - have) * 100) / 100;
    if (add <= 0.5) return;
    if (pool === '') {
      await s.userSigned('fund main pool', usdClassTransferAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, amount: String(add), toPerp: true, nonce: Date.now() }));
    } else {
      await s.userSigned('fund main pool for xyz', usdClassTransferAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, amount: String(add), toPerp: true, nonce: Date.now() }));
      await sleep(1500);
      await s.userSigned('fund xyz pool', sendAssetAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, destination: WALLET, sourceDex: '', destinationDex: 'xyz', token: USDC_TOKEN.testnet, amount: String(add), nonce: Date.now() }));
    }
    await sleep(1500);
  };
  if (!(await confirm({ what: 'Move about $20 of mock USDC into each of the main and xyz pools (to yourself) to open the positions.', amount: 'About 40 mock USDC.', limit: NOT_MONEY }))) return;
  await fund('xyz', 20);
  await fund('', 20);

  // 2. open the positions.
  let st = await s.risk();
  const [meta, ctxs] = await s.info.metaAndAssetCtxs('');
  const oracleOf = async (coin: string) => {
    if (!coin.startsWith('xyz:')) return Number((ctxs[(meta as { universe: Array<{ name: string }> }).universe.findIndex((u) => u.name === coin)] as { oraclePx: string }).oraclePx);
    const [xm, xc] = await s.info.metaAndAssetCtxs('xyz');
    return Number((xc[(xm as { universe: Array<{ name: string }> }).universe.findIndex((u) => u.name === coin)] as { oraclePx: string }).oraclePx);
  };
  const opened: Record<string, unknown> = {};
  for (const leg of [...MULTI_CONFIG.main, ...MULTI_CONFIG.xyz]) {
    const a = st.assets.get(leg.coin)!;
    const have = st.snapshot.positions.find((p) => p.coin === leg.coin);
    if (have && Math.abs(have.size) * have.markAtSnapshot >= leg.usd * 0.6) {
      console.log(`  ${leg.coin}: already open (${have.size}); not buying again.`);
      continue;
    }
    const b = await s.book(leg.coin);
    if (!b.ask) throw new Error(`${leg.coin}: no asks on testnet now`);
    const size = ceilSize(leg.usd / b.ask, a.szDecimals);
    const px = roundPrice(Math.min(b.ask * 1.01, (await oracleOf(leg.coin)) * 1.04), a.szDecimals, 'up');
    if (!(await confirm({ what: `${MULTI_CONFIG.leverage}x cross, buy ${size} ${leg.coin} (limit ${px}), immediate-or-cancel.`, amount: `About $${(size * b.ask).toFixed(2)} of mock notional.`, limit: NOT_MONEY }))) return;
    await s.withTradingKey(`leverage ${leg.coin}`, updateLeverageAction(a.assetId, true, MULTI_CONFIG.leverage));
    const r = await s.withTradingKey(`open ${leg.coin}`, orderAction([orderWire({ asset: a.assetId, isBuy: true, limitPx: toWire(px), size: toWire(size), reduceOnly: false, orderType: { limit: { tif: 'Ioc' } } })]));
    opened[leg.coin] = r.statuses;
    console.log(`  ${leg.coin}: ${JSON.stringify(r.statuses)}`);
  }
  results.opened = opened;
  await sleep(2000);

  // 3. one line for both pools; each pool's margin set so its backstops rest about 3% below the price.
  //    For a pool falling together by f: equity E - N f, maintenance MM (1 - f); the buffer reaches L when
  //    E = f N + L MM (1 - f).
  st = await s.risk();
  const target: Record<string, { equity: number; notional: number; maintenance: number; want: number }> = {};
  for (const pool of st.risk.pools) {
    const notional = pool.positions.reduce((n, r) => n + r.notional, 0);
    target[pool.pool.id] = { equity: pool.equity, notional, maintenance: pool.maintenance, want: Math.round((f * notional + L * pool.maintenance * (1 - f)) * 100) / 100 };
  }
  results.poolTargets = target;
  const move = async (id: string, dex: '' | 'xyz') => {
    const t = target[id];
    if (!t) return;
    // Live, not the snapshot: moving the xyz pool's excess passes through the main pool (6 Oct: it landed there).
    const live = Number(((await s.info.clearinghouseState(WALLET, dex)) as { marginSummary: { accountValue: string } }).marginSummary.accountValue);
    const out = Math.round((live - t.want) * 100) / 100;
    if (Math.abs(out) < 0.05) return;
    if (dex === '') await s.userSigned(`main pool margin to ${t.want}`, usdClassTransferAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, amount: String(Math.abs(out)), toPerp: out < 0, nonce: Date.now() }));
    else await s.userSigned(`xyz pool margin to ${t.want}`, sendAssetAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, destination: WALLET, sourceDex: out > 0 ? 'xyz' : '', destinationDex: out > 0 ? '' : 'xyz', token: USDC_TOKEN.testnet, amount: String(Math.abs(out)), nonce: Date.now() }));
    await sleep(1500);
    const after = Number(((await s.info.clearinghouseState(WALLET, dex)) as { marginSummary: { accountValue: string } }).marginSummary.accountValue);
    console.log(`  ${id || 'main'} margin: ${live.toFixed(2)} → ${after.toFixed(2)} (target ${t.want})`);
    await sleep(1500);
  };
  if (!(await confirm({ what: `Set each pool's margin so a ${L}x line puts its backstops about ${MULTI_CONFIG.backstopFallPct}% below the price: ${Object.entries(target).map(([k, v]) => `${k} ${v.equity.toFixed(2)} → ${v.want}`).join(', ')} (moves to and from your own balances).`, amount: 'Mock USDC only.', limit: NOT_MONEY }))) return;
  await move('dex:xyz', 'xyz');
  await move('dex:', '');
  await sleep(2000);
  await record('margins set');

  // 4. wait until the guard's backstops sit where the planner puts them (it re-plans as the margins move).
  const coins = [...MULTI_CONFIG.main, ...MULTI_CONFIG.xyz].map((l) => l.coin);
  const near = (a: number, b: number) => Math.abs(a - b) / b < 0.005;
  let go: GuardOrder[] = [];
  for (const end = Date.now() + 180_000; Date.now() < end; await sleep(5000)) {
    st = await s.risk();
    const want = planBackstops(policy, st.snapshot, undefined, [], 'together').place;
    go = (await guardOrders()).filter((o) => o.line === L);
    if (coins.every((c) => go.some((o) => o.coin === c && want.some((w) => w.coin === c && near(o.triggerPx, w.triggerPx))))) break;
  }
  const policySeq = Math.max(...(await auditSince(s, startSeq)).map((e) => e.seq), startSeq);
  const compare = (live: GuardOrder[], planned: Array<{ coin: string; triggerPx: number }>) => planned.map((p) => {
    const o = live.find((x) => x.coin === p.coin);
    return { coin: p.coin, planned: p.triggerPx, live: o?.triggerPx ?? null, oid: o?.oid ?? null, pricing: o?.pricing ?? null, matches: Boolean(o && near(o.triggerPx, p.triggerPx)) };
  });
  st = await s.risk();
  const planned = planBackstops(policy, st.snapshot, undefined, [], 'together').place.map((p) => ({ coin: p.coin, triggerPx: p.triggerPx, size: p.size, reason: p.reason }));
  const rows = [...(await s.openOrders('')), ...(await s.openOrders('xyz'))];
  results.backstops = { version, line: L, compare: compare(go, planned), onExchange: go.map((o) => rows.find((r) => r.oid === o.oid) ?? null), plannerReasons: planned.map((p) => [p.coin, p.reason]) };
  console.log(`  Backstops: ${JSON.stringify((results.backstops as { compare: unknown }).compare)}`);

  // 5. deposit into the main pool: both BTC and ETH re-price, once each.
  const mainT = target['dex:']!;
  const slack = mainT.notional - L * mainT.maintenance;
  const deposit = Math.min(1, Math.max(0.05, Math.ceil((MULTI_CONFIG.depositMovesBackstopPct / 100) * slack * 100) / 100));
  const before = await guardOrders();
  const depositSeq = Math.max(...(await auditSince(s, policySeq)).map((e) => e.seq), policySeq);
  if (await confirm({ what: `Deposit ${deposit} mock USDC from spot into the main pool, to yourself. BTC's and ETH's backstops re-price, once each; GOLD's stays.`, amount: `${deposit} mock USDC.`, limit: NOT_MONEY })) {
    const r = await s.userSigned('deposit into the main pool', usdClassTransferAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, amount: String(deposit), toPerp: true, nonce: Date.now() }));
    const depositAt = Date.now();
    for (const end = Date.now() + 150_000; Date.now() < end; await sleep(5000)) {
      const now = await guardOrders();
      if (MULTI_CONFIG.main.every((l) => now.find((o) => o.coin === l.coin)?.oid !== before.find((o) => o.coin === l.coin)?.oid)) break;
    }
    await record('after deposit');
    await sleep(75_000); // a second re-price on a flat market would show here
    st = await s.risk();
    const after = await guardOrders();
    const plannedAfter = planBackstops(policy, st.snapshot, undefined, [], 'together').place.map((p) => ({ coin: p.coin, triggerPx: p.triggerPx, size: p.size, reason: p.reason }));
    const entries = (await auditSince(s, depositSeq)).filter((e) => e.kind === 'backstop' || /^Cancel/.test(e.what));
    const placedPerCoin = Object.fromEntries(coins.map((c) => [c, entries.filter((e) => e.kind === 'backstop' && e.what.includes(` ${c} `)).length]));
    results.deposit = { amount: deposit, ok: r.ok, at: new Date(depositAt).toISOString(), slack, before, after, compare: compare(after, plannedAfter), placedPerCoin, repricedOnceEach: MULTI_CONFIG.main.every((l) => placedPerCoin[l.coin] === 1) && placedPerCoin['xyz:GOLD'] === 0, audit: entries.map((e) => ({ seq: e.seq, at: new Date(e.at).toISOString(), kind: e.kind, what: e.what })) };
    console.log(`  After the deposit: ${JSON.stringify({ compare: (results.deposit as { compare: unknown }).compare, placedPerCoin })}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const evidence = { wallet: WALLET, network: 'testnet', testConfiguration: MULTI_CONFIG, note: 'A test configuration chosen so backstops rest near the price on small test positions. Not a recommended user setting. Mock USDC only.', results, audit: await auditSince(s, startSeq), recorded };
  const file = new URL(`evidence-multi-${stamp}.json`, RUN_DIR);
  writeFileSync(file, JSON.stringify(evidence, null, 1));
  log.write('evidence saved', { file: file.pathname });
  console.log(`\nEvidence: ${file.pathname}\nPositions are left open for the app's TP/SL checks; close them with: testrun part4 --no-switch`);
}
