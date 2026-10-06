/**
 * Test run, part 3 (testnet, no real money), in the account's current mode (standard first, unified on the
 * repeat): open two long positions in the xyz pool (GOLD and XYZ100), place your own stop-loss, sign rules that make the guard act at
 * once (the canary trim, and the top-up in standard mode), let it place its backstops priced as if both
 * positions fall together, then move margin so it re-prices them. Every guard entry is saved as the audit log.
 *
 *   pnpm --filter @bulwarkxyz/ops testrun part3 [--dry-run]
 */
import { writeFileSync } from 'node:fs';
import { ceilSize, roundPrice, toWire, type Policy } from '@bulwarkxyz/guard-core';
import { USDC_TOKEN, orderAction, orderWire, sendAssetAction, updateLeverageAction } from '@bulwarkxyz/hyperliquid';
import { RUN_DIR, RunLog, WALLET, checkDestination, approveTestnetStepsInAdvance, confirm, loadWallet } from './guard.js';
import { CHAIN, SIGNATURE_CHAIN_ID, Session, auditSince } from './session.js';

const NOT_MONEY = 'Testnet only, mock USDC, no real money. Does not count toward the 13 USDC limit.';
const LONG = { coin: 'xyz:GOLD', usd: 25 };
/** The second position. Testnet's NVDA book often has no asks (a short could not be closed), so: an XYZ100 long. */
const SECOND = { coin: 'xyz:XYZ100', usd: 12 };
const LEVERAGE = 5;
/** How far from the book an order may fill: the spread plus 1%, at most 10% (mock money; thin testnet books). */
const slipFor = (b: { bid: number | null; ask: number | null }) => (b.bid && b.ask ? Math.min(0.1, (b.ask - b.bid) / b.bid + 0.01) : 0.01);
const POOL_FUNDING = 40;
const REPRICE_FUNDING = 5;
const TOP_UP = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function part3(opts: { dryRun: boolean; ownerApproved?: string }): Promise<void> {
  const log = new RunLog('part3');
  if (opts.ownerApproved) approveTestnetStepsInAdvance(opts.ownerApproved, log);
  const s = new Session(log, opts.dryRun ? null : loadWallet());
  let state = await s.risk();
  const unified = state.abstraction === 'unifiedAccount';
  const mode = unified ? 'unified' : 'standard';
  const pool = () => state.risk.pools.find((p) => p.positions.some((x) => x.position.coin.startsWith('xyz:'))) ?? null;
  const gold = await s.book(LONG.coin);
  const second = await s.book(SECOND.coin);
  const gAsset = state.assets.get(LONG.coin)!;
  const nAsset = state.assets.get(SECOND.coin)!;
  console.log(`\nTest wallet ${WALLET} on testnet, ${mode} mode. Account value ${state.risk.accountValue.toFixed(2)} mock USDC.`);
  console.log(`  ${LONG.coin}: bid ${gold.bid} / ask ${gold.ask} (asks within 5 levels $${gold.askDepth.toFixed(0)}, bids $${gold.bidDepth.toFixed(0)})`);
  console.log(`  ${SECOND.coin}: bid ${second.bid} / ask ${second.ask} (asks within 5 levels $${second.askDepth.toFixed(0)}, bids $${second.bidDepth.toFixed(0)})`);
  if (!gold.ask || !gold.bid || !second.ask || !second.bid) throw new Error('A testnet book is missing a side (GOLD or XYZ100 needs both bids and asks). Try again later; nothing was done.');
  const gSlip = slipFor(gold);
  const sSlip = slipFor(second);
  if (opts.dryRun) {
    console.log(`\nPlan (dry run, nothing signed):
  ${unified ? '' : `1. Move ${POOL_FUNDING} mock USDC from your main balance into the xyz pool (to yourself).\n  `}2. Set ${LEVERAGE}x cross on GOLD and XYZ100, buy ~$${LONG.usd} of GOLD (at most ${(gSlip * 100).toFixed(1)}% above the ask) and ~$${SECOND.usd} of XYZ100 (at most ${(sSlip * 100).toFixed(1)}%: its testnet spread is wide), immediate-or-cancel.
  3. Your own stop-loss on the XYZ100 long: a reduce-only stop-market sell 20% below the mark.
  4. Sign rules (next version): stage 1 trims the largest position by 50% at a line just above your buffer (fires at once: the canary)${unified ? '' : `; stage 2 tops up $${TOP_UP} at the same line`}; stage 3 alerts at 2.0x, so the guard's backstop rests below the price.
  5. Watch the guard for 3 minutes, then move ${REPRICE_FUNDING} mock USDC into the pool so it re-prices the backstops; watch 2 more minutes.
  ${NOT_MONEY}`);
    return;
  }

  await s.signIn();
  const startSeq = Math.max(0, ...(await auditSince(s, 0)).map((e) => e.seq));
  const builder = s.builder();
  const me = (await s.api<{ builder: { approvedMaxTenthsBps: number }; policy: { version: number } | null }>('/v1/me')).body;
  const attach = builder && me.builder?.approvedMaxTenthsBps >= builder.f ? builder : null;

  // 1. fund the xyz pool (standard mode: each venue has its own balance)
  if (!unified) {
    checkDestination('self', WALLET);
    if (!(await confirm({ what: `Move ${POOL_FUNDING} mock USDC from your main perps balance into the xyz pool, to yourself.`, amount: `${POOL_FUNDING} mock USDC.`, limit: NOT_MONEY }))) return void console.log('Stopped.');
    const r = await s.userSigned('fund xyz pool', sendAssetAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, destination: WALLET, sourceDex: '', destinationDex: 'xyz', token: USDC_TOKEN.testnet, amount: String(POOL_FUNDING), nonce: Date.now() }));
    console.log(`  ${r.ok ? 'Moved.' : `Refused: ${r.error}`}`);
    if (!r.ok) return;
  }

  // 2. open the two positions with the trading key
  const gSize = ceilSize(LONG.usd / gold.ask, gAsset.szDecimals);
  const nSize = ceilSize(SECOND.usd / second.ask, nAsset.szDecimals);
  // Hyperliquid refuses limits too far from the oracle ("Price too far from oracle": a 15% limit was refused on
  // 6 Oct), so a buy limit is capped at 8% above the oracle; a market whose ask is beyond that is skipped.
  const oracle = async (coin: string) => {
    const [meta, ctxs] = await s.info.metaAndAssetCtxs('xyz');
    const i = (meta as { universe: Array<{ name: string }> }).universe.findIndex((u) => u.name === coin);
    return Number((ctxs[i] as { oraclePx?: string })?.oraclePx ?? NaN);
  };
  const capBuy = async (coin: string, ask: number, slip: number) => Math.min(ask * (1 + slip), (await oracle(coin)) * 1.08);
  const gPx = roundPrice(await capBuy(LONG.coin, gold.ask, gSlip), gAsset.szDecimals, 'up');
  const nPx = roundPrice(await capBuy(SECOND.coin, second.ask, sSlip), nAsset.szDecimals, 'up');
  if (nPx < second.ask) console.log(`  ${SECOND.coin}: its best ask (${second.ask}) is more than 8% above the oracle, so a buy would be refused; it is skipped.`);
  if (!(await confirm({ what: `Open the test positions with your trading key: ${LEVERAGE}x cross, buy ${gSize} GOLD (limit ${gPx}) and buy ${nSize} XYZ100 (limit ${nPx}), immediate-or-cancel${attach ? ', with the Bulwark fee' : ''}.`, amount: `About $${(gSize * gold.ask).toFixed(2)} + $${(nSize * second.ask).toFixed(2)} of mock notional.`, limit: NOT_MONEY }))) return void console.log('Stopped.');
  for (const a of [gAsset, nAsset]) await s.withTradingKey(`leverage ${a.coin}`, updateLeverageAction(a.assetId, !a.onlyIsolated, LEVERAGE));
  const g = await s.withTradingKey('open GOLD long', orderAction([orderWire({ asset: gAsset.assetId, isBuy: true, limitPx: toWire(gPx), size: toWire(gSize), reduceOnly: false, orderType: { limit: { tif: 'Ioc' } } })], attach));
  const n = nPx < second.ask ? { statuses: [{ kind: 'skipped', reason: 'ask beyond the oracle band' }] } : await s.withTradingKey('open XYZ100 long', orderAction([orderWire({ asset: nAsset.assetId, isBuy: true, limitPx: toWire(nPx), size: toWire(nSize), reduceOnly: false, orderType: { limit: { tif: 'Ioc' } } })], attach));
  console.log(`  GOLD: ${JSON.stringify(g.statuses)}\n  XYZ100: ${JSON.stringify(n.statuses)}`);

  // 3. your own stop-loss on the second position (a real signed trigger order)
  await sleep(2000);
  state = await s.risk();
  const held = state.snapshot.positions.find((p) => p.coin === SECOND.coin);
  if (held) {
    const trig = roundPrice(held.markAtSnapshot * 0.8, nAsset.szDecimals, 'down');
    const lim = roundPrice(held.markAtSnapshot * 0.75, nAsset.szDecimals, 'down');
    const size = Math.abs(held.size);
    if (await confirm({ what: `Place your own stop-loss on the XYZ100 long: reduce-only stop-market sell of ${size} if the mark falls to ${trig} (limit ${lim}).`, amount: `${size} XYZ100, closes the long only.`, limit: NOT_MONEY })) {
      const r = await s.withTradingKey('user stop-loss', orderAction([orderWire({ asset: nAsset.assetId, isBuy: false, limitPx: toWire(lim), size: toWire(size), reduceOnly: true, orderType: { trigger: { isMarket: true, triggerPx: toWire(trig), tpsl: 'sl' } } })], attach));
      console.log(`  Stop-loss: ${JSON.stringify(r.statuses)}`);
    }
  } else console.log('  No XYZ100 position (the buy did not fill), so no stop-loss.');

  // 4. rules that make the guard act now
  state = await s.risk();
  const p = pool();
  if (!p) throw new Error('No open position in the xyz pool; nothing for the guard to do. See the run log.');
  const line = Math.ceil(p.buffer * 1.15 * 100) / 100;
  const version = (me.policy?.version ?? 0) + 1;
  const policy: Policy = {
    version,
    account: WALLET.toLowerCase() as `0x${string}`,
    rules: [
      { id: 'canary-trim', when: { kind: 'buffer', below: line }, then: [{ kind: 'reduce', target: { kind: 'first_position' }, fraction: 0.5 }], repeat: { mode: 'oncePerBreach' } },
      ...(unified ? [] : [{ id: 'top-up', when: { kind: 'buffer' as const, below: line }, then: [{ kind: 'topUp' as const, maxUsdc: TOP_UP }], repeat: { mode: 'oncePerBreach' as const } }]),
      { id: 'low-alert', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }], repeat: { mode: 'everyCrossing' } },
    ],
    execution: { maxSlippagePct: 1 },
  };
  if (!(await confirm({ what: `Sign rules version ${version}. Your xyz pool's buffer is ${p.buffer.toFixed(2)}x, so a line at ${line}x is already crossed: the guard trims the largest position by 50% at once${unified ? '' : ` and tops up $${TOP_UP}`}. A 2.0x alert sets where its backstops rest.`, amount: `Trim: half of the largest position (mock). ${unified ? '' : `Top-up: ${TOP_UP} mock USDC.`}`, limit: NOT_MONEY }))) return void console.log('Stopped.');
  const signed = await s.signPolicy(policy);
  console.log(`  Saved: ${signed.status} ${JSON.stringify(signed.body)}`);

  // 5. watch, then re-price
  const watch = async (label: string, ms: number) => {
    const seen = new Set<number>();
    const end = Date.now() + ms;
    while (Date.now() < end) {
      for (const e of await auditSince(s, startSeq)) {
        if (seen.has(e.seq)) continue;
        seen.add(e.seq);
        log.write(`guard: ${label}`, { seq: e.seq, kind: e.kind, why: e.why, what: e.what, proof: e.proof ?? null });
        console.log(`  [${new Date(e.at).toISOString().slice(11, 19)}] ${e.kind}: ${e.what}`);
      }
      await sleep(5000);
    }
  };
  console.log('\nWatching the guard for 3 minutes (trim, top-up, backstops)…');
  await watch('after rules', 180_000);
  if (await confirm({ what: `Move ${REPRICE_FUNDING} mock USDC into the xyz pool${unified ? ' (unified: from spot to perps)' : ''}. The margin changes, so the guard re-prices its backstops.`, amount: `${REPRICE_FUNDING} mock USDC.`, limit: NOT_MONEY })) {
    const r = await s.userSigned('margin change for re-pricing', sendAssetAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, destination: WALLET, sourceDex: unified ? 'spot' : '', destinationDex: 'xyz', token: USDC_TOKEN.testnet, amount: String(REPRICE_FUNDING), nonce: Date.now() }));
    console.log(`  ${r.ok ? 'Moved.' : `Refused: ${r.error}`}`);
    console.log('\nWatching the re-pricing for 2 minutes…');
    await watch('after margin change', 120_000);
  }

  const audit = await auditSince(s, startSeq);
  const orders = (await s.api('/v1/guard-orders')).body;
  const file = new URL(`audit-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, RUN_DIR);
  writeFileSync(file, JSON.stringify({ wallet: WALLET, network: 'testnet', mode, policy, guardOrders: orders, audit }, null, 1));
  log.write('audit saved', { file: file.pathname, entries: audit.length });
  console.log(`\nSaved ${audit.length} guard entries to ${file.pathname}. Part 3 (${mode}) is done.`);
}
