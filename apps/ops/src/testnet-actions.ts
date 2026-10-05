/**
 * B2 testnet run: every action Bulwark uses, end to end, from the D6 test wallets on Hyperliquid testnet.
 * Run on this Mac only (keys are in the Keychain):  pnpm --filter @bulwarkxyz/ops testnet:actions
 * Evidence is written to evidence/testnet-actions-<time>.json.
 */
import { execFileSync } from 'node:child_process';
import { BUILDER_ADDRESS, BUILDER_APPROVE_MAX_RATE, BUILDER_APPROVE_MAX_TENTHS_BPS, BUILDER_FEE_TENTHS_BPS } from '@bulwarkxyz/config';
import { CommandSigner, GuardedSigner, executeActions, planUnwind, stopCancels, type ExecutorDeps } from '@bulwarkxyz/executor';
import {
  buildAssetIndex,
  buildSnapshot,
  dexCollateral,
  evaluate,
  planBackstops,
  policyHash,
  roundPrice,
  toWire,
  type ExecutionContext,
  type Policy,
  type RawPerpDexs,
  type RawPerpMeta,
} from '@bulwarkxyz/guard-core';
import {
  agentName,
  approveAgentAction,
  approveBuilderFeeAction,
  claimRewardsAction,
  orderAction,
  orderWire,
  updateLeverageAction,
  usdSendAction,
  userSetAbstractionAction,
  type Hex,
} from '@bulwarkxyz/hyperliquid';
import { LocalDigestSigner } from '@bulwarkxyz/signer';
import { generatePrivateKey } from 'viem/accounts';
import { SCRIPT_CHAIN_ID, Session, WALLETS, keychainSigner, perpUsdc } from './lib.js';

const s = new Session('testnet');

function testnetAgent(): LocalDigestSigner {
  try {
    return keychainSigner(WALLETS.testnetAgent);
  } catch {
    execFileSync('security', ['add-generic-password', '-s', WALLETS.testnetAgent, '-a', 'bulwark', '-w', generatePrivateKey(), '-U']);
    return keychainSigner(WALLETS.testnetAgent);
  }
}

async function snapshotFor(user: Hex) {
  const perpDexs = (await s.info.perpDexs()) as RawPerpDexs;
  const metas = (await s.info.allPerpMetas()) as RawPerpMeta[];
  const assets = buildAssetIndex(perpDexs, metas);
  const collateral = dexCollateral(perpDexs, metas);
  const abstraction = await s.info.userAbstraction(user);
  const dexStates: Record<string, never> = {};
  for (const dex of ['', 'xyz']) dexStates[dex] = (await s.info.clearinghouseState(user, dex)) as never;
  const spot = (await s.info.spotClearinghouseState(user)) as never;
  return { assets, snapshot: buildSnapshot({ abstraction, dexStates, spot, assets, dexCollateral: collateral }) };
}

async function mid(coin: string): Promise<number> {
  const mids = await s.info.allMids(coin.includes(':') ? coin.split(':')[0] : '');
  return Number(mids[coin]);
}

