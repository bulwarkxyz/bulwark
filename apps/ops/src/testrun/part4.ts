/**
 * Test run, part 4 (testnet, no real money): close every xyz position, cancel your own open orders, wait for
 * the guard to remove its backstops, then switch the account to unified mode (userSetAbstraction, signed by the
 * wallet, as the app's Settings > Account mode does). After this, run part3 again for the unified repeat.
 *
 *   pnpm --filter @bulwarkxyz/ops testrun part4 [--dry-run] [--no-switch]
 */
import { roundPrice, toWire } from '@bulwarkxyz/guard-core';
import { cancelAction, orderAction, orderWire, userSetAbstractionAction } from '@bulwarkxyz/hyperliquid';
import { RunLog, WALLET, confirm, loadWallet } from './guard.js';
import { CHAIN, SIGNATURE_CHAIN_ID, Session } from './session.js';

const NOT_MONEY = 'Testnet only, mock USDC, no real money. Does not count toward the 13 USDC limit.';
/** How far from the book a close may fill: the spread plus 1%, at least 2%, at most 10% (thin testnet books, mock money). */
const slipFor = (b: { bid: number | null; ask: number | null }) => (b.bid && b.ask ? Math.min(0.1, Math.max(0.02, (b.ask - b.bid) / b.bid + 0.01)) : 0.02);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function part4(opts: { dryRun: boolean; switchMode: boolean }): Promise<void> {
  const log = new RunLog('part4');
  const s = new Session(log, opts.dryRun ? null : loadWallet());
  if (!opts.dryRun) await s.signIn();
  const state = await s.risk();
  const positions = state.snapshot.positions.filter((p) => p.coin.startsWith('xyz:') && p.size !== 0);
  const open = await s.openOrders('xyz');
  const go = (await s.api<Array<{ oid: number }>>('/v1/guard-orders')).body;
  const guardOids = new Set((Array.isArray(go) ? go : []).map((o) => o.oid));
  const mine = open.filter((o) => !guardOids.has(o.oid));
  console.log(`\nTest wallet ${WALLET} on testnet, ${state.abstraction} mode.`);
  console.log(`  Positions: ${positions.map((p) => `${p.coin} ${p.size}`).join(', ') || 'none'}`);
  console.log(`  Your open orders: ${mine.map((o) => `${o.coin} #${o.oid} ${o.orderType}`).join(', ') || 'none'}; the guard's: ${[...guardOids].join(', ') || 'none'}`);
  if (opts.dryRun) {
    console.log(`\nPlan (dry run, nothing signed): close each position above (reduce-only, within the spread plus 1% of the book, 2–10%), cancel your own open orders, wait for the guard to remove its backstops${opts.switchMode ? ', then switch the account to unified mode' : ''}.\n  ${NOT_MONEY}`);
    return;
  }

  if (positions.length || mine.length) {
    if (!(await confirm({ what: `Close ${positions.length} position(s) with reduce-only immediate-or-cancel orders and cancel ${mine.length} of your own open order(s). The guard's own orders are left to the guard.`, amount: positions.map((p) => `${Math.abs(p.size)} ${p.coin}`).join(', ') || 'No positions.', limit: NOT_MONEY }))) return void console.log('Stopped.');
    for (const o of mine) {
      const a = state.assets.get(o.coin)!;
      const r = await s.withTradingKey(`cancel ${o.coin} #${o.oid}`, cancelAction([{ asset: a.assetId, oid: o.oid }]));
      console.log(`  Cancel #${o.oid}: ${r.ok ? 'done' : r.error}`);
    }
    for (const p of positions) {
      const a = state.assets.get(p.coin)!;
      const b = await s.book(p.coin);
      const isBuy = p.size < 0;
      const ref = isBuy ? b.ask : b.bid;
      if (!ref) {
        console.log(`  ${p.coin}: no ${isBuy ? 'asks' : 'bids'} on the testnet book now; close it later (run part4 again).`);
        continue;
      }
      const slip = slipFor(b);
      const px = roundPrice(ref * (1 + (isBuy ? slip : -slip)), a.szDecimals, isBuy ? 'up' : 'down');
      const r = await s.withTradingKey(`close ${p.coin}`, orderAction([orderWire({ asset: a.assetId, isBuy, limitPx: toWire(px), size: toWire(Math.abs(p.size)), reduceOnly: true, orderType: { limit: { tif: 'Ioc' } } })]));
      console.log(`  Close ${p.coin}: ${JSON.stringify(r.statuses)}`);
    }
  }

  console.log('\nWaiting for the guard to remove its backstops (it re-plans within about a minute)…');
  for (let i = 0; i < 24; i++) {
    const lb = (await s.api<unknown[]>('/v1/guard-orders')).body;
    const left = Array.isArray(lb) ? lb : [];
    const still = (await s.risk()).snapshot.positions.filter((p) => p.coin.startsWith('xyz:') && p.size !== 0);
    if (!left.length && !still.length) break;
    if (i === 23) console.log(`  Still open after 2 minutes: ${still.length} position(s), ${left.length} guard order(s). Run part4 again.`);
    await sleep(5000);
  }
  log.write('closed', { positions: (await s.risk()).snapshot.positions.map((p) => ({ coin: p.coin, size: p.size })), guardOrders: (await s.api('/v1/guard-orders')).body });

  if (!opts.switchMode) return void console.log('Done (no mode switch asked).');
  const now = await s.info.userAbstraction(WALLET);
  if (now === 'unifiedAccount') return void console.log('Already in unified mode. Run part3 again for the unified repeat.');
  if (!(await confirm({ what: 'Switch the test account to unified mode on Hyperliquid testnet (one balance backs every position), signed by the wallet as in the app\'s Settings > Account mode.', amount: 'None.', limit: NOT_MONEY }))) return void console.log('Stopped before switching.');
  const r = await s.userSigned('switch to unified', userSetAbstractionAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, user: WALLET, abstraction: 'unifiedAccount', nonce: Date.now() }));
  await sleep(2000);
  const after = await s.info.userAbstraction(WALLET);
  log.write('mode after switch', { abstraction: after, ok: r.ok, error: r.error ?? null });
  console.log(`  ${r.ok ? '' : `Refused: ${r.error}. `}Hyperliquid now reports: ${after}. ${after === 'unifiedAccount' ? 'Run part3 again for the unified repeat.' : ''}`);
}
