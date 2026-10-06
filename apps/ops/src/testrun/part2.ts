/**
 * Test run, part 2 (testnet, no real money): set up Bulwark for the test wallet through the live site's real
 * paths, as the app's setup screen does: sign in, region step, create the guard key (AWS KMS) and approve it on
 * Hyperliquid as "bulwark-guard", create and approve the trading key ("bulwark-web"), approve the Bulwark fee.
 *
 *   pnpm --filter @bulwarkxyz/ops testrun part2 [--dry-run]
 */
import { BUILDER_APPROVE_MAX_RATE } from '@bulwarkxyz/config';
import { agentName, approveAgentAction, approveBuilderFeeAction, type Hex } from '@bulwarkxyz/hyperliquid';
import { createInterface } from 'node:readline/promises';
import { RunLog, WALLET, confirm, loadWallet } from './guard.js';
import { CHAIN, SIGNATURE_CHAIN_ID, Session } from './session.js';

const DAYS = 30;
const NOT_MONEY = 'Testnet only, no real money. Does not count toward the 13 USDC limit.';
const until = () => Date.now() + DAYS * 86_400_000;

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(q)).trim();
  rl.close();
  return a;
}

export async function part2(opts: { dryRun: boolean }): Promise<void> {
  const log = new RunLog('part2');
  const s = new Session(log, opts.dryRun ? null : loadWallet());
  const agents = async () => (await s.info.extraAgents(WALLET)).map((a) => ({ name: a.name, address: a.address.toLowerCase(), validUntil: a.validUntil }));
  console.log(`\nTest wallet ${WALLET} on Hyperliquid testnet. Agents approved now: ${JSON.stringify(await agents())}`);
  if (opts.dryRun) {
    console.log(`\nPlan (dry run, nothing signed):
  1. Sign in to ${'https://bulwark.0xo.in'} with a wallet signature that authorises nothing.
  2. Region step: you type your country of residence and citizenship (two-letter codes).
  3. Create your guard key (AWS KMS), then approve it on Hyperliquid testnet as "bulwark-guard" for ${DAYS} days.
  4. Create a trading key for your own orders (kept in this Mac's Keychain), approve it as "bulwark-web" for ${DAYS} days.
  5. Approve the Bulwark fee on testnet, at most ${BUILDER_APPROVE_MAX_RATE}, if the fee is on there.
  ${NOT_MONEY}`);
    return;
  }

  // 1. sign in
  if (!(await confirm({ what: 'Sign in to bulwark.0xo.in with the test wallet (a message signature, as the app asks for).', amount: 'None. The signature authorises no transaction.', limit: NOT_MONEY }))) return void console.log('Stopped.');
  await s.signIn();
  let me = (await s.api<{ user: { region: string; agentAddress: string | null } | null; keyStatus: string; agent: { address: Hex; approved: boolean } | null; builder: { address: Hex; approvedMaxTenthsBps: number } }>('/v1/me')).body;
  console.log('  Signed in.');

  // 2. region
  if (!me.user || me.user.region !== 'allowed') {
    const residency = (await ask('\n  Your country of residence (two letters, e.g. IN): ')).toUpperCase();
    const citizenship = (await ask('  Your citizenship (two letters): ')).toUpperCase();
    if (!(await confirm({ what: `Send the region step: residence ${residency}, citizenship ${citizenship}. The site also checks your connection's country.`, amount: 'None.', limit: NOT_MONEY }))) return void console.log('Stopped.');
    const r = await s.api<{ verdict: string; guard: string }>('/v1/onboarding/attest', { body: { residency, citizenship } });
    log.write('region step', { status: r.status, response: r.body });
    console.log(`  Region: ${JSON.stringify(r.body)}`);
    if (r.body?.guard !== 'on') return void console.log('  The guard is not available for this region, so the test stops here.');
  }

  // 3. guard key
  me = (await s.api<typeof me>('/v1/me')).body;
  let guard = me.agent?.address ?? null;
  if (!guard) {
    if (!(await confirm({ what: 'Create your guard key on Bulwark (an AWS KMS key; its private key never leaves KMS).', amount: 'None.', limit: NOT_MONEY }))) return void console.log('Stopped.');
    const r = await s.api<{ agentAddress?: Hex; status?: string }>('/v1/onboarding/agent', { body: {} });
    log.write('guard key created', { status: r.status, agentAddress: r.body?.agentAddress ?? null });
    guard = r.body?.agentAddress ?? null;
    if (!guard) throw new Error(`guard key not created (${r.status})`);
  }
  if (!(await agents()).some((a) => a.address === guard!.toLowerCase())) {
    if (!(await confirm({ what: `Approve your guard key ${guard} on Hyperliquid testnet as "bulwark-guard". It can trade only within your rules and can never withdraw.`, amount: `None. Valid ${DAYS} days.`, limit: NOT_MONEY }))) return void console.log('Stopped.');
    const r = await s.userSigned('guard key approved', approveAgentAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, agentAddress: guard, agentName: agentName('bulwark-guard', until()), nonce: Date.now() }));
    console.log(`  ${r.ok ? 'Approved.' : `Refused: ${r.error}`}`);
  } else console.log(`  Guard key ${guard} is already approved.`);

  // 4. trading key
  let trading = s.tradingKey();
  if (!trading || !(await agents()).some((a) => a.address === trading!.address.toLowerCase())) {
    if (!(await confirm({ what: 'Create a trading key for your own orders (stored in this Mac\'s Keychain, never shown) and approve it on Hyperliquid testnet as "bulwark-web". It can trade, never withdraw.', amount: `None. Valid ${DAYS} days.`, limit: NOT_MONEY }))) return void console.log('Stopped.');
    trading = s.tradingKey(true)!;
    const r = await s.userSigned('trading key approved', approveAgentAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, agentAddress: trading.address, agentName: agentName('bulwark-web', until()), nonce: Date.now() }));
    console.log(`  ${r.ok ? `Approved ${trading.address}.` : `Refused: ${r.error}`}`);
  } else console.log(`  Trading key ${trading.address} is already approved.`);

  // 5. Bulwark fee
  const builder = s.builder();
  if (builder && !(me.builder?.approvedMaxTenthsBps > 0)) {
    if (!(await confirm({ what: `Approve the Bulwark fee on testnet: at most ${BUILDER_APPROVE_MAX_RATE} of each order's value, to ${builder.b}. Testnet fees are mock USDC.`, amount: `At most ${BUILDER_APPROVE_MAX_RATE} per order, testnet only.`, limit: NOT_MONEY }))) return void console.log('Stopped.');
    const r = await s.userSigned('builder fee approved', approveBuilderFeeAction({ chain: CHAIN, signatureChainId: SIGNATURE_CHAIN_ID, maxFeeRate: BUILDER_APPROVE_MAX_RATE, builder: builder.b, nonce: Date.now() }));
    console.log(`  ${r.ok ? 'Approved.' : `Refused: ${r.error}`}`);
  }

  const final = (await s.api<typeof me>('/v1/me')).body;
  log.write('setup done', { agents: await agents(), guardApproved: final.agent?.approved ?? false, keyStatus: final.keyStatus });
  console.log(`\nAgents on Hyperliquid testnet now: ${JSON.stringify(await agents())}`);
  console.log(`Bulwark sees the guard key as ${final.agent?.approved ? 'approved' : 'NOT approved yet'}. Part 2 is done.`);
  console.log('Optional, by hand: in the app, Settings > Alerts > Get a link code, then tap the Telegram link on your phone.');
}
