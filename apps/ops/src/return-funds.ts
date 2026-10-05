/**
 * Returns what is left in a D6 test wallet to an address you choose, inside Hyperliquid (no gas, no
 * bridge). Dry run by default; add --execute to send.
 *
 *   pnpm --filter @bulwarkxyz/ops return-funds -- --wallet standard --to 0xYourAddress [--execute]
 *
 * Steps: cancel open orders → close positions (reduce-only IOC) → move USDC from every perp dex and spot
 * to the main perp balance → usdSend the main balance to --to. Unified accounts keep one USDC balance,
 * so only the final send applies. Mainnet only. Prints each step; never prints keys.
 */
import { buildAssetIndex, roundPrice, toWire, type RawPerpDexs, type RawPerpMeta } from '@bulwarkxyz/guard-core';
import { USDC_TOKEN, cancelAction, orderAction, orderWire, sendAssetAction, usdSendAction, type Hex } from '@bulwarkxyz/hyperliquid';
import { SCRIPT_CHAIN_ID, Session, WALLETS, keychainSigner, perpUsdc, spotUsdc } from './lib.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const execute = process.argv.includes('--execute');
const which = arg('wallet') as 'standard' | 'unified' | undefined;
const to = arg('to') as Hex | undefined;
if (!which || !(which in WALLETS) || !to || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
  console.error('usage: return-funds --wallet standard|unified --to 0xAddress [--execute]');
  process.exit(2);
}

const s = new Session('mainnet');

async function main() {
  const w = keychainSigner(WALLETS[which as 'standard' | 'unified']);
  const assets = buildAssetIndex((await s.info.perpDexs()) as RawPerpDexs, (await s.info.allPerpMetas()) as RawPerpMeta[]);
  const mode = await s.info.userAbstraction(w.address);
  console.log(`${which} wallet ${w.address} (${mode}) → ${to}${execute ? '' : '  [dry run]'}`);

  for (const dex of ['', 'xyz']) {
    const orders = (await s.info.frontendOpenOrders(w.address, dex)) as Array<{ coin: string; oid: number }>;
    const st = (await s.info.clearinghouseState(w.address, dex)) as { assetPositions: Array<{ position: { coin: string; szi: string } }> };
    for (const o of orders) {
      const a = assets.get(o.coin)!;
      console.log(`cancel ${o.coin} #${o.oid}`);
      if (execute) await s.l1(w, cancelAction([{ asset: a.assetId, oid: o.oid }]), `cancel ${o.coin}`);
    }
    for (const { position: p } of st.assetPositions) {
      const a = assets.get(p.coin)!;
      const size = Math.abs(Number(p.szi));
      const isBuy = Number(p.szi) < 0;
      const m = Number((await s.info.allMids(dex))[p.coin]);
      const px = toWire(roundPrice(isBuy ? m * 1.02 : m * 0.98, a.szDecimals, isBuy ? 'up' : 'down'));
      console.log(`close ${p.coin} ${p.szi} reduce-only IOC @ ${px}`);
      if (execute) await s.l1(w, orderAction([orderWire({ asset: a.assetId, isBuy, limitPx: px, size: toWire(size), reduceOnly: true, orderType: { limit: { tif: 'Ioc' } } })]), `close ${p.coin}`);
    }
  }

  if (mode !== 'unifiedAccount') {
    const xyz = await perpUsdc(s.info, w.address, 'xyz');
    if (xyz > 0.01) {
      console.log(`move ${xyz.toFixed(2)} USDC xyz → main`);
      if (execute) await s.user(w, sendAssetAction({ chain: s.chain, signatureChainId: SCRIPT_CHAIN_ID, destination: w.address, sourceDex: 'xyz', destinationDex: '', token: USDC_TOKEN.mainnet, amount: toWire(Math.floor(xyz * 100) / 100, 2), nonce: s.nonces.next(w.address) }), 'xyz → main');
    }
    const spot = await spotUsdc(s.info, w.address);
    if (spot > 0.01) {
      console.log(`move ${spot.toFixed(2)} USDC spot → main`);
      if (execute) await s.user(w, sendAssetAction({ chain: s.chain, signatureChainId: SCRIPT_CHAIN_ID, destination: w.address, sourceDex: 'spot', destinationDex: '', token: USDC_TOKEN.mainnet, amount: toWire(Math.floor(spot * 100) / 100, 2), nonce: s.nonces.next(w.address) }), 'spot → main');
    }
  }

  const main = mode === 'unifiedAccount' ? await spotUsdc(s.info, w.address) : await perpUsdc(s.info, w.address, '');
  const amount = Math.floor(main * 100) / 100;
  console.log(`send ${amount.toFixed(2)} USDC → ${to}`);
  if (execute && amount > 0) await s.user(w, usdSendAction({ chain: s.chain, signatureChainId: SCRIPT_CHAIN_ID, destination: to as Hex, amount: toWire(amount, 2), time: s.nonces.next(w.address) }), 'usdSend to owner');
  if (execute) console.log(`evidence: ${s.save(`return-funds-${which}`)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
