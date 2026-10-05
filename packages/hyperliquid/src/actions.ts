/**
 * Hyperliquid exchange actions, built with the exact key order the exchange hashes (msgpack is
 * order-sensitive). Key orders match @nktkas/hyperliquid 0.33.3 and are pinned by signature-parity tests.
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
 */

export type Hex = `0x${string}`;

// ---------- L1 actions (signed by the agent key) ----------

export type OrderType = { limit: { tif: 'Gtc' | 'Ioc' | 'Alo' } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: 'tp' | 'sl' } };

export interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: OrderType;
  c?: Hex;
}

export interface BuilderWire {
  b: Hex;
  f: number;
}

export function orderWire(o: { asset: number; isBuy: boolean; limitPx: string; size: string; reduceOnly: boolean; orderType: OrderType; cloid?: Hex }): OrderWire {
  const t: OrderType =
    'limit' in o.orderType
      ? { limit: { tif: o.orderType.limit.tif } }
      : { trigger: { isMarket: o.orderType.trigger.isMarket, triggerPx: o.orderType.trigger.triggerPx, tpsl: o.orderType.trigger.tpsl } };
  const w: OrderWire = { a: o.asset, b: o.isBuy, p: o.limitPx, s: o.size, r: o.reduceOnly, t };
  if (o.cloid) w.c = o.cloid;
  return w;
}

export interface OrderAction {
  type: 'order';
  orders: OrderWire[];
  grouping: 'na' | 'normalTpsl' | 'positionTpsl';
  builder?: BuilderWire;
}

export function orderAction(orders: OrderWire[], builder?: BuilderWire | null, grouping: OrderAction['grouping'] = 'na'): OrderAction {
  const a: OrderAction = { type: 'order', orders, grouping };
  if (builder) a.builder = { b: builder.b.toLowerCase() as Hex, f: builder.f };
  return a;
}

export interface CancelAction {
  type: 'cancel';
  cancels: Array<{ a: number; o: number }>;
}
export const cancelAction = (cancels: Array<{ asset: number; oid: number }>): CancelAction => ({ type: 'cancel', cancels: cancels.map((c) => ({ a: c.asset, o: c.oid })) });

export interface CancelByCloidAction {
  type: 'cancelByCloid';
  cancels: Array<{ asset: number; cloid: Hex }>;
}
export const cancelByCloidAction = (cancels: Array<{ asset: number; cloid: Hex }>): CancelByCloidAction => ({
  type: 'cancelByCloid',
  cancels: cancels.map((c) => ({ asset: c.asset, cloid: c.cloid })),
});

/** `ntli` is the USDC amount × 1e6 as an integer. */
export interface UpdateIsolatedMarginAction {
  type: 'updateIsolatedMargin';
  asset: number;
  isBuy: boolean;
  ntli: number;
}
export const updateIsolatedMarginAction = (asset: number, isBuy: boolean, usdc: number): UpdateIsolatedMarginAction => ({
  type: 'updateIsolatedMargin',
  asset,
  isBuy,
  ntli: Math.round(usdc * 1e6),
});

/** Moves the collateral token between the user's own balances. "Destination must match the source address." */
export interface AgentSendAssetAction {
  type: 'agentSendAsset';
  destination: Hex;
  sourceDex: string;
  destinationDex: string;
  token: string;
  amount: string;
  fromSubAccount: string;
  nonce: number;
}
export function agentSendAssetAction(a: { destination: Hex; sourceDex: string; destinationDex: string; token: string; amount: string; nonce: number; fromSubAccount?: string }): AgentSendAssetAction {
  return {
    type: 'agentSendAsset',
    destination: a.destination.toLowerCase() as Hex,
    sourceDex: a.sourceDex,
    destinationDex: a.destinationDex,
    token: a.token,
    amount: a.amount,
    fromSubAccount: a.fromSubAccount ?? '',
    nonce: a.nonce,
  };
}

