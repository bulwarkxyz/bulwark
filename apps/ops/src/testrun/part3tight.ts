/**
 * Test run, part 3 in a TEST CONFIGURATION (testnet, mock USDC only). Not a recommended user setting: it is
 * chosen to force the guard's backstop to rest close to the price on a small test position, so the run can prove
 * (with audit and exchange evidence) that:
 *   1. the backstop is placed as a real resting order;
 *   2. the user's own signed stop-loss (a trigger order on GOLD) is accepted;
 *   3. after a margin deposit, the backstop is re-priced once, to the level the guard's planner computes;
 *   4. on a flat market, with the per-market price stream running, a "once per fall" stage acts once.
 *
 * Test configuration vs the original plan:
 *   pool margin about $8 (original: $40), position about $25 of GOLD (same), canary trim 50% at a line just above
 *   the buffer (same), top-up $2 (same, standard mode only), alert line set so the backstop rests 3% below the price
 *   (original: 2.0×, unreachable at a 175× buffer), deposit $0.10 (original: $5, which would push the backstop
 *   outside Hyperliquid's oracle band; here the deposit is computed to move the backstop 1 point, about $0.15, well past
 *   the guard's 0.5% re-price threshold), user stop-loss on GOLD (original: on XYZ100, which testnet refuses). After the
 *   canary, GOLD is bought back to about $25 and the rules become the backstop line alone, so the canary cannot act again.
 *
 *   pnpm --filter @bulwarkxyz/ops testrun part3tight [--dry-run] [--owner-approved "note"]
 */
import { writeFileSync } from 'node:fs';
import { ceilSize, planBackstops, roundPrice, toWire, type Policy } from '@bulwarkxyz/guard-core';
import { USDC_TOKEN, orderAction, orderWire, sendAssetAction, updateLeverageAction, type Hex } from '@bulwarkxyz/hyperliquid';
import { RUN_DIR, RunLog, WALLET, approveTestnetStepsInAdvance, checkDestination, confirm, loadWallet } from './guard.js';
import { CHAIN, SIGNATURE_CHAIN_ID, Session, auditSince } from './session.js';

const COIN = 'xyz:GOLD';
export const TEST_CONFIG = { poolMarginUsdc: 8, positionUsd: 25, leverage: 5, canaryFraction: 0.5, topUpUsdc: 2, backstopFallPct: 3, depositMovesBackstopPct: 1, stopLossBelowMarkPct: 4 };
export const ORIGINAL_PLAN = { poolMarginUsdc: 40, positionUsd: '25 GOLD + 12 XYZ100', topUpUsdc: 2, alertLine: '2.0×', depositUsdc: 5, stopLoss: 'XYZ100, 6% below the mark' };
const NOT_MONEY = 'Testnet only, mock USDC, no real money. Does not count toward the 13 USDC limit.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EXPLORER = `https://app.hyperliquid-testnet.xyz/explorer/address/${WALLET}`;

type Audit = Awaited<ReturnType<typeof auditSince>>;

