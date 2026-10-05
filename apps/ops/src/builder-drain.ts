/**
 * B2 check (testnet): what a user sees when the builder falls below 100 USDC perps value AFTER the user
 * approved it. Precondition: testnet-actions has run (approval exists, builder funded).
 *   pnpm --filter @bulwarkxyz/ops testnet:builder-drain
 * Steps: order with builder (expect ok) → builder moves perps USDC to spot until < 100 → order with
 * builder (observe) → maxBuilderFee still set? → restore the builder → order again.
 */
import { BUILDER_ADDRESS, BUILDER_FEE_TENTHS_BPS } from '@bulwarkxyz/config';
import { buildAssetIndex, roundPrice, toWire, type RawPerpDexs, type RawPerpMeta } from '@bulwarkxyz/guard-core';
import { orderAction, orderWire, usdClassTransferAction } from '@bulwarkxyz/hyperliquid';
import { SCRIPT_CHAIN_ID, Session, WALLETS, keychainSigner, perpUsdc } from './lib.js';

const s = new Session('testnet');

async function main() {
  const A = keychainSigner(WALLETS.standard);
  const builder = keychainSigner(WALLETS.builder);
  const agent = keychainSigner(WALLETS.testnetAgent);
  const assets = buildAssetIndex((await s.info.perpDexs()) as RawPerpDexs, (await s.info.allPerpMetas()) as RawPerpMeta[]);
  const btc = assets.get('BTC')!;
  const order = async (label: string, isBuy: boolean) => {
    const m = Number((await s.info.allMids())['BTC']);
    const size = toWire(Math.ceil((15 / m) * 10 ** btc.szDecimals) / 10 ** btc.szDecimals);
    const px = toWire(roundPrice(isBuy ? m * 1.01 : m * 0.99, btc.szDecimals, isBuy ? 'up' : 'down'));
    return s.l1(agent, orderAction([orderWire({ asset: btc.assetId, isBuy, limitPx: px, size, reduceOnly: false, orderType: { limit: { tif: 'Ioc' } } })], { b: BUILDER_ADDRESS, f: BUILDER_FEE_TENTHS_BPS }), label);
  };

  s.note('builder perps USDC (start)', await perpUsdc(s.info, builder.address));
  s.note('A maxBuilderFee (start)', await s.info.maxBuilderFee(A.address, BUILDER_ADDRESS));
  await order('1. order with builder while builder ≥ 100', true);

  const have = await perpUsdc(s.info, builder.address);
  const drain = Math.max(0, have - 99);
  await s.user(builder, usdClassTransferAction({ chain: s.chain, signatureChainId: SCRIPT_CHAIN_ID, amount: toWire(drain, 2), toPerp: false, nonce: s.nonces.next(builder.address) }), `2. builder moves ${drain.toFixed(2)} USDC perps → spot`);
  s.note('builder perps USDC (drained)', await perpUsdc(s.info, builder.address));

  const res = await order('3. order with builder while builder < 100', false);
  s.note('3. what the user sees', { ok: res.ok, error: res.error ?? null, statuses: res.statuses });
  s.note('A maxBuilderFee (after drain)', await s.info.maxBuilderFee(A.address, BUILDER_ADDRESS));
  s.note('A latest fill builderFee', ((await s.info.request({ type: 'userFills', user: A.address })) as Array<Record<string, unknown>>).slice(0, 2).map((f) => ({ side: f.side, sz: f.sz, fee: f.fee, builderFee: f.builderFee ?? null })));

  await s.user(builder, usdClassTransferAction({ chain: s.chain, signatureChainId: SCRIPT_CHAIN_ID, amount: toWire(drain, 2), toPerp: true, nonce: s.nonces.next(builder.address) }), '4. restore builder perps balance');
  await order('5. order with builder after restore', true);

  console.log(`evidence: ${s.save('builder-drain')}`);
}

main().catch((e) => {
  console.error(e);
  console.log(`evidence: ${s.save('builder-drain-error')}`);
  process.exitCode = 1;
});