export interface TwapOrderAction {
  type: 'twapOrder';
  twap: { a: number; b: boolean; s: string; r: boolean; m: number; t: boolean };
}
export const twapOrderAction = (t: { asset: number; isBuy: boolean; size: string; reduceOnly: boolean; minutes: number; randomize: boolean }): TwapOrderAction => ({
  type: 'twapOrder',
  twap: { a: t.asset, b: t.isBuy, s: t.size, r: t.reduceOnly, m: t.minutes, t: t.randomize },
});

export interface ScheduleCancelAction {
  type: 'scheduleCancel';
  time?: number;
}
export const scheduleCancelAction = (time?: number): ScheduleCancelAction => (time === undefined ? { type: 'scheduleCancel' } : { type: 'scheduleCancel', time });

export interface ReserveRequestWeightAction {
  type: 'reserveRequestWeight';
  weight: number;
}
export const reserveRequestWeightAction = (weight: number): ReserveRequestWeightAction => ({ type: 'reserveRequestWeight', weight });

/** Not signable by the guarded signer (I2); used by the user's own trading and test setup. */
export interface UpdateLeverageAction {
  type: 'updateLeverage';
  asset: number;
  isCross: boolean;
  leverage: number;
}
export const updateLeverageAction = (asset: number, isCross: boolean, leverage: number): UpdateLeverageAction => ({ type: 'updateLeverage', asset, isCross, leverage });

export interface ClaimRewardsAction {
  type: 'claimRewards';
}
export const claimRewardsAction = (): ClaimRewardsAction => ({ type: 'claimRewards' });

export type L1Action =
  | OrderAction
  | CancelAction
  | CancelByCloidAction
  | UpdateIsolatedMarginAction
  | AgentSendAssetAction
  | TwapOrderAction
  | ScheduleCancelAction
  | ReserveRequestWeightAction
  | UpdateLeverageAction
  | ClaimRewardsAction;

// ---------- User-signed actions (signed by the user's own wallet) ----------

export type HyperliquidChain = 'Mainnet' | 'Testnet';

interface UserSignedBase {
  signatureChainId: Hex;
  hyperliquidChain: HyperliquidChain;
}

export interface ApproveAgentAction extends UserSignedBase {
  type: 'approveAgent';
  agentAddress: Hex;
  agentName: string;
  nonce: number;
}
export interface ApproveBuilderFeeAction extends UserSignedBase {
  type: 'approveBuilderFee';
  maxFeeRate: string;
  builder: Hex;
  nonce: number;
}
export interface UserSetAbstractionAction extends UserSignedBase {
  type: 'userSetAbstraction';
  user: Hex;
  abstraction: 'disabled' | 'unifiedAccount' | 'portfolioMargin';
  nonce: number;
}
export interface Withdraw3Action extends UserSignedBase {
  type: 'withdraw3';
  destination: Hex;
  amount: string;
  time: number;
}
export interface UsdSendAction extends UserSignedBase {
  type: 'usdSend';
  destination: Hex;
  amount: string;
  time: number;
}
export interface SendAssetAction extends UserSignedBase {
  type: 'sendAsset';
  destination: Hex;
  sourceDex: string;
  destinationDex: string;
  token: string;
  amount: string;
  fromSubAccount: string;
  nonce: number;
}

export interface UsdClassTransferAction extends UserSignedBase {
  type: 'usdClassTransfer';
  amount: string;
  toPerp: boolean;
  nonce: number;
}

export type UserSignedAction = ApproveAgentAction | ApproveBuilderFeeAction | UserSetAbstractionAction | Withdraw3Action | UsdSendAction | SendAssetAction | UsdClassTransferAction;

const base = (chain: HyperliquidChain, signatureChainId: Hex) => ({ signatureChainId, hyperliquidChain: chain });

/** Agent name with expiry: "<name> valid_until <unixMs>"; the name itself is at most 16 characters. */
export function agentName(name: string, validUntilMs?: number): string {
  if (name.length > 16) throw new Error('agent name longer than 16 characters');
  return validUntilMs === undefined ? name : `${name} valid_until ${validUntilMs}`;
}

