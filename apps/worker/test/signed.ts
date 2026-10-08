// Test wallets and policies signed exactly as the app signs them (EIP-712, naming the network), so the worker's own
// signature check (security review F3, F5) runs in every engine test.
import { POLICY_CONFIRMATION_TYPES, policyConfirmationDomain, policyHash, type Policy } from '@bulwarkxyz/guard-core';
import type { ConfirmedPolicy } from '@bulwarkxyz/store';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

export const TEST_WALLET = privateKeyToAccount(`0x${'21'.repeat(32)}`);
export const OTHER_WALLET = privateKeyToAccount(`0x${'22'.repeat(32)}`);
export const addr = (w: PrivateKeyAccount) => w.address.toLowerCase() as `0x${string}`;

export async function signed(policy: Policy, wallet: PrivateKeyAccount = TEST_WALLET, confirmedAt = 0, network: 'testnet' | 'mainnet' = 'testnet'): Promise<ConfirmedPolicy> {
  const hash = policyHash(policy);
  const signature = await wallet.signTypedData({ domain: policyConfirmationDomain(42161), types: POLICY_CONFIRMATION_TYPES, primaryType: 'BulwarkPolicy', message: { account: addr(wallet), network, version: BigInt(policy.version), policyHash: hash as `0x${string}` } });
  return { policy, hash, signature, signatureVerified: true, confirmedAt, chainId: 42161, signedNetwork: network };
}

/** A command signed as the app signs it, as the API stores it (signature, chain, network). */
export async function signedCommand(command: 'stop' | 'unwind' | 'resume' | 'wipe', minutes: number, issuedAt: number, wallet: PrivateKeyAccount = TEST_WALLET, network: 'testnet' | 'mainnet' = 'testnet') {
  const { COMMAND_TYPES } = await import('@bulwarkxyz/guard-core');
  const signature = await wallet.signTypedData({ domain: policyConfirmationDomain(42161), types: COMMAND_TYPES, primaryType: 'BulwarkCommand', message: { account: addr(wallet), network, command, minutes, issuedAt: BigInt(issuedAt) } });
  return { signature, chainId: 42161, network };
}