async function main() {
  const A = keychainSigner(WALLETS.standard);
  const B = keychainSigner(WALLETS.unified);
  const builder = keychainSigner(WALLETS.builder);
  const agent = testnetAgent();

  // 0. Funded on testnet?
  for (const [name, w] of [['A', A], ['B', B]] as const) {
    const role = await s.info.userRole(w.address);
    s.note(`testnet account ${name}`, { address: w.address, role });
    if (role.role === 'missing') {
      console.error(`\nWallet ${name} has no testnet account yet. Claim the faucet at https://app.hyperliquid-testnet.xyz/drip with ${w.address}, or send it testnet USDC.`);
      process.exitCode = 2;
      console.log(`evidence: ${s.save('testnet-actions')}`);
      return;
    }
  }

  // 1. User approves the guard's agent key (user-signed), expiring in 7 days.
  await s.user(A, approveAgentAction({ chain: s.chain, signatureChainId: SCRIPT_CHAIN_ID, agentAddress: agent.address, agentName: agentName('bulwark', Date.now() + 7 * 864e5), nonce: s.nonces.next(A.address) }), 'A approveAgent');
  s.note('A extraAgents', await s.info.extraAgents(A.address));

  // 2. Builder needs ≥100 USDC perps value in standard mode (testnet only; mainnet builder stays unfunded per D6).
  if ((await perpUsdc(s.info, builder.address)) < 100) {
    await s.user(A, usdSendAction({ chain: s.chain, signatureChainId: SCRIPT_CHAIN_ID, destination: builder.address, amount: '110', time: s.nonces.next(A.address) }), 'A funds testnet builder 110 USDC');
  }
  s.note('builder abstraction', await s.info.userAbstraction(builder.address));

  // 3. User approves the builder fee (user-signed).
  await s.user(A, approveBuilderFeeAction({ chain: s.chain, signatureChainId: SCRIPT_CHAIN_ID, maxFeeRate: BUILDER_APPROVE_MAX_RATE, builder: BUILDER_ADDRESS, nonce: s.nonces.next(A.address) }), 'A approveBuilderFee 0.05%');
  s.note('A maxBuilderFee (tenths of a bp)', await s.info.maxBuilderFee(A.address, BUILDER_ADDRESS));
  const rewardsBefore = await s.info.referral(builder.address);

  // 4. Test setup: a user-style opening order on a deep testnet book (BTC), carrying the builder code.
  const { assets } = await snapshotFor(A.address);
  const btc = assets.get('BTC')!;
  const btcMid = await mid('BTC');
  const size = toWire(Math.ceil((60 / btcMid) * 10 ** btc.szDecimals) / 10 ** btc.szDecimals);
  await s.l1(agent, orderAction([orderWire({ asset: btc.assetId, isBuy: true, limitPx: toWire(roundPrice(btcMid * 1.01, btc.szDecimals, 'up')), size, reduceOnly: false, orderType: { limit: { tif: 'Ioc' } } })], { b: BUILDER_ADDRESS, f: BUILDER_FEE_TENTHS_BPS }), 'setup: open BTC long ~$60 (builder code)', undefined);

  // 5. Guard path: a policy whose line sits above the current buffer, so stage 1 fires (forced trim).
  const { snapshot } = await snapshotFor(A.address);
  const pool = snapshot.pools.find((p) => p.kind === 'dex' && p.dex === '');
  const policy: Policy = {
    version: 1,
    account: A.address,
    rules: [
      { id: 'canary', when: { kind: 'buffer', below: 1_000_000 }, then: [{ kind: 'reduce', target: { kind: 'market', market: 'BTC' }, fraction: 0.5 }] },
      { id: 'backstop-line', when: { kind: 'buffer', below: 1.05 }, then: [{ kind: 'alert' }] },
    ],
    execution: { maxSlippagePct: 1 },
  };
  s.note('policy', { hash: policyHash(policy), pool: pool?.id });
  const guarded = new GuardedSigner(agent, false);
  const ctx: ExecutionContext = {
    now: Date.now(),
    baselines: {},
    openOrders: [],
    latched: new Set(),
    automationAllowed: true,
    confirmation: { policyHash: policyHash(policy), signatureVerified: true },
    killSwitch: false,
    recentActions: [],
    builder: { enabled: true, approvedMaxTenthsBps: BUILDER_APPROVE_MAX_TENTHS_BPS, feeTenthsBps: BUILDER_FEE_TENTHS_BPS },
  };
  const deps: ExecutorDeps = { network: 'testnet', account: A.address, signer: guarded, exchange: s.exchange, nonces: s.nonces, assets, builder: { b: BUILDER_ADDRESS, f: BUILDER_FEE_TENTHS_BPS } };
  const decision = evaluate(policy, snapshot, undefined, ctx);
  const records = await executeActions(decision.actions, { policy, snapshot, marks: undefined, ctx }, deps);
  for (const r of records) s.note(`guard ${r.action.type}`, { status: r.status, error: r.error ?? null, violation: r.violation ?? null, statuses: r.result?.statuses ?? null, builderRetried: r.builderRetried, latencyMs: r.latencyMs });

  // 6. Backstop: place a reduce-only stop at the lowest line, confirm it rests, then the kill switch removes it.
  const after = await snapshotFor(A.address);
  const plan = planBackstops(policy, after.snapshot, undefined, []);
  const placed = await executeActions(plan.place, { policy, snapshot: after.snapshot, marks: undefined, ctx: { ...ctx, now: Date.now() } }, deps);
  const oids = placed.flatMap((r) => r.result?.statuses.filter((x) => x.kind === 'resting').map((x) => (x as { oid: number }).oid) ?? []);
  s.note('backstops resting', { oids, open: await s.info.frontendOpenOrders(A.address) });
  if (oids.length) {
    const cmd = { kind: 'stop' as const, issuedAt: Date.now(), verified: true };
    const wire = stopCancels(oids.map((oid) => ({ asset: btc.assetId, oid })))!;
    const nonce = s.nonces.next(agent.address);
    const sig = await new CommandSigner(agent, false).signStopCancel(cmd, wire, new Set(oids), nonce, Date.now());
    s.record('kill switch: cancel guard backstops', wire, await s.exchange.send({ action: wire, nonce, signature: sig }), 0);
  }

  // 7. Isolated top-up: isolated ETH position, then the guard adds isolated margin.
  const eth = assets.get('ETH')!;
  await s.l1(agent, updateLeverageAction(eth.assetId, false, 5), 'setup: ETH isolated 5x');
  const ethMid = await mid('ETH');
  await s.l1(agent, orderAction([orderWire({ asset: eth.assetId, isBuy: true, limitPx: toWire(roundPrice(ethMid * 1.01, eth.szDecimals, 'up')), size: toWire(Math.ceil((30 / ethMid) * 10 ** eth.szDecimals) / 10 ** eth.szDecimals), reduceOnly: false, orderType: { limit: { tif: 'Ioc' } } })]), 'setup: open ETH isolated ~$30');
  const iso = await snapshotFor(A.address);
  const topUpPolicy: Policy = { ...policy, version: 2, rules: [{ id: 'iso-topup', when: { kind: 'buffer', below: 1_000_000 }, then: [{ kind: 'topUp', maxUsdc: 2 }] }] };
  const isoCtx = { ...ctx, now: Date.now(), confirmation: { policyHash: policyHash(topUpPolicy), signatureVerified: true } };
  const isoDecision = evaluate(topUpPolicy, iso.snapshot, undefined, isoCtx);
  const isoRecords = await executeActions(isoDecision.actions.filter((a) => a.type === 'isolatedMargin' || a.type === 'transfer'), { policy: topUpPolicy, snapshot: iso.snapshot, marks: undefined, ctx: isoCtx }, deps);
  for (const r of isoRecords) s.note(`guard ${r.action.type}`, { status: r.status, error: r.error ?? null });

  // 8. Panic unwind (user command): closes everything left, reduce-only.
  const left = await snapshotFor(A.address);
  const cmd = { kind: 'unwind' as const, minutes: 5, issuedAt: Date.now(), verified: true };
  const cs = new CommandSigner(agent, false);
  for (const step of planUnwind(cmd, left.snapshot, undefined, 1)) {
    const nonce = s.nonces.next(agent.address);
    const sig = await cs.signUnwindStep(cmd, step, left.snapshot, nonce, Date.now());
    s.record(`unwind ${step.coin} (${step.wire.type})`, step.wire, await s.exchange.send({ action: step.wire, nonce, signature: sig }), 0);
  }

  // 9. Builder fee accrual and claim.
  s.note('A fills with builder fee', ((await s.info.request({ type: 'userFills', user: A.address })) as Array<Record<string, unknown>>).slice(0, 6).map((f) => ({ coin: f.coin, side: f.side, sz: f.sz, px: f.px, fee: f.fee, builderFee: f.builderFee ?? null })));
  s.note('builder rewards before → after', { before: rewardsBefore.builderRewards ?? null, after: (await s.info.referral(builder.address)).builderRewards ?? null });
  await s.l1(builder, claimRewardsAction(), 'builder claimRewards');

  // 10. Wallet B: switch to unified mode (user-signed) and confirm.
  await s.user(B, userSetAbstractionAction({ chain: s.chain, signatureChainId: SCRIPT_CHAIN_ID, user: B.address, abstraction: 'unifiedAccount', nonce: s.nonces.next(B.address) }), 'B userSetAbstraction unified');
  s.note('B abstraction', await s.info.userAbstraction(B.address));

  console.log(`evidence: ${s.save('testnet-actions')}`);
}

main().catch((e) => {
  console.error(e);
  console.log(`evidence: ${s.save('testnet-actions-error')}`);
  process.exitCode = 1;
});