export const approveAgentAction = (a: { chain: HyperliquidChain; signatureChainId: Hex; agentAddress: Hex; agentName: string; nonce: number }): ApproveAgentAction => ({
  type: 'approveAgent',
  ...base(a.chain, a.signatureChainId),
  agentAddress: a.agentAddress.toLowerCase() as Hex,
  agentName: a.agentName,
  nonce: a.nonce,
});

export const approveBuilderFeeAction = (a: { chain: HyperliquidChain; signatureChainId: Hex; maxFeeRate: string; builder: Hex; nonce: number }): ApproveBuilderFeeAction => ({
  type: 'approveBuilderFee',
  ...base(a.chain, a.signatureChainId),
  maxFeeRate: a.maxFeeRate,
  builder: a.builder.toLowerCase() as Hex,
  nonce: a.nonce,
});

export const userSetAbstractionAction = (a: { chain: HyperliquidChain; signatureChainId: Hex; user: Hex; abstraction: UserSetAbstractionAction['abstraction']; nonce: number }): UserSetAbstractionAction => ({
  type: 'userSetAbstraction',
  ...base(a.chain, a.signatureChainId),
  user: a.user.toLowerCase() as Hex,
  abstraction: a.abstraction,
  nonce: a.nonce,
});

export const withdraw3Action = (a: { chain: HyperliquidChain; signatureChainId: Hex; destination: Hex; amount: string; time: number }): Withdraw3Action => ({
  type: 'withdraw3',
  ...base(a.chain, a.signatureChainId),
  destination: a.destination.toLowerCase() as Hex,
  amount: a.amount,
  time: a.time,
});

export const usdSendAction = (a: { chain: HyperliquidChain; signatureChainId: Hex; destination: Hex; amount: string; time: number }): UsdSendAction => ({
  type: 'usdSend',
  ...base(a.chain, a.signatureChainId),
  destination: a.destination.toLowerCase() as Hex,
  amount: a.amount,
  time: a.time,
});

export const sendAssetAction = (a: { chain: HyperliquidChain; signatureChainId: Hex; destination: Hex; sourceDex: string; destinationDex: string; token: string; amount: string; nonce: number; fromSubAccount?: string }): SendAssetAction => ({
  type: 'sendAsset',
  ...base(a.chain, a.signatureChainId),
  destination: a.destination.toLowerCase() as Hex,
  sourceDex: a.sourceDex,
  destinationDex: a.destinationDex,
  token: a.token,
  amount: a.amount,
  fromSubAccount: a.fromSubAccount ?? '',
  nonce: a.nonce,
});

export const usdClassTransferAction = (a: { chain: HyperliquidChain; signatureChainId: Hex; amount: string; toPerp: boolean; nonce: number }): UsdClassTransferAction => ({
  type: 'usdClassTransfer',
  ...base(a.chain, a.signatureChainId),
  amount: a.amount,
  toPerp: a.toPerp,
  nonce: a.nonce,
});

/** EIP-712 field lists for user-signed actions (domain "HyperliquidSignTransaction"). */
export const USER_SIGNED_TYPES = {
  approveAgent: {
    'HyperliquidTransaction:ApproveAgent': [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'agentAddress', type: 'address' },
      { name: 'agentName', type: 'string' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
  approveBuilderFee: {
    'HyperliquidTransaction:ApproveBuilderFee': [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'maxFeeRate', type: 'string' },
      { name: 'builder', type: 'address' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
  userSetAbstraction: {
    'HyperliquidTransaction:UserSetAbstraction': [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'user', type: 'address' },
      { name: 'abstraction', type: 'string' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
  withdraw3: {
    'HyperliquidTransaction:Withdraw': [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'destination', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'time', type: 'uint64' },
    ],
  },
  usdSend: {
    'HyperliquidTransaction:UsdSend': [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'destination', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'time', type: 'uint64' },
    ],
  },
  usdClassTransfer: {
    'HyperliquidTransaction:UsdClassTransfer': [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'toPerp', type: 'bool' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
  sendAsset: {
    'HyperliquidTransaction:SendAsset': [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'destination', type: 'string' },
      { name: 'sourceDex', type: 'string' },
      { name: 'destinationDex', type: 'string' },
      { name: 'token', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'fromSubAccount', type: 'string' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
} as const;
