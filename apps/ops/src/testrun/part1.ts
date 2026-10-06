/**
 * Test run, part 1: deposit USDC from the test wallet to Hyperliquid mainnet through the bridge, then
 * claim the testnet faucet (1,000 mock USDC, which Hyperliquid gives only to addresses with a mainnet deposit).
 *
 *   pnpm --filter @bulwarkxyz/ops testrun part1              # asks before each action
 *   pnpm --filter @bulwarkxyz/ops testrun part1 --dry-run    # shows the plan with live balances; reads no key, sends nothing
 *
 * Safe to run again: a deposit already credited on Hyperliquid, or a faucet already claimed, is skipped.
 */
import { createPublicClient, createWalletClient, erc20Abi, formatEther, http, parseUnits } from 'viem';
import { arbitrum } from 'viem/chains';
import { BRIDGE, Ledger, LIMIT_USDC, MIN_DEPOSIT_USDC, Refused, RunLog, USDC_ARBITRUM, WALLET, checkDestination, confirm, loadWallet, usdc } from './guard.js';

const ARB_RPC = 'https://arb1.arbitrum.io/rpc';
const INFO = { mainnet: 'https://api.hyperliquid.xyz/info', testnet: 'https://api.hyperliquid-testnet.xyz/info' } as const;

const info = async <T>(net: keyof typeof INFO, body: Record<string, unknown>): Promise<T> => {
  const res = await fetch(INFO[net], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Hyperliquid ${net} answered ${res.status}`);
  return (await res.json()) as T;
};
type LedgerUpdate = { time: number; hash: string; delta: { type: string; usdc?: string } };
const deposits = (net: keyof typeof INFO, since = 0) => info<LedgerUpdate[]>(net, { type: 'userNonFundingLedgerUpdates', user: WALLET, startTime: since }).then((l) => l.filter((u) => u.delta.type === 'deposit'));
async function hlUsdc(net: keyof typeof INFO): Promise<{ perp: number; spot: number }> {
  const perp = await info<{ marginSummary: { accountValue: string } }>(net, { type: 'clearinghouseState', user: WALLET });
  const spot = await info<{ balances: Array<{ coin: string; total: string }> }>(net, { type: 'spotClearinghouseState', user: WALLET });
  return { perp: Number(perp.marginSummary.accountValue), spot: Number(spot.balances.find((b) => b.coin === 'USDC')?.total ?? 0) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function part1(opts: { dryRun: boolean; amount?: number }): Promise<void> {
  const log = new RunLog('part1');
  const ledger = new Ledger();
  const pub = createPublicClient({ chain: arbitrum, transport: http(ARB_RPC) });
  const [usdcRaw, ethWei, mainnetDeposits] = await Promise.all([
    pub.readContract({ address: USDC_ARBITRUM, abi: erc20Abi, functionName: 'balanceOf', args: [WALLET] }),
    pub.getBalance({ address: WALLET }),
    deposits('mainnet'),
  ]);
  const usdcBal = Number(usdcRaw) / 1e6;
  console.log(`\nTest wallet ${WALLET}`);
  console.log(`  Arbitrum: ${usdc(usdcBal)}, ${formatEther(ethWei)} ETH for gas`);
  console.log(`  Real money moved out so far: ${usdc(ledger.spent())} of the ${LIMIT_USDC} USDC limit`);

  // ---------------------------------------------------------------- 1. bridge deposit (real money)
  if (mainnetDeposits.length) {
    const d = mainnetDeposits.at(-1)!;
    console.log(`\n1. Deposit: already done, ${d.delta.usdc} USDC credited on Hyperliquid mainnet (${new Date(d.time).toISOString()}). Skipping.`);
  } else {
    const amount = Math.min(opts.amount ?? LIMIT_USDC, ledger.remaining(), Math.floor(usdcBal * 100) / 100);
    if (amount < MIN_DEPOSIT_USDC) throw new Refused(`Only ${usdc(amount)} can be deposited; Hyperliquid loses deposits under ${MIN_DEPOSIT_USDC} USDC. Nothing was done.`);
    ledger.check(amount);
    checkDestination('deposit', BRIDGE);
    const value = parseUnits(amount.toFixed(6), 6);
    const gas = await pub.estimateContractGas({ address: USDC_ARBITRUM, abi: erc20Abi, functionName: 'transfer', args: [BRIDGE, value], account: WALLET });
    const fees = await pub.estimateFeesPerGas();
    const gasCostWei = (gas * fees.maxFeePerGas * 12n) / 10n;
    if (gasCostWei > ethWei) throw new Refused(`Gas would cost up to ${formatEther(gasCostWei)} ETH; the wallet has ${formatEther(ethWei)}. Nothing was done.`);
    const plan = {
      what: `Send ${usdc(amount)} from the test wallet to Hyperliquid's bridge on Arbitrum (${BRIDGE}). Hyperliquid credits it to this same wallet on mainnet, usually within a minute.`,
      amount: `${usdc(amount)} (real money), plus up to ${formatEther(gasCostWei)} ETH gas`,
      limit: `${LIMIT_USDC} USDC for the whole test. Used so far ${usdc(ledger.spent())}; after this ${usdc(ledger.spent() + amount)}.`,
      notes: [`${usdc(usdcBal - amount)} stays in the wallet on Arbitrum.`, 'Deposits under 5 USDC are lost; this one is above that.'],
    };
    console.log('\n1. Bridge deposit');
    if (opts.dryRun) {
      console.log(`${JSON.stringify(plan, null, 2)}\n(dry run: nothing sent)`);
    } else {
      const account = loadWallet();
      if (!(await confirm(plan))) return void console.log('Stopped. Nothing was sent.');
      const wallet = createWalletClient({ account, chain: arbitrum, transport: http(ARB_RPC) });
      const before = Date.now() - 60_000;
      const tx = await wallet.writeContract({ address: USDC_ARBITRUM, abi: erc20Abi, functionName: 'transfer', args: [BRIDGE, value] });
      log.write('bridge deposit sent', { network: 'arbitrum', txHash: tx, usdc: amount, to: BRIDGE });
      ledger.add('bridge deposit', amount, tx);
      console.log(`  Sent: ${tx}`);
      const receipt = await pub.waitForTransactionReceipt({ hash: tx });
      log.write('bridge deposit mined', { network: 'arbitrum', txHash: tx, status: receipt.status, block: Number(receipt.blockNumber), gasUsed: Number(receipt.gasUsed) });
      if (receipt.status !== 'success') throw new Error(`The Arbitrum transaction ${tx} failed. Check it on arbiscan.io before trying again.`);
      console.log(`  Mined in block ${receipt.blockNumber}. Waiting for Hyperliquid to credit it…`);
      for (let i = 0; i < 36; i++) {
        const credited = (await deposits('mainnet', before)).at(-1);
        if (credited) {
          log.write('deposit credited', { network: 'hyperliquid-mainnet', hlHash: credited.hash, usdc: credited.delta.usdc, afterMs: credited.time - Date.now() });
          console.log(`  Credited on Hyperliquid mainnet: ${credited.delta.usdc} USDC (${credited.hash}).`);
          break;
        }
        if (i === 35) console.log('  Not credited after 3 minutes. Run part1 again later; it will find the deposit and skip it.');
        await sleep(5000);
      }
    }
  }

  // ---------------------------------------------------------------- 2. testnet faucet (no real money)
  const tn = await hlUsdc('testnet');
  const faucetBefore = (await info<LedgerUpdate[]>('testnet', { type: 'userNonFundingLedgerUpdates', user: WALLET, startTime: 0 })).length;
  console.log(`\n2. Testnet faucet. Testnet balance now: perps ${usdc(tn.perp)}, spot ${usdc(tn.spot)}.`);
  if (tn.perp + tn.spot >= 500) return void console.log('  Already funded on testnet. Skipping. Part 1 is done.');
  const faucetPlan = {
    what: "Ask Hyperliquid's testnet faucet for mock USDC for the test wallet (the same request its Claim button sends; it needs no signature).",
    amount: '1,000 mock USDC on testnet. It has no value.',
    limit: 'Not real money, so it does not count toward the 13 USDC limit.',
  };
  if (opts.dryRun) return void console.log(`${JSON.stringify(faucetPlan, null, 2)}\n(dry run: nothing sent)`);
  if (!(await hlUsdc('mainnet')).perp && !(await deposits('mainnet')).length) throw new Refused('No mainnet deposit yet, so the faucet would refuse. Run part1 again once the deposit is credited.');
  if (!(await confirm(faucetPlan))) return void console.log('Stopped. The faucet was not asked.');
  const res = await info<unknown>('testnet', { type: 'claimDrip', user: WALLET });
  log.write('faucet claimed', { network: 'hyperliquid-testnet', response: res });
  for (let i = 0; i < 24; i++) {
    const now = await hlUsdc('testnet');
    if (now.perp + now.spot > tn.perp + tn.spot) {
      log.write('faucet credited', { network: 'hyperliquid-testnet', perp: now.perp, spot: now.spot, ledgerEntriesBefore: faucetBefore });
      return void console.log(`  Testnet balance: perps ${usdc(now.perp)}, spot ${usdc(now.spot)}. Part 1 is done.`);
    }
    await sleep(5000);
  }
  console.log(`  The faucet answered ${JSON.stringify(res)}, but no balance arrived within 2 minutes. Tell Claude; nothing else needs doing.`);
}
