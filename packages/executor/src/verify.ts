import { COMMAND_TYPES, POLICY_CONFIRMATION_TYPES, policyConfirmationDomain, policyHash, type CommandName, type Policy, type SignedNetwork } from '@bulwarkxyz/guard-core';
import { recoverTypedDataAddress, type Hex } from 'viem';

/** A 64-byte (EIP-2098) signature as the 65-byte form viem recovers from. */
function normalize(sig: Hex): Hex {
  const h = sig.slice(2);
  if (h.length !== 128) return sig;
  const r = h.slice(0, 64);
  const vs = BigInt(`0x${h.slice(64)}`);
  const v = vs >> 255n ? 28 : 27;
  const s = (vs & ((1n << 255n) - 1n)).toString(16).padStart(64, '0');
  return `0x${r}${s}${v.toString(16)}` as Hex;
}
async function recovers(account: string, typed: Parameters<typeof recoverTypedDataAddress>[0]): Promise<boolean> {
  try {
    return (await recoverTypedDataAddress(typed)).toLowerCase() === account.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * True when `signature` is the account's own EIP-712 confirmation of this exact policy for this network (security
 * review F3 and F5). Recovered locally; never trusts a stored "verified" flag. Contract-wallet signatures fail here,
 * as the API refuses them too.
 */
export function verifyPolicySignature(a: { account: string; policy: Policy; signature: Hex; chainId: number; network: SignedNetwork }): Promise<boolean> {
  return recovers(a.account, {
    domain: policyConfirmationDomain(a.chainId),
    types: POLICY_CONFIRMATION_TYPES,
    primaryType: 'BulwarkPolicy',
    message: { account: a.account as Hex, network: a.network, version: BigInt(a.policy.version), policyHash: policyHash(a.policy) as Hex },
    signature: normalize(a.signature),
  } as never);
}

/** True when `signature` is the account's own EIP-712 signature of this command for this network. */
export function verifyCommandSignature(a: { account: string; command: CommandName; minutes: number; issuedAt: number; signature: Hex; chainId: number; network: SignedNetwork }): Promise<boolean> {
  return recovers(a.account, {
    domain: policyConfirmationDomain(a.chainId),
    types: COMMAND_TYPES,
    primaryType: 'BulwarkCommand',
    message: { account: a.account as Hex, network: a.network, command: a.command, minutes: a.minutes, issuedAt: BigInt(a.issuedAt) },
    signature: normalize(a.signature),
  } as never);
}
