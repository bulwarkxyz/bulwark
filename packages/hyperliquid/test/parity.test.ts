/**
 * Signature parity with @nktkas/hyperliquid: for every action Bulwark sends, our builder and hashing must
 * produce the same payload (same key order) and the same signature as the SDK, signed with the same key.
 * The SDK's signatures captured on 2026-10-05 are also frozen below as regression vectors.
 */
import { ExchangeClient as SdkExchange } from '@nktkas/hyperliquid';
import { parseSignature, recoverTypedDataAddress, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import * as A from '../src/actions.js';
import { l1ActionHash, l1TypedData, userSignedTypedData } from '../src/signing.js';

const KEY = `0x${'11'.repeat(32)}` as const;
const wallet = privateKeyToAccount(KEY);
const ME = wallet.address.toLowerCase() as A.Hex;
const NONCE = 1791150000000;
const CHAIN = '0xa4b1' as const;
const CLOID = `0x${'ab'.repeat(16)}` as const;
const BUILDER = '0x813843cf39a4d312182af6c5b85cff9290c42981' as const;
const USDC = 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054';

async function sdkPayload(call: (ex: SdkExchange) => Promise<unknown>): Promise<{ action: unknown; signature: { r: string; s: string; v: number } }> {
  let captured: unknown;
  const transport = { isTestnet: false, async request(_e: string, payload: unknown) { captured = payload; return { status: 'ok', response: { type: 'default' } }; } };
  const ex = new SdkExchange({ transport: transport as never, wallet, nonceManager: async () => NONCE, signatureChainId: CHAIN });
  try { await call(ex); } catch { /* response shape irrelevant */ }
  return captured as never;
}

async function ours(typed: TypedDataDefinition) {
  const sig = parseSignature(await wallet.signTypedData(typed as never));
  return { r: sig.r, s: sig.s, v: Number(sig.v) };
}

const l1 = (action: A.L1Action) => ours(l1TypedData(l1ActionHash({ action, nonce: NONCE }), true));

// SDK signatures captured 2026-10-05 (frozen).
const FROZEN: Record<string, string> = {
  order: '0xe0ea87685795abda96f90b4e0e11e38b08a94a049da6753f6e2483a3263a1642',
  trigger: '0x527bb67fab4c9bc2f019f8d5236474c4417f129fa9105e289a03e430b8b4d208',
  cancel: '0x2a96063c6e1cdfc74ca2e576592fe158996b982ebe2bb19dec3ab53611e75a8e',
  cancelByCloid: '0x31a91c80030f626e84605282f64e8c0adda3e2eb263f7f185f0e8236a93a92d5',
  updateIsolatedMargin: '0xf17753091f8b0db4b24a641ce6afa19cb8df0173187db72cb153e467ae7ca10f',
  agentSendAsset: '0xf305e8adf40637d549db93950b1188f2a807c366f9deb065268638c6a04e3e77',
  twapOrder: '0xd04dac3e6f9430d493ff7e10bf24a3563773c9f8cd9339c3eebda16a97f1eefb',
  scheduleCancel: '0x7930bcd89738213b6107bad5510be101a56ae9fdc175cf37541a292a07bdcb28',
  claimRewards: '0xe5dd3ee7c9169b16d0aba036fe579c2343e78e00dfc7998c34ee8e8c5367898f',
  reserveRequestWeight: '0x393fb324b87205906d1f5c2b635883bbb343805db37b1489026f122276dc1943',
  updateLeverage: '0x4b05a40414451ca27c96a59e581fa3ff4b46ab2e6011579afe41f172a392a4e0',
  usdClassTransfer: '0xa29897a1d712b7cb1f216d19479efa2d8485eb5cefc8465b7bc3fb17a56a4826',
  approveAgent: '0x12e035c2f870f243c37723b1f34932c827870c3994a0854a893c13e6f0e2f6c2',
  approveBuilderFee: '0xc79bf7d0b97b00900bdcaf92c53b0bbc1607478da18553c66310fa2f8ce3814b',
  userSetAbstraction: '0x177ac3feda4abebccb63325f074596b2c58fa6bbdf2937b74d7920b02d5d5e21',
  withdraw3: '0x2380f0d99503ece911612b5bbd2b5541710b833b21c42b01866e9a7aeeae1a95',
  usdSend: '0xf7730e54714becea583264879760e131cf850fa997c0504f4d68748fd3787f3f',
  sendAsset: '0xb7d4118af1bde4e3adbbc432147f9ecc96765452c9762c8dc45b66b7bf2b3f8c',
};

const l1Cases: Array<[string, A.L1Action, (ex: SdkExchange) => Promise<unknown>]> = [
  [
    'order',
    A.orderAction([A.orderWire({ asset: 110029, isBuy: false, limitPx: '90.5', size: '0.24', reduceOnly: true, orderType: { limit: { tif: 'Ioc' } }, cloid: CLOID })], { b: BUILDER, f: 30 }),
    (ex) => ex.order({ orders: [{ a: 110029, b: false, p: '90.5', s: '0.24', r: true, t: { limit: { tif: 'Ioc' } }, c: CLOID }], grouping: 'na', builder: { b: BUILDER, f: 30 } }),
  ],
  [
    'trigger',
    A.orderAction([A.orderWire({ asset: 110029, isBuy: false, limitPx: '80', size: '0.24', reduceOnly: true, orderType: { trigger: { isMarket: true, triggerPx: '85', tpsl: 'sl' } } })]),
    (ex) => ex.order({ orders: [{ a: 110029, b: false, p: '80', s: '0.24', r: true, t: { trigger: { isMarket: true, triggerPx: '85', tpsl: 'sl' } } }], grouping: 'na' }),
  ],
  ['cancel', A.cancelAction([{ asset: 110029, oid: 123 }]), (ex) => ex.cancel({ cancels: [{ a: 110029, o: 123 }] })],
  ['cancelByCloid', A.cancelByCloidAction([{ asset: 110029, cloid: CLOID }]), (ex) => ex.cancelByCloid({ cancels: [{ asset: 110029, cloid: CLOID }] })],
  ['updateIsolatedMargin', A.updateIsolatedMarginAction(110029, true, 2), (ex) => ex.updateIsolatedMargin({ asset: 110029, isBuy: true, ntli: 2_000_000 })],
  [
    'agentSendAsset',
    A.agentSendAssetAction({ destination: ME, sourceDex: '', destinationDex: 'xyz', token: USDC, amount: '5', nonce: NONCE }),
    (ex) => ex.agentSendAsset({ destination: ME, sourceDex: '', destinationDex: 'xyz', token: USDC, amount: '5', fromSubAccount: '' }),
  ],
  ['twapOrder', A.twapOrderAction({ asset: 110029, isBuy: false, size: '0.24', reduceOnly: true, minutes: 10, randomize: false }), (ex) => ex.twapOrder({ twap: { a: 110029, b: false, s: '0.24', r: true, m: 10, t: false } })],
  ['scheduleCancel', A.scheduleCancelAction(1791150600000), (ex) => ex.scheduleCancel({ time: 1791150600000 })],
  ['claimRewards', A.claimRewardsAction(), (ex) => ex.claimRewards()],
  ['reserveRequestWeight', A.reserveRequestWeightAction(100), (ex) => ex.reserveRequestWeight({ weight: 100 })],
  ['updateLeverage', A.updateLeverageAction(110029, false, 5), (ex) => ex.updateLeverage({ asset: 110029, isCross: false, leverage: 5 })],
];

describe('L1 actions match the SDK byte for byte', () => {
  it.each(l1Cases)('%s', async (name, action, sdk) => {
    const theirs = await sdkPayload(sdk);
    expect(JSON.stringify(action)).toBe(JSON.stringify(theirs.action));
    const mine = await l1(action);
    expect(mine).toEqual(theirs.signature);
    expect(mine.r).toBe(FROZEN[name]);
    // and the signature recovers to the signing key
    const typed = l1TypedData(l1ActionHash({ action, nonce: NONCE }), true);
    const recovered = await recoverTypedDataAddress({ ...(typed as object), signature: { r: mine.r as A.Hex, s: mine.s as A.Hex, v: BigInt(mine.v) } } as never);
    expect(recovered.toLowerCase()).toBe(ME);
  });
});

const userCases: Array<[string, A.UserSignedAction, (ex: SdkExchange) => Promise<unknown>]> = [
  [
    'approveAgent',
    A.approveAgentAction({ chain: 'Mainnet', signatureChainId: CHAIN, agentAddress: `0x${'22'.repeat(20)}`, agentName: A.agentName('bulwark', 1806796800000), nonce: NONCE }),
    (ex) => ex.approveAgent({ agentAddress: `0x${'22'.repeat(20)}`, agentName: 'bulwark valid_until 1806796800000' }),
  ],
  ['approveBuilderFee', A.approveBuilderFeeAction({ chain: 'Mainnet', signatureChainId: CHAIN, maxFeeRate: '0.05%', builder: BUILDER, nonce: NONCE }), (ex) => ex.approveBuilderFee({ maxFeeRate: '0.05%', builder: BUILDER })],
  ['userSetAbstraction', A.userSetAbstractionAction({ chain: 'Mainnet', signatureChainId: CHAIN, user: ME, abstraction: 'unifiedAccount', nonce: NONCE }), (ex) => ex.userSetAbstraction({ user: ME, abstraction: 'unifiedAccount' })],
  ['withdraw3', A.withdraw3Action({ chain: 'Mainnet', signatureChainId: CHAIN, destination: ME, amount: '10', time: NONCE }), (ex) => ex.withdraw3({ destination: ME, amount: '10' })],
  ['usdSend', A.usdSendAction({ chain: 'Mainnet', signatureChainId: CHAIN, destination: `0x${'33'.repeat(20)}`, amount: '1', time: NONCE }), (ex) => ex.usdSend({ destination: `0x${'33'.repeat(20)}`, amount: '1' })],
  [
    'sendAsset',
    A.sendAssetAction({ chain: 'Mainnet', signatureChainId: CHAIN, destination: ME, sourceDex: '', destinationDex: 'xyz', token: USDC, amount: '5', nonce: NONCE }),
    (ex) => ex.sendAsset({ destination: ME, sourceDex: '', destinationDex: 'xyz', token: USDC, amount: '5', fromSubAccount: '' }),
  ],
  ['usdClassTransfer', A.usdClassTransferAction({ chain: 'Mainnet', signatureChainId: CHAIN, amount: '2', toPerp: false, nonce: NONCE }), (ex) => ex.usdClassTransfer({ amount: '2', toPerp: false })],
];

describe('user-signed actions match the SDK byte for byte', () => {
  it.each(userCases)('%s', async (name, action, sdk) => {
    const theirs = await sdkPayload(sdk);
    expect(JSON.stringify(action)).toBe(JSON.stringify(theirs.action));
    const mine = await ours(userSignedTypedData(action));
    expect(mine).toEqual(theirs.signature);
    expect(mine.r).toBe(FROZEN[name]);
  });
});

describe('builders', () => {
  it('rejects agent names over 16 characters', () => expect(() => A.agentName('a'.repeat(17))).toThrow());
  it('lowercases addresses the exchange hashes', () => {
    expect(A.orderAction([], { b: '0xABCDEF0000000000000000000000000000000000', f: 1 }).builder?.b).toBe('0xabcdef0000000000000000000000000000000000');
  });
  it('signs testnet actions with source "b"', () => {
    expect((l1TypedData('0x00', false).message as { source: string }).source).toBe('b');
  });
});