export async function part3tight(opts: { dryRun: boolean; ownerApproved?: string }): Promise<void> {
  const log = new RunLog('part3-test-config');
  if (opts.ownerApproved) approveTestnetStepsInAdvance(opts.ownerApproved, log);
  const s = new Session(log, opts.dryRun ? null : loadWallet());
  const evidence: Record<string, unknown> = { wallet: WALLET, network: 'testnet', explorer: EXPLORER, testConfiguration: TEST_CONFIG, originalPlan: ORIGINAL_PLAN, note: 'A test configuration chosen to force the backstop to rest near the price on a small test position. Not a recommended user setting.', results: {} };
  const results = evidence.results as Record<string, unknown>;
  let st = await s.risk();
  const unified = st.abstraction === 'unifiedAccount';
  const asset = st.assets.get(COIN)!;
  const oracle = async () => {
    const [meta, ctxs] = await s.info.metaAndAssetCtxs('xyz');
    const i = (meta as { universe: Array<{ name: string }> }).universe.findIndex((u) => u.name === COIN);
    return Number((ctxs[i] as { oraclePx: string }).oraclePx);
  };
  const pool = () => st.risk.pools.find((p) => p.positions.some((r) => r.position.coin === COIN)) ?? null;
  const held = () => st.snapshot.positions.find((p) => p.coin === COIN && p.size !== 0) ?? null;
  console.log(`\nTest wallet ${WALLET} on testnet, ${unified ? 'unified' : 'standard'} mode. TEST CONFIGURATION (not a user setting): ${JSON.stringify(TEST_CONFIG)}`);
  if (opts.dryRun) {
    console.log(`Plan: ${unified ? '' : `set the xyz pool's margin to about $${TEST_CONFIG.poolMarginUsdc}; `}bring GOLD to about $${TEST_CONFIG.positionUsd}; your stop-loss on GOLD ${TEST_CONFIG.stopLossBelowMarkPct}% below the mark; canary rules (trim${unified ? '' : ', top-up'}); then an alert line that puts the backstop ${TEST_CONFIG.backstopFallPct}% below the price; then a margin deposit (about $0.15, computed) and the re-price. ${NOT_MONEY}`);
    return;
  }
  await s.signIn();
  const allAudit = async () => auditSince(s, 0);
  const startSeq = Math.max(0, ...(await allAudit()).map((e) => e.seq));
  const me = async () => (await s.api<{ policy: { version: number } | null }>('/v1/me')).body;
  const guardOrders = async () => {
    const b = (await s.api<Array<{ oid: number; coin: string; triggerPx: number; size: number; pricing: string | null; line: number | null }>>('/v1/guard-orders')).body;
    return Array.isArray(b) ? b : [];
  };

  // 1. pool margin to about $8 (standard mode: the xyz dex has its own balance), testnet mock USDC, to yourself.
  if (!unified) {
    const xs = (await s.info.clearinghouseState(WALLET, 'xyz')) as { marginSummary: { accountValue: string } };
    const e0 = Number(xs.marginSummary.accountValue);
    const delta = Math.round((e0 - TEST_CONFIG.poolMarginUsdc) * 100) / 100;
    if (Math.abs(delta) >= 0.5) {
      checkDestination('self', WALLET);
      const out = delta > 0;
      if (!(await confirm({ what: `Set the xyz pool's margin to about $${TEST_CONFIG.poolMarginUsdc}: move ${Math.abs(delta)} mock USDC ${out ? 'from the xyz pool to your main balance' : 'into the xyz pool'}, to yourself.`, amount: `${Math.abs(delta)} mock USDC.`, limit: NOT_MONEY }))) return;
      const r = await s.userSigned('test config: pool margin', sendAssetAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, destination: WALLET, sourceDex: out ? 'xyz' : '', destinationDex: out ? '' : 'xyz', token: USDC_TOKEN.testnet, amount: String(Math.abs(delta)), nonce: Date.now() }));
      results.poolMargin = { before: e0, moved: delta, ok: r.ok, error: r.error ?? null };
      console.log(`  Pool margin: ${r.ok ? `moved ${delta}` : `refused: ${r.error}`}`);
    }
  }

  // 2. GOLD position to about $25.
  const open = async (label: string) => {
    st = await s.risk();
    const p = held();
    const book = await s.book(COIN);
    const have = p ? Math.abs(p.size) * p.markAtSnapshot : 0;
    const need = TEST_CONFIG.positionUsd - have;
    if (need < 10 || !book.ask) return null;
    const size = ceilSize(need / book.ask, asset.szDecimals);
    const px = roundPrice(Math.min(book.ask * 1.01, (await oracle()) * 1.04), asset.szDecimals, 'up');
    if (!(await confirm({ what: `${label}: ${TEST_CONFIG.leverage}x cross, buy ${size} GOLD (limit ${px}, inside the oracle band), immediate-or-cancel.`, amount: `About $${(size * book.ask).toFixed(2)} of mock notional.`, limit: NOT_MONEY }))) return null;
    await s.withTradingKey('leverage GOLD', updateLeverageAction(asset.assetId, !asset.onlyIsolated, TEST_CONFIG.leverage));
    const r = await s.withTradingKey(label, orderAction([orderWire({ asset: asset.assetId, isBuy: true, limitPx: toWire(px), size: toWire(size), reduceOnly: false, orderType: { limit: { tif: 'Ioc' } } })]));
    console.log(`  ${label}: ${JSON.stringify(r.statuses)}`);
    return r.statuses;
  };
  results.openPosition = await open('open GOLD to about $25');

  // 3. your own stop-loss on GOLD: a real signed trigger order.
  st = await s.risk();
  let p = held();
  if (p) {
    const trig = roundPrice(p.markAtSnapshot * (1 - TEST_CONFIG.stopLossBelowMarkPct / 100), asset.szDecimals, 'down');
    const lim = roundPrice(Math.max(trig * 0.99, (await oracle()) * 0.94), asset.szDecimals, 'up');
    const size = Math.abs(p.size);
    if (await confirm({ what: `Your own stop-loss on GOLD: reduce-only stop-market sell of ${size} if the mark falls to ${trig} (limit ${lim}).`, amount: `${size} GOLD, closes the position only.`, limit: NOT_MONEY })) {
      const r = await s.withTradingKey('user stop-loss (GOLD)', orderAction([orderWire({ asset: asset.assetId, isBuy: false, limitPx: toWire(lim), size: toWire(size), reduceOnly: true, orderType: { trigger: { isMarket: true, triggerPx: toWire(trig), tpsl: 'sl' } } })]));
      await sleep(1500);
      const rows = await s.openOrders('xyz');
      const row = rows.find((o) => o.isTrigger && Math.abs(Number(o.triggerPx) - trig) / trig < 1e-6) ?? null;
      results.userStopLoss = { response: r.statuses, ok: r.ok, error: r.error ?? null, frontendOpenOrdersRow: row, accepted: Boolean(r.ok && row) };
      console.log(`  Stop-loss: ${JSON.stringify(r.statuses)}; in open orders: ${row ? `#${row.oid} ${row.orderType} trigger ${row.triggerPx}` : 'not found'}`);
    }
  }

  // 4. canary rules: the trim (and top-up) act at once; count them on a flat market.
  st = await s.risk();
  const pl = pool();
  if (!pl) throw new Error('No GOLD position in the xyz pool; see the run log.');
  const lineA = Math.ceil(pl.buffer * 1.15 * 100) / 100;
  const canary = { id: 'canary-trim', when: { kind: 'buffer' as const, below: lineA }, then: [{ kind: 'reduce' as const, target: { kind: 'first_position' as const }, fraction: TEST_CONFIG.canaryFraction }], repeat: { mode: 'oncePerBreach' as const } };
  const topUp = unified ? [] : [{ id: 'top-up', when: { kind: 'buffer' as const, below: lineA }, then: [{ kind: 'topUp' as const, maxUsdc: TEST_CONFIG.topUpUsdc }], repeat: { mode: 'oncePerBreach' as const } }];
  const alert = (below: number) => ({ id: 'backstop-line', when: { kind: 'buffer' as const, below }, then: [{ kind: 'alert' as const }], repeat: { mode: 'everyCrossing' as const } });
  const base = (version: number, alertLine: number): Policy => ({ version, account: WALLET.toLowerCase() as Hex, rules: [canary, ...topUp, alert(alertLine)], execution: { maxSlippagePct: 1 } });
  // Phase B: the backstop line alone, so the canary (whose line the bought-back position sits near) cannot act again.
  const lineOnly = (version: number, alertLine: number): Policy => ({ version, account: WALLET.toLowerCase() as Hex, rules: [alert(alertLine)], execution: { maxSlippagePct: 1 } });
  let version = ((await me()).policy?.version ?? 0) + 1;
  if (!(await confirm({ what: `Sign rules v${version} (test configuration): the pool's buffer is ${pl.buffer.toFixed(2)}x, so a canary line at ${lineA}x is crossed and the guard trims GOLD by 50% at once${unified ? '' : ` and tops up $${TEST_CONFIG.topUpUsdc}`}. Alert at 2.0x for now.`, amount: 'A 50% trim of a small mock position.', limit: NOT_MONEY }))) return;
  await s.signPolicy(base(version, 2));
  // Counted from the start of the run: moving margin out can cross an earlier version's canary line first (6 Oct:
  // v2's canary trimmed 2 s after the move, and v3's same stage then stayed latched for that fall, as designed).
  const canarySeq = startSeq;
  const watch = async (label: string, ms: number, until?: (a: Audit) => boolean) => {
    const end = Date.now() + ms;
    let a: Audit = [];
    while (Date.now() < end) {
      a = await auditSince(s, startSeq);
      if (until?.(a)) break;
      await sleep(5000);
    }
    for (const e of a) log.write(`guard: ${label}`, { seq: e.seq, kind: e.kind, what: e.what, proof: e.proof ?? null });
    return a;
  };
  const trims = (a: Audit) => a.filter((e) => e.seq > canarySeq && e.kind === 'guard_action' && (e.proof as { ruleId?: string } | undefined)?.ruleId === 'canary-trim' && /^order/.test(e.what));
  await watch('canary', 120_000, (a) => trims(a).length > 0);
  console.log('  Canary acted; watching 2 more minutes for any second action on the flat market…');
  await sleep(120_000);
  const afterCanary = await auditSince(s, canarySeq);
  results.onceOnFlatMarket = { trims: trims(afterCanary).map((e) => ({ seq: e.seq, at: new Date(e.at).toISOString(), what: e.what })), exactlyOne: trims(afterCanary).length === 1 };
  console.log(`  Trims since the canary rules: ${trims(afterCanary).length} (expected 1)`);

  // 5. buy GOLD back to about $25, then the backstop line: set so the backstop rests 3% below the price.
  results.reopenAfterCanary = await open('buy GOLD back to about $25 after the canary');
  await sleep(2000);
  st = await s.risk();
  const pb = pool();
  const placeBackstop = async (): Promise<Record<string, unknown> | null> => {
    st = await s.risk();
    const q = pool();
    if (!q) return null;
    const notional = q.positions.reduce((n, r) => n + r.notional, 0);
    // With equity above notional (unified mode on this wallet: ~$990 against ~$25) a fall lowers maintenance faster
    // than equity, so the buffer rises as the price falls: no line has a backstop below the price.
    if (q.equity >= notional) return { unreachable: true, equity: q.equity, notional, buffer: q.buffer, note: 'Equity is above notional, so the buffer rises as the price falls; no backstop below the price exists for any line.' };
    const f = TEST_CONFIG.backstopFallPct / 100;
    const line = Math.round(((q.equity - f * notional) / (q.maintenance * (1 - f))) * 100) / 100;
    version = ((await me()).policy?.version ?? 0) + 1;
    const policy = lineOnly(version, line);
    const expected = planBackstops(policy, st.snapshot, undefined, [], 'together').place.find((x) => x.coin === COIN) ?? null;
    if (!(await confirm({ what: `Sign rules v${version} (test configuration, not a user setting): alert line ${line}x, ${((line / q.buffer) * 100).toFixed(1)}% of the live ${q.buffer.toFixed(2)}x buffer, so the guard's backstop rests ${TEST_CONFIG.backstopFallPct}% below the price (planner: trigger ${expected?.triggerPx ?? 'none'}).`, amount: 'None. The backstop is a reduce-only stop on your mock position.', limit: NOT_MONEY }))) return null;
    await s.signPolicy(policy);
    const end = Date.now() + 150_000;
    let go: Awaited<ReturnType<typeof guardOrders>> = [];
    while (Date.now() < end) {
      // The guard's order for this line (an earlier version's backstop may still be resting for a few seconds).
      go = (await guardOrders()).filter((o) => o.coin === COIN && o.line === line);
      if (go.length) break;
      await sleep(5000);
    }
    const rows = await s.openOrders('xyz');
    const onExchange = go.map((o) => rows.find((r) => r.oid === o.oid) ?? null);
    return { version, line, maintenance: q.maintenance, lineAsShareOfBuffer: line / q.buffer, buffer: q.buffer, equity: q.equity, notional, expectedTriggerPx: expected?.triggerPx ?? null, guardOrders: go, onExchange, restingOnExchange: onExchange.some((r) => r?.isTrigger && r.reduceOnly) };
  };
  let bs = pb ? await placeBackstop() : null;
  // If the tight backstop fires on normal movement, that is its own result: record it, re-establish, continue.
  st = await s.risk();
  if (bs && !held()) {
    results.backstopFired = { note: 'The test backstop fired on normal movement (a legitimate trigger, not a failed step).', audit: (await auditSince(s, canarySeq)).filter((e) => /backstop|fill|trigger/i.test(`${e.kind} ${e.what}`)) };
    console.log('  The backstop fired on normal movement: recorded. Re-establishing the position…');
    await open('re-open GOLD after the backstop fired');
    bs = await placeBackstop();
  }
  results.backstopPlaced = bs;
  console.log(`  Backstop: ${bs?.restingOnExchange ? `resting, oid ${(bs.guardOrders as Array<{ oid: number }>)[0]?.oid}, trigger ${(bs.guardOrders as Array<{ triggerPx: number }>)[0]?.triggerPx} (planner ${bs.expectedTriggerPx})` : 'NOT placed'}`);

  // 6. the deposit and the re-price.
  if (bs?.restingOnExchange) {
    const before = (await guardOrders()).filter((o) => o.coin === COIN);
    const depositSeq = Math.max(...(await allAudit()).map((e) => e.seq));
    // The backstop's fall is (E - L*MM) / (N - L*MM): a deposit dE moves it by dE / (N - L*MM). Sized to move it
    // TEST_CONFIG.depositMovesBackstopPct points, far past the guard's 0.5% re-price threshold, still inside the band.
    const slack = (bs.notional as number) - (bs.line as number) * (bs.maintenance as number);
    const deposit = Math.min(1, Math.max(0.05, Math.ceil((TEST_CONFIG.depositMovesBackstopPct / 100) * slack * 100) / 100));
    results.depositSizing = { slack, deposit, movesBackstopPctPoints: (deposit / slack) * 100 };
    if (await confirm({ what: `Deposit ${deposit} mock USDC into the xyz pool${unified ? ' (unified: from spot)' : ''}, to yourself. The margin changes, so the guard re-prices its backstop, once.`, amount: `${deposit} mock USDC.`, limit: NOT_MONEY })) {
      const r = await s.userSigned('deposit for re-pricing', sendAssetAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, destination: WALLET, sourceDex: unified ? 'spot' : '', destinationDex: 'xyz', token: USDC_TOKEN.testnet, amount: String(deposit), nonce: Date.now() }));
      console.log(`  Deposit: ${r.ok ? 'done' : r.error}`);
      const end = Date.now() + 150_000;
      let after = before;
      while (Date.now() < end) {
        after = (await guardOrders()).filter((o) => o.coin === COIN);
        if (after.length && after[0]!.oid !== before[0]?.oid) break;
        await sleep(5000);
      }
      await sleep(70_000); // one more backstop cycle: a second re-price would show here
      st = await s.risk();
      const live = (await guardOrders()).filter((o) => o.coin === COIN);
      const expected = planBackstops(lineOnly(version, bs.line as number), st.snapshot, undefined, [], 'together').place.find((x) => x.coin === COIN) ?? null;
      const entries = (await auditSince(s, depositSeq)).filter((e) => e.kind === 'backstop' || /^Cancel/.test(e.what));
      const placed = entries.filter((e) => e.kind === 'backstop');
      const rows = await s.openOrders('xyz');
      results.repriced = {
        deposit: { ok: r.ok, error: r.error ?? null },
        before,
        after: live,
        onExchange: live.map((o) => rows.find((x) => x.oid === o.oid) ?? null),
        expectedTriggerPx: expected?.triggerPx ?? null,
        matchesPlanner: Boolean(expected && live[0] && Math.abs(live[0].triggerPx - expected.triggerPx) / expected.triggerPx < 0.002),
        auditEntries: entries.map((e) => ({ seq: e.seq, kind: e.kind, what: e.what })),
        placedCount: placed.length,
        repricedOnce: placed.length === 1 && Boolean(live[0]) && live[0]!.oid !== before[0]?.oid,
      };
      console.log(`  Re-price: ${JSON.stringify({ before: before.map((o) => [o.oid, o.triggerPx]), after: live.map((o) => [o.oid, o.triggerPx]), expected: expected?.triggerPx, placed: placed.length })}`);
    }
  }

  results.multiPositionRepricing = 'NOT proven live: only GOLD can be held in a shared cross pool on testnet (XYZ100 refused by the oracle band; other curated markets isolated-only, delisted or one-sided). Together-pricing stays testnet-only.';
  evidence.audit = await auditSince(s, startSeq);
  const file = new URL(`evidence-test-config-${unified ? 'unified' : 'standard'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, RUN_DIR);
  writeFileSync(file, JSON.stringify(evidence, null, 1));
  log.write('evidence saved', { file: file.pathname });
  console.log(`\nEvidence: ${file.pathname}\n${JSON.stringify(results, (k, v) => (k === 'audit' || k === 'auditEntries' ? undefined : v), 1).slice(0, 2500)}`);
}
