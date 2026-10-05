import type { AccountSnapshot, AssetIndex, GuardAction } from '@bulwarkxyz/guard-core';
import { toWire as num } from '@bulwarkxyz/guard-core';
import {
  USDC_TOKEN,
  agentSendAssetAction,
  cancelAction,
  orderAction,
  orderWire,
  updateIsolatedMarginAction,
  type BuilderWire,
  type Hex,
  type L1Action,
  type Network,
} from '@bulwarkxyz/hyperliquid';

export interface WireParams {
  network: Network;
  /** The user's master account; the only destination funds may move to. */
  account: Hex;
  nonce: number;
  cloid?: Hex;
  builder?: BuilderWire | null;
  assets: AssetIndex;
  snapshot: AccountSnapshot;
}

/**
 * Deterministic GuardAction → exchange action. The guarded signer rebuilds the wire action with this
 * same function and refuses to sign if what it was handed differs.
 */
export function toWireAction(action: GuardAction, p: WireParams): L1Action {
  switch (action.type) {
    case 'order':
      return orderAction(
        [orderWire({ asset: action.assetId, isBuy: action.isBuy, limitPx: num(action.limitPx), size: num(action.size), reduceOnly: true, orderType: { limit: { tif: 'Ioc' } }, ...(p.cloid ? { cloid: p.cloid } : {}) })],
        p.builder ?? null,
      );
    case 'trigger':
      return orderAction(
        [
          orderWire({
            asset: action.assetId,
            isBuy: action.isBuy,
            limitPx: num(action.limitPx),
            size: num(action.size),
            reduceOnly: true,
            orderType: { trigger: { isMarket: true, triggerPx: num(action.triggerPx), tpsl: 'sl' } },
            ...(p.cloid ? { cloid: p.cloid } : {}),
          }),
        ],
        p.builder ?? null,
      );
    case 'cancel': {
      const asset = p.assets.get(action.coin);
      if (!asset) throw new Error(`unknown asset ${action.coin}`);
      return cancelAction([{ asset: asset.assetId, oid: action.oid }]);
    }
    case 'transfer': {
      if (action.token !== 0) throw new Error('only USDC transfers are supported');
      const sourceDex = action.source === 'spot' ? 'spot' : action.source.startsWith('dex:') ? action.source.slice(4) : null;
      if (sourceDex === null) throw new Error(`cannot transfer from ${action.source}`);
      return agentSendAssetAction({ destination: p.account, sourceDex, destinationDex: action.toDex, token: USDC_TOKEN[p.network], amount: num(action.amount, 6), nonce: p.nonce });
    }
    case 'isolatedMargin': {
      const pos = p.snapshot.positions.find((x) => x.dex === action.dex && x.coin === action.coin);
      if (!pos) throw new Error(`no position on ${action.coin}`);
      // isBuy is the position side (true for long), per the SDK schema.
      return updateIsolatedMarginAction(action.assetId, pos.size > 0, action.amount);
    }
    case 'alert':
      throw new Error('alerts are not exchange actions');
  }
}
