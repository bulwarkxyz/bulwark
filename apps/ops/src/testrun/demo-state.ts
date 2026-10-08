/**
 * Testnet only, mock USDC: put the test wallet in an ordinary-looking state for filming the demo video. Standard
 * mode; GOLD in the xyz pool and BTC in the main pool at 5x cross with ordinary margins (no test configuration: the
 * backstops sit far below the price). Rules are not signed here: the video signs them in the app, from a sentence.
 *
 *   pnpm --filter @bulwarkxyz/ops testrun demo-state [--owner-approved "note"]
 */
import { ceilSize, roundPrice, toWire } from '@bulwarkxyz/guard-core';
import { USDC_TOKEN, orderAction, orderWire, sendAssetAction, updateLeverageAction, usdClassTransferAction, userSetAbstractionAction } from '@bulwarkxyz/hyperliquid';
import { RunLog, WALLET, approveTestnetStepsInAdvance, confirm, loadWallet } from './guard.js';
import { CHAIN, SIGNATURE_CHAIN_ID, Session } from './session.js';

export const DEMO = { legs: [{ coin: 'xyz:GOLD', usd: 100, pool: 'xyz' as const, margin: 30 }, { coin: 'BTC', usd: 200, pool: '' as const, margin: 45 }], leverage: 5 };
const NOT_MONEY = 'Testnet only, mock USDC, no real money.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function demoState(opts: { ownerApproved?: string }): Promise<void> {
  const log = new RunLog('demo-state');
  if (opts.ownerApproved) approveTestnetStepsInAdvance(opts.ownerApproved, log);
  const s = new Session(log, loadWallet());
  await s.signIn();
  if ((await s.info.userAbstraction(WALLET)) === 'unifiedAccount') {
    await s.userSigned('switch to standard', userSetAbstractionAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, user: WALLET, abstraction: 'disabled', nonce: Date.now() }));
    await sleep(2000);
  }
  const value = async (dex: string) => Number(((await s.info.clearinghouseState(WALLET, dex)) as { marginSummary: { accountValue: string } }).marginSummary.accountValue);
  for (const leg of DEMO.legs) {
    const have = await value(leg.pool);
    const add = Math.round((leg.margin - have) * 100) / 100;
    if (add <= 0.5) continue;
    if (!(await confirm({ what: `Put about ${leg.margin} mock USDC in the ${leg.pool || 'main'} pool (to yourself).`, amount: `${add} mock USDC.`, limit: NOT_MONEY }))) return;
    await s.userSigned('spot to main perps', usdClassTransferAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, amount: String(add), toPerp: true, nonce: Date.now() }));
    await sleep(1500);
    if (leg.pool === 'xyz') await s.userSigned('main to xyz pool', sendAssetAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, destination: WALLET, sourceDex: '', destinationDex: 'xyz', token: USDC_TOKEN.testnet, amount: String(add), nonce: Date.now() }));
    await sleep(1500);
  }
  const st = await s.risk();
  for (const leg of DEMO.legs) {
    const a = st.assets.get(leg.coin)!;
    const held = st.snapshot.positions.find((p) => p.coin === leg.coin);
    if (held && Math.abs(held.size) * held.markAtSnapshot >= leg.usd * 0.6) continue;
    const b = await s.book(leg.coin);
    if (!b.ask) throw new Error(`${leg.coin}: no asks on testnet now`);
    const size = ceilSize(leg.usd / b.ask, a.szDecimals);
    const px = roundPrice(b.ask * 1.02, a.szDecimals, 'up');
    if (!(await confirm({ what: `${DEMO.leverage}x cross, buy ${size} ${leg.coin} (limit ${px}), immediate-or-cancel.`, amount: `About $${(size * b.ask).toFixed(0)} of mock notional.`, limit: NOT_MONEY }))) return;
    await s.withTradingKey(`leverage ${leg.coin}`, updateLeverageAction(a.assetId, true, DEMO.leverage));
    const r = await s.withTradingKey(`open ${leg.coin}`, orderAction([orderWire({ asset: a.assetId, isBuy: true, limitPx: toWire(px), size: toWire(size), reduceOnly: false, orderType: { limit: { tif: 'Ioc' } } })]));
    console.log(`  ${leg.coin}: ${JSON.stringify(r.statuses)}`);
  }
  const after = await s.risk();
  console.log(JSON.stringify(after.risk.pools.map((p) => ({ pool: p.pool.id, equity: +p.equity.toFixed(2), buffer: +p.buffer.toFixed(2), positions: p.positions.map((r) => `${r.position.coin} ${r.position.size}`) }))));
}
