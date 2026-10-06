'use client';

import { COMMAND_TYPES, POLICY_CONFIRMATION_TYPES, policyConfirmationDomain, policyHash, type CommandName, type Policy } from '@bulwarkxyz/guard-core';
import {
  ExchangeClient,
  agentName,
  approveAgentAction,
  approveBuilderFeeAction,
  userSetAbstractionAction,
  l1ActionHash,
  l1TypedData,
  userSignedTypedData,
  type ExchangeResult,
  type Hex,
  type L1Action,
  type UserSignedAction,
} from '@bulwarkxyz/hyperliquid';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { NETWORK } from './env';

export const exchange = new ExchangeClient(NETWORK);
const chain = NETWORK === 'mainnet' ? ('Mainnet' as const) : ('Testnet' as const);
const hexChain = (id: number) => `0x${id.toString(16)}` as Hex;

/** Wallet signer shape (wagmi's signTypedDataAsync). */
export type SignTypedData = (args: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }) => Promise<Hex>;

/**
 * r, s and v for Hyperliquid, from whatever the wallet returned: 65 bytes with v as 27/28 or 0/1 (some
 * hardware and mobile wallets), or the 64-byte compact form (EIP-2098). Anything else is a contract
 * wallet's signature, which Hyperliquid can't use.
 */
export function split(sig: Hex): { r: Hex; s: Hex; v: 27 | 28 } {
  const hex = sig.slice(2);
  if (hex.length === 128) {
    const vs = BigInt(`0x${hex.slice(64)}`);
    const yParity = Number(vs >> 255n);
    const s = (vs & ((1n << 255n) - 1n)).toString(16).padStart(64, '0');
    return { r: `0x${hex.slice(0, 64)}`, s: `0x${s}`, v: (27 + yParity) as 27 | 28 };
  }
  if (hex.length !== 130) throw new Error('This looks like a smart-contract wallet’s signature. Hyperliquid accounts need an ordinary wallet.');
  const v = Number.parseInt(hex.slice(128, 130), 16);
  return { r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}`, v: (v < 27 ? v + 27 : v) as 27 | 28 };
}

/** A user-signed Hyperliquid action, signed by the user's own wallet and sent to the exchange. */
export async function sendUserSigned(sign: SignTypedData, action: UserSignedAction): Promise<ExchangeResult> {
  const typed = userSignedTypedData(action) as unknown as Parameters<SignTypedData>[0];
  const sig = split(await sign(typed));
  const nonce = 'nonce' in action ? action.nonce : action.time;
  return exchange.send({ action, nonce, signature: sig });
}

export function approveAgentFor(walletChainId: number, agent: Hex, name: string, validUntilMs?: number) {
  return approveAgentAction({ chain, signatureChainId: hexChain(walletChainId), agentAddress: agent, agentName: agentName(name, validUntilMs), nonce: Date.now() });
}

export function approveBuilderFor(walletChainId: number, builder: Hex, maxFeeRate: string) {
  return approveBuilderFeeAction({ chain, signatureChainId: hexChain(walletChainId), maxFeeRate, builder, nonce: Date.now() });
}

/** Switch the account's mode on Hyperliquid (standard ↔ unified), signed by the user's own wallet. */
export function setAbstractionFor(walletChainId: number, user: Hex, abstraction: 'disabled' | 'unifiedAccount') {
  return userSetAbstractionAction({ chain, signatureChainId: hexChain(walletChainId), user, abstraction, nonce: Date.now() });
}

// ------------------------------------------------------------------ the browser trading key

const keyName = (account: string) => `bw.tradingKey.${NETWORK}.${account.toLowerCase()}`;

/**
 * The browser's own trading key for the user's manual orders (agent name "bulwark-web"). It is
 * created here, stays in this browser, and can only trade — Hyperliquid agents cannot withdraw.
 */
export function tradingKey(account: string, create = false): { address: Hex; key: Hex } | null {
  try {
    let key = localStorage.getItem(keyName(account)) as Hex | null;
    if (!key && create) {
      key = generatePrivateKey();
      localStorage.setItem(keyName(account), key);
    }
    return key ? { key, address: privateKeyToAccount(key).address.toLowerCase() as Hex } : null;
  } catch {
    return null;
  }
}

export function forgetTradingKey(account: string) {
  try {
    localStorage.removeItem(keyName(account));
  } catch {
    /* nothing stored */
  }
}

let lastNonce = 0;
/** Signs an L1 action with the browser trading key and sends it. */
export async function sendWithTradingKey(account: string, action: L1Action): Promise<ExchangeResult> {
  const k = tradingKey(account);
  if (!k) throw new Error('approve a trading key in Settings first');
  const nonce = (lastNonce = Math.max(Date.now(), lastNonce + 1));
  const acct = privateKeyToAccount(k.key);
  const typed = l1TypedData(l1ActionHash({ action, nonce }), NETWORK === 'mainnet');
  const sig = split(await acct.signTypedData(typed as never));
  return exchange.send({ action, nonce, signature: sig });
}

// ------------------------------------------------------------------ Bulwark confirmations

export async function signPolicy(sign: SignTypedData, walletChainId: number, policy: Policy): Promise<Hex> {
  return sign({
    domain: policyConfirmationDomain(walletChainId) as unknown as Record<string, unknown>,
    types: POLICY_CONFIRMATION_TYPES as unknown as Record<string, unknown>,
    primaryType: 'BulwarkPolicy',
    message: { account: policy.account, version: BigInt(policy.version), policyHash: policyHash(policy) },
  });
}

export async function signCommand(sign: SignTypedData, walletChainId: number, account: Hex, command: CommandName, minutes: number, issuedAt: number): Promise<Hex> {
  return sign({
    domain: policyConfirmationDomain(walletChainId) as unknown as Record<string, unknown>,
    types: COMMAND_TYPES as unknown as Record<string, unknown>,
    primaryType: 'BulwarkCommand',
    message: { account, command, minutes, issuedAt: BigInt(issuedAt) },
  });
}
