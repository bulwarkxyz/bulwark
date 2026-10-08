import { COMMAND_TYPES, POLICY_CONFIRMATION_TYPES, policyConfirmationDomain, policyHash, type Policy } from '@bulwarkxyz/guard-core';
import { MemoryStore } from '@bulwarkxyz/store';
import { parseSignature, serializeCompactSignature, signatureToCompactSignature, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { isContractCode, isContractWalletSignature } from '../src/signatures.js';

/**
 * The app's wallet library may change how signatures are requested (injected, WalletConnect, hardware).
 * The API must accept the same signatures in every encoding an EOA wallet produces, and say plainly that
 * smart-contract wallets are not supported (a Hyperliquid account signs with an ordinary key).
 */
const user = privateKeyToAccount(`0x${'77'.repeat(32)}`);
const ACCOUNT = user.address.toLowerCase() as Hex;
const DOMAIN = 'bulwark.0xo.in';
const now = 1_791_150_000_000;
const info = { extraAgents: async () => [], maxBuilderFee: async () => 0 } as never;
const SAFE_CODE = '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e' as Hex;

let store: MemoryStore;
let codeAt: (a: Hex) => Promise<Hex>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  store = new MemoryStore();
  codeAt = async () => '0x';
  app = createApp({ store, info, jwtSecret: new TextEncoder().encode('test-secret-test-secret-test-secret'), proxySecret: 'p', siweDomain: DOMAIN, keyCustody: 'kms', network: 'testnet', now: () => now, codeAt: (a) => codeAt(a) });
});

/** WalletConnect wallets and hardware signers often return v as 0/1 (yParity) instead of 27/28. */
const withV01 = (sig: Hex): Hex => {
  const p = parseSignature(sig);
  return `${sig.slice(0, 130)}${(Number(p.yParity)).toString(16).padStart(2, '0')}` as Hex;
};
/** EIP-2098 compact form (64 bytes), which some signers return. */
const compact = (sig: Hex): Hex => serializeCompactSignature(signatureToCompactSignature(parseSignature(sig)));
/** ERC-6492: how a smart wallet that isn't deployed yet wraps its signature. */
const erc6492 = (inner: Hex): Hex => `${inner}${'00'.repeat(96)}${'6492'.repeat(16)}` as Hex;

async function siwe(chainId = 42161) {
  const { nonce } = (await (await app.request('/auth/nonce', { method: 'POST', body: JSON.stringify({ address: user.address }) })).json()) as { nonce: string };
  const message = createSiweMessage({ address: user.address, chainId, domain: DOMAIN, nonce, uri: `https://${DOMAIN}`, version: '1', issuedAt: new Date(now) });
  return { message, signature: await user.signMessage({ message }) };
}
const verify = (message: string, signature: Hex) => app.request('/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature }) });
const authed = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

describe('signatures from any EOA wallet connection', () => {
  it('sign-in accepts v as 27/28 or 0/1 and the compact form, and a message for another chain id', async () => {
    for (const [encode, chainId] of [[(s: Hex) => s, 42161], [withV01, 42161], [compact, 42161], [(s: Hex) => s, 1]] as const) {
      const { message, signature } = await siwe(chainId);
      const res = await verify(message, encode(signature));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { token: string }).token).toBeTruthy();
    }
  });

  it('a policy and a command signed on another chain (the wallet\'s current one), with v as 0/1, are accepted', async () => {
    const { message, signature } = await siwe();
    const token = ((await (await verify(message, signature)).json()) as { token: string }).token;
    const policy: Policy = { version: 1, account: ACCOUNT, rules: [{ id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }], repeat: { mode: 'oncePerBreach' } }], execution: { maxSlippagePct: 1 } };
    const sig = await user.signTypedData({ domain: policyConfirmationDomain(1), types: POLICY_CONFIRMATION_TYPES, primaryType: 'BulwarkPolicy', message: { network: 'testnet', account: user.address, version: 1n, policyHash: policyHash(policy) } });
    expect((await app.request('/v1/policy', { method: 'POST', headers: authed(token), body: JSON.stringify({ policy, signature: withV01(sig), chainId: 1 }) })).status).toBe(200);
    const cmd = await user.signTypedData({ domain: policyConfirmationDomain(8453), types: COMMAND_TYPES, primaryType: 'BulwarkCommand', message: { network: 'testnet', account: user.address, command: 'stop', minutes: 0, issuedAt: BigInt(now) } });
    store.putUser({ account: ACCOUNT, agentKeyRef: 'kms:k', region: 'allowed', telegramChatId: null, killSwitch: false, builderApproved: false });
    expect((await app.request('/v1/commands', { method: 'POST', headers: authed(token), body: JSON.stringify({ command: 'stop', issuedAt: now, signature: compact(cmd), chainId: 8453 }) })).status).toBe(200);
  });

  it('a signature for a different chain id than the one sent is refused', async () => {
    const { message, signature } = await siwe();
    const token = ((await (await verify(message, signature)).json()) as { token: string }).token;
    const policy: Policy = { version: 1, account: ACCOUNT, rules: [{ id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }], repeat: { mode: 'oncePerBreach' } }], execution: { maxSlippagePct: 1 } };
    const sig = await user.signTypedData({ domain: policyConfirmationDomain(1), types: POLICY_CONFIRMATION_TYPES, primaryType: 'BulwarkPolicy', message: { network: 'testnet', account: user.address, version: 1n, policyHash: policyHash(policy) } });
    expect((await app.request('/v1/policy', { method: 'POST', headers: authed(token), body: JSON.stringify({ policy, signature: sig, chainId: 42161 }) })).status).toBe(401);
  });
});

describe('smart-contract wallets: not supported, said plainly', () => {
  it('an ERC-6492 signature (undeployed smart wallet) gets a clear 400, not "bad signature"', async () => {
    const { message, signature } = await siwe();
    const res = await verify(message, erc6492(signature));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'contract_wallet', error: expect.stringMatching(/Smart-contract wallets are not supported/) });
  });

  it('a deployed contract wallet (code at the address, ERC-1271 style signature) gets the same answer; an EOA with a wrong signature still gets 401', async () => {
    const { message } = await siwe();
    const safeSig = `0x${'00'.repeat(64)}00` as Hex; // Safe's contract-signature marker (v = 0): not ECDSA
    codeAt = async () => SAFE_CODE;
    expect((await verify(message, safeSig)).status).toBe(400);
    const again = await siwe();
    codeAt = async () => '0x';
    expect((await verify(again.message, safeSig)).status).toBe(401);
  });

  it('an EIP-7702 delegated EOA is not a contract wallet', () => {
    expect(isContractCode('0xef01001234567890123456789012345678901234567890' as Hex)).toBe(false);
    expect(isContractCode(SAFE_CODE)).toBe(true);
    expect(isContractCode('0x')).toBe(false);
    expect(isContractWalletSignature(`0x${'11'.repeat(65)}` as Hex)).toBe(false);
    expect(isContractWalletSignature(`0x${'11'.repeat(64)}` as Hex)).toBe(false);
    expect(isContractWalletSignature(`0x${'11'.repeat(200)}` as Hex)).toBe(true);
  });
});
