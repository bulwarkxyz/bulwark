import { COMMAND_TYPES, POLICY_CONFIRMATION_TYPES, policyConfirmationDomain, policyHash, type Policy } from '@bulwarkxyz/guard-core';
import { MemoryStore } from '@bulwarkxyz/store';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const user = privateKeyToAccount(`0x${'77'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'78'.repeat(32)}`);
const ACCOUNT = user.address.toLowerCase() as `0x${string}`;
const DOMAIN = 'bulwark.0xo.in';
const PROXY = 'proxy-secret';
let now = 1_791_150_000_000;
let store: MemoryStore;
let app: ReturnType<typeof createApp>;

const info = {
  extraAgents: async () => [],
  maxBuilderFee: async () => 0,
  userAbstraction: async () => 'default',
  clearinghouseState: async () => ({ marginSummary: { accountValue: '50', totalNtlPos: '0', totalRawUsd: '50', totalMarginUsed: '0' }, crossMarginSummary: { accountValue: '50', totalNtlPos: '0', totalRawUsd: '50', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0', withdrawable: '50', assetPositions: [], time: 0 }),
  spotClearinghouseState: async () => ({ balances: [] }),
  perpDexs: async () => [null],
  allPerpMetas: async () => [{ universe: [], collateralToken: 0 }],
} as never;

beforeEach(() => {
  store = new MemoryStore();
  app = createApp({ store, info, jwtSecret: new TextEncoder().encode('test-secret-test-secret-test-secret'), proxySecret: PROXY, siweDomain: DOMAIN, now: () => now });
});

async function signIn(account = user): Promise<string> {
  const { nonce } = (await (await app.request('/auth/nonce', { method: 'POST', body: JSON.stringify({ address: account.address }) })).json()) as { nonce: string };
  const message = createSiweMessage({ address: account.address, chainId: 42161, domain: DOMAIN, nonce, uri: `https://${DOMAIN}`, version: '1', issuedAt: new Date(now) });
  const signature = await account.signMessage({ message });
  const res = await app.request('/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature }) });
  return ((await res.json()) as { token: string }).token;
}

const authed = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra });
const fromProxy = (country: string, subdivision?: string) => ({ 'x-bulwark-proxy-secret': PROXY, 'x-bulwark-country': country, ...(subdivision ? { 'x-bulwark-subdivision': subdivision } : {}) });

describe('sign in', () => {
  it('issues a session for a valid SIWE signature and refuses replays and other domains', async () => {
    const token = await signIn();
    expect(token).toMatch(/^ey/);
    expect((await app.request('/v1/me', { headers: authed(token) })).status).toBe(200);
    expect((await app.request('/v1/me')).status).toBe(401);
    const message = createSiweMessage({ address: user.address, chainId: 1, domain: 'evil.example', nonce: 'abcdefgh1234', uri: 'https://evil.example', version: '1' });
    const res = await app.request('/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature: await user.signMessage({ message }) }) });
    expect(res.status).toBe(401);
  });
});

describe('region gate', () => {
  it('blocks by IP, residency or citizenship, and only trusts location from the proxy', async () => {
    const token = await signIn();
    const attest = (headers: Record<string, string>, residency = 'IN', citizenship = 'IN') =>
      app.request('/v1/onboarding/attest', { method: 'POST', headers: authed(token, headers), body: JSON.stringify({ residency, citizenship }) });
    expect((await attest(fromProxy('US'))).status).toBe(403);
    expect((await attest(fromProxy('UA', '43'))).status).toBe(403);
    expect((await attest(fromProxy('IN'), 'IN', 'US')).status).toBe(403); // citizenship counts
    expect((await attest({ 'x-bulwark-country': 'IN' })).status).toBe(403); // header without the proxy secret: unknown location
    const eu = await attest(fromProxy('DE'), 'DE', 'DE');
    expect(await eu.json()).toMatchObject({ verdict: 'guardOff' });
    const ok = await attest(fromProxy('IN'));
    expect(await ok.json()).toMatchObject({ verdict: 'allowed', guard: 'on' });
    expect((await store.user(ACCOUNT))?.region).toBe('allowed');
  });

  it('provisions a guard key only when KMS is configured', async () => {
    const token = await signIn();
    await app.request('/v1/onboarding/attest', { method: 'POST', headers: authed(token, fromProxy('IN')), body: JSON.stringify({ residency: 'IN', citizenship: 'IN' }) });
    expect((await app.request('/v1/onboarding/agent', { method: 'POST', headers: authed(token) })).status).toBe(503);
    const withKms = createApp({ store, info, jwtSecret: new TextEncoder().encode('test-secret-test-secret-test-secret'), proxySecret: PROXY, siweDomain: DOMAIN, now: () => now, provisionAgent: async () => ({ keyId: 'key-1', address: '0x00000000000000000000000000000000000000aa' }) });
    const res = await withKms.request('/v1/onboarding/agent', { method: 'POST', headers: authed(token) });
    expect(await res.json()).toEqual({ agentAddress: '0x00000000000000000000000000000000000000aa' });
    expect((await store.user(ACCOUNT))?.agentKeyRef).toBe('kms:key-1');
  });
});

describe('policy confirmation', () => {
  const policy: Policy = { version: 1, account: ACCOUNT, rules: [{ id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }] }], execution: { maxSlippagePct: 1 } };
  const sign = (signer = user, p = policy) =>
    signer.signTypedData({ domain: policyConfirmationDomain(42161), types: POLICY_CONFIRMATION_TYPES, primaryType: 'BulwarkPolicy', message: { account: ACCOUNT, version: BigInt(p.version), policyHash: policyHash(p) } });

  it('stores a policy the user signed and logs it', async () => {
    const token = await signIn();
    const res = await app.request('/v1/policy', { method: 'POST', headers: authed(token), body: JSON.stringify({ policy, signature: await sign(), chainId: 42161 }) });
    expect(res.status).toBe(200);
    expect((await store.policy(ACCOUNT))?.hash).toBe(policyHash(policy));
    expect(store.audit.raw(ACCOUNT).at(-1)).toMatchObject({ kind: 'rule_confirmed' });
  });

  it('refuses a signature from someone else, a stale version and another account’s policy', async () => {
    const token = await signIn();
    expect((await app.request('/v1/policy', { method: 'POST', headers: authed(token), body: JSON.stringify({ policy, signature: await sign(stranger), chainId: 42161 }) })).status).toBe(401);
    expect((await app.request('/v1/policy', { method: 'POST', headers: authed(token), body: JSON.stringify({ policy: { ...policy, version: 3 }, signature: await sign(user, { ...policy, version: 3 }), chainId: 42161 }) })).status).toBe(409);
    const theirs = { ...policy, account: stranger.address.toLowerCase() };
    expect((await app.request('/v1/policy', { method: 'POST', headers: authed(token), body: JSON.stringify({ policy: theirs, signature: await sign(user, theirs), chainId: 42161 }) })).status).toBe(403);
  });
});

describe('commands', () => {
  const sign = (command: string, minutes: number, issuedAt: number) =>
    user.signTypedData({ domain: policyConfirmationDomain(42161), types: COMMAND_TYPES, primaryType: 'BulwarkCommand', message: { account: ACCOUNT, command, minutes, issuedAt: BigInt(issuedAt) } });

  it('kill switch takes effect at once and is queued for the worker; resume turns it off', async () => {
    const token = await signIn();
    await app.request('/v1/onboarding/attest', { method: 'POST', headers: authed(token, fromProxy('IN')), body: JSON.stringify({ residency: 'IN', citizenship: 'IN' }) });
    const stop = await app.request('/v1/commands', { method: 'POST', headers: authed(token), body: JSON.stringify({ command: 'stop', issuedAt: now, signature: await sign('stop', 0, now), chainId: 42161 }) });
    expect(stop.status).toBe(200);
    expect((await store.user(ACCOUNT))?.killSwitch).toBe(true);
    expect((await store.pendingCommands()).map((c) => c.command)).toEqual(['stop']);
    await app.request('/v1/commands', { method: 'POST', headers: authed(token), body: JSON.stringify({ command: 'resume', issuedAt: now, signature: await sign('resume', 0, now), chainId: 42161 }) });
    expect((await store.user(ACCOUNT))?.killSwitch).toBe(false);
  });

  it('refuses stale commands and unwind times outside 5 minutes to 7 days', async () => {
    const token = await signIn();
    const old = now - 120_000;
    expect((await app.request('/v1/commands', { method: 'POST', headers: authed(token), body: JSON.stringify({ command: 'stop', issuedAt: old, signature: await sign('stop', 0, old), chainId: 42161 }) })).status).toBe(400);
    expect((await app.request('/v1/commands', { method: 'POST', headers: authed(token), body: JSON.stringify({ command: 'unwind', minutes: 2, issuedAt: now, signature: await sign('unwind', 2, now), chainId: 42161 }) })).status).toBe(400);
  });
});

describe('telegram', () => {
  it('creates a one-time link code for an onboarded user', async () => {
    const token = await signIn();
    expect((await app.request('/v1/telegram/code', { method: 'POST', headers: authed(token) })).status).toBe(409);
    await app.request('/v1/onboarding/attest', { method: 'POST', headers: authed(token, fromProxy('IN')), body: JSON.stringify({ residency: 'IN', citizenship: 'IN' }) });
    const { code } = (await (await app.request('/v1/telegram/code', { method: 'POST', headers: authed(token) })).json()) as { code: string };
    expect(code).toMatch(/^[A-Z0-9]{7}$/);
    expect(await store.redeemTelegramCode(code, '9', now)).toBe(ACCOUNT);
  });
});
