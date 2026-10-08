/**
 * Testnet only, mock USDC: close every position on the test wallet and cancel its open orders, so a run that needs a
 * flat account (part5 --rehearse) can start. `testrun demo-state` puts the filming state back afterwards.
 *
 *   pnpm --filter @bulwarkxyz/ops testrun flatten --owner-approved "note"
 */
import { roundPrice, toWire } from '@bulwarkxyz/guard-core';
import { cancelAction, orderAction, orderWire } from '@bulwarkxyz/hyperliquid';
import { RunLog, approveTestnetStepsInAdvance, confirm, loadWallet } from './guard.js';
import { Session } from './session.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function flatten(opts: { ownerApproved?: string }): Promise<void> {
  const log = new RunLog('flatten');
  if (opts.ownerApproved) approveTestnetStepsInAdvance(opts.ownerApproved, log);
  const s = new Session(log, loadWallet());
  await s.signIn();
  for (let round = 0; round < 4; round++) {
    const st = await s.risk();
    const positions = st.snapshot.positions;
    if (!positions.length) return void console.log('flat: no open positions');
    for (const dex of ['', 'xyz']) {
      const open = await s.openOrders(dex);
      if (!open.length) continue;
      const ids = open.map((o) => ({ asset: st.assets.get(o.coin)!.assetId, oid: o.oid }));
      if (!(await confirm({ what: `Cancel ${open.length} open order(s) on the ${dex || 'main'} pool.`, amount: 'No money moves.', limit: 'Testnet only, mock USDC.' }))) return;
      await s.withTradingKey(`cancel ${dex || 'main'}`, cancelAction(ids));
    }
    for (const p of positions) {
      const a = st.assets.get(p.coin)!;
      const b = await s.book(p.coin);
      const sell = p.size > 0;
      const ref = sell ? b.bid : b.ask;
      if (!ref) throw new Error(`${p.coin}: no ${sell ? 'bids' : 'asks'} on testnet now`);
      const px = roundPrice(ref * (sell ? 0.98 : 1.02), a.szDecimals, sell ? 'down' : 'up');
      if (!(await confirm({ what: `${sell ? 'Sell' : 'Buy'} ${Math.abs(p.size)} ${p.coin}, reduce-only, limit ${px}, immediate-or-cancel.`, amount: 'Closes the position only.', limit: 'Testnet only, mock USDC.' }))) return;
      const r = await s.withTradingKey(`close ${p.coin}`, orderAction([orderWire({ asset: a.assetId, isBuy: !sell, limitPx: toWire(px), size: toWire(Math.abs(p.size)), reduceOnly: true, orderType: { limit: { tif: 'Ioc' } } })]));
      console.log(`  ${p.coin}: ${JSON.stringify(r.statuses)}`);
    }
    await sleep(2000);
  }
  console.log('still not flat after 4 rounds; check the account');
}
