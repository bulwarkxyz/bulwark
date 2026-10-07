/**
 * Test run, part 6: withdraw what is left on Hyperliquid mainnet back to the test wallet on Arbitrum (REAL MONEY).
 * The wallet owner runs it at a terminal and types "yes"; it never runs from a script, a pipe or with an advance
 * approval. The only destination is the test wallet's own address. Hyperliquid charges $1 per withdrawal.
 *
 *   pnpm --filter @bulwarkxyz/ops testrun part6 [--dry-run]
 */
import { parseSignature } from 'viem';
import { ExchangeClient, InfoClient, USDC_TOKEN, sendAssetAction, userSignedTypedData, withdraw3Action, type ExchangeResult, type Hex, type UserSignedAction } from '@bulwarkxyz/hyperliquid';
import { Ledger, Refused, RunLog, WALLET, checkDestination, confirm, loadWallet } from './guard.js';

const FEE_USDC = 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rsv = (sig: Hex) => {
  const p = parseSignature(sig);
  return { r: p.r, s: p.s, v: Number(p.v ?? 27n + BigInt(p.yParity)) as 27 | 28 };
};

export async function part6(opts: { dryRun: boolean }): Promise<void> {
  const log = new RunLog('part6-withdrawal');
  const info = new InfoClient('mainnet', fetch, 20_000);
  const exchange = new ExchangeClient('mainnet');
  const state = async (dex: string) => (await info.clearinghouseState(WALLET, dex)) as { withdrawable: string; marginSummary: { accountValue: string }; assetPositions: unknown[] };
  const [main, xyz] = [await state(''), await state('xyz')];
  const xyzValue = Number(xyz.marginSummary.accountValue);
  const open = main.assetPositions.length + xyz.assetPositions.length;
  console.log(`\nWITHDRAWAL, test wallet ${WALLET} (Hyperliquid mainnet → Arbitrum)
  Main perps: ${Number(main.marginSummary.accountValue).toFixed(2)} USDC (withdrawable ${Number(main.withdrawable).toFixed(2)}); xyz pool: ${xyzValue.toFixed(2)} USDC; open positions: ${open}.
  Plan: ${xyzValue >= 0.01 ? `move ${Math.floor(xyzValue * 100) / 100} USDC from the xyz pool to main perps (to yourself), then ` : ''}withdraw all of main perps to ${WALLET} on Arbitrum. Hyperliquid keeps $${FEE_USDC}; the rest arrives in a few minutes.`);
  if (opts.dryRun) return;
  if (open) throw new Refused('There are open positions on mainnet; close them first (part 5 closes everything).');
  const wallet = loadWallet();
  const send = async (name: string, action: UserSignedAction): Promise<ExchangeResult> => {
    const sig = rsv(await wallet.signTypedData(userSignedTypedData(action) as never));
    const res = await exchange.send({ action, nonce: 'nonce' in action ? action.nonce : (action as { time: number }).time, signature: sig });
    log.write(name, { network: 'mainnet', ok: res.ok, error: res.error ?? null, statuses: res.statuses, action: { ...action, signatureChainId: undefined } });
    return res;
  };
  checkDestination('self', WALLET);
  const back = Math.floor(xyzValue * 100) / 100;
  if (back >= 0.01) {
    if (!(await confirm({ what: `Move ${back} USDC from the xyz pool to your main perps balance, to yourself.`, amount: `${back} USDC.`, limit: 'Real money, inside your own account.' }))) return;
    const r = await send('xyz pool to main', sendAssetAction({ chain: 'Mainnet', signatureChainId: '0xa4b1', destination: WALLET, sourceDex: 'xyz', destinationDex: '', token: USDC_TOKEN.mainnet, amount: String(back), nonce: Date.now() }));
    if (!r.ok) throw new Error(`transfer refused: ${r.error}`);
    await sleep(2000);
  }
  const amount = Math.floor(Number((await state('')).withdrawable) * 100) / 100;
  if (!(amount > FEE_USDC)) throw new Refused(`Only ${amount} USDC is withdrawable: not more than the $${FEE_USDC} fee.`);
  if (!(await confirm({ what: `Withdraw ${amount} USDC from Hyperliquid mainnet to ${WALLET} on Arbitrum (your own address).`, amount: `${amount} USDC; Hyperliquid keeps $${FEE_USDC}, so about ${(amount - FEE_USDC).toFixed(2)} USDC arrives.`, limit: 'Real money, back to your own wallet. Nothing goes anywhere else.' }))) return;
  const r = await send('withdraw to Arbitrum', withdraw3Action({ chain: 'Mainnet', signatureChainId: '0xa4b1', destination: WALLET, amount: String(amount), time: Date.now() }));
  if (!r.ok) throw new Error(`withdrawal refused: ${r.error}`);
  new Ledger().add('withdrawal back to the test wallet (Arbitrum)', -(amount - FEE_USDC), `withdraw3 ${new Date().toISOString()}`);
  console.log(`\n  Withdrawal accepted. About ${(amount - FEE_USDC).toFixed(2)} USDC arrives at ${WALLET} on Arbitrum within a few minutes (Arbiscan shows it). Tell Claude, and it records the transaction.`);
}
