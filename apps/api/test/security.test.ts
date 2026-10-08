// The 8 Oct 2026 security review's fixes (F5–F8) and the mainnet prerequisites in the API. Each test fails on the code
// before the fix.
import { COMMAND_TYPES, POLICY_CONFIRMATION_TYPES, POLICY_CONFIRMATION_TYPES_LEGACY, policyConfirmationDomain, policyHash, type Policy } from '@bulwarkxyz/guard-core';
import { MemoryStore } from '@bulwarkxyz/store';
import { SignJWT } from 'jose';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { beforeEach, describe, expect, it } from 'vitest';
import { KEYS_PER_DAY, createApp } from '../src/app.js';

const user = privateKeyToAccount(`0x${'77'.repeat(32)}`);
const ACCOUNT = user.address.toLowerCase() as `0x${string}`;
const DOMAIN = 'bulwark.0xo.in';
const PROXY = 'proxy-secret';
const SECRET = new TextEncoder().encode('test-secret-test-secret-test-secret');
let now = 1_791_150_000_000;
let store: MemoryStore;
const info = { extraAgents: async () => [], maxBuilderFee: async () => 0 } as never;
const make = (extra: Record<string, unknown> = {}) => createApp({ store, info, jwtSecret: SECRET, proxySecret: PROXY, siweDomain: DOMAIN, keyCustody: 'kms' as const, network: 'testnet' as const, now: () => now, ...extra });
let app = make();
const authed = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra });
const fromProxy = (country: string) => ({ 'x-bulwark-proxy-secret': PROXY, 'x-bulwark-country': country });

beforeEach(() => {
  now = 1_791_150_000_000;
  store = new MemoryStore();
  app = make();
});
async function signIn(a = app, account = user): Promise<string> {
  const { nonce } = (await (await a.request('/auth/nonce', { method: 'POST', body: JSON.stringify({ address: account.address }) })).json()) as { nonce: string };
  const message = createSiweMessage({ address: account.address, chainId: 42161, domain: DOMAIN, nonce, uri: `https://${DOMAIN}`, version: '1', issuedAt: new Date(now) });
  const res = await a.request('/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature: await account.signMessage({ message }) }) });
  return ((await res.json()) as { token: string }).token;
}
const onboard = () => store.putUser({ account: ACCOUNT, agentKeyRef: 'kms:k', agentAddress: null, region: 'allowed', residency: 'IN', citizenship: 'IN', telegramChatId: null, killSwitch: false, builderApproved: false });
const command = (cmd: string, network = 'testnet', issuedAt = now) => user.signTypedData({ domain: policyConfirmationDomain(42161), types: COMMAND_TYPES, primaryType: 'BulwarkCommand', message: { account: ACCOUNT, network, command: cmd, minutes: 0, issuedAt: BigInt(issuedAt) } });

describe('F5: signatures and sessions name their network', () => {
  it('a policy signed without the network (the old shape) or for mainnet is refused; for testnet it is stored with its chain and network', async () => {
    const token = await signIn();
    onboard();
    const policy: Policy = { version: 1, account: ACCOUNT, rules: [{ id: 's1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }], repeat: { mode: 'everyCrossing' } }], execution: { maxSlippagePct: 1 } };
    const post = (signature: string) => app.request('/v1/policy', { method: 'POST', headers: authed(token), body: JSON.stringify({ policy, signature, chainId: 42161 }) });
    const legacy = await user.signTypedData({ domain: policyConfirmationDomain(42161), types: POLICY_CONFIRMATION_TYPES_LEGACY, primaryType: 'BulwarkPolicy', message: { account: ACCOUNT, version: 1n, policyHash: policyHash(policy) as `0x${string}` } });
    expect((await post(legacy)).status).toBe(401);
    const mainnet = await user.signTypedData({ domain: policyConfirmationDomain(42161), types: POLICY_CONFIRMATION_TYPES, primaryType: 'BulwarkPolicy', message: { account: ACCOUNT, network: 'mainnet', version: 1n, policyHash: policyHash(policy) as `0x${string}` } });
    expect((await post(mainnet)).status).toBe(401);
    const testnet = await user.signTypedData({ domain: policyConfirmationDomain(42161), types: POLICY_CONFIRMATION_TYPES, primaryType: 'BulwarkPolicy', message: { account: ACCOUNT, network: 'testnet', version: 1n, policyHash: policyHash(policy) as `0x${string}` } });
    expect((await post(testnet)).status).toBe(200);
    expect(await store.policy(ACCOUNT)).toMatchObject({ chainId: 42161, signedNetwork: 'testnet' });
  });

  it('existing policies signed before signatures named the network are reported as needing a re-sign, not migrated', async () => {
    const token = await signIn();
    onboard();
    const policy: Policy = { version: 1, account: ACCOUNT, rules: [{ id: 's1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }], repeat: { mode: 'everyCrossing' } }], execution: { maxSlippagePct: 1 } };
    store.putPolicy(ACCOUNT, { policy, hash: policyHash(policy), signature: '0x00', signatureVerified: true, confirmedAt: now });
    const me = (await (await app.request('/v1/me', { headers: authed(token) })).json()) as { policy: { needsResign: boolean } };
    expect(me.policy.needsResign).toBe(true);
  });

  it('a command signature is used once (no replay), resume is recorded too, and a mainnet-signed command is refused', async () => {
    const token = await signIn();
    onboard();
    const post = (body: Record<string, unknown>) => app.request('/v1/commands', { method: 'POST', headers: authed(token), body: JSON.stringify({ chainId: 42161, ...body }) });
    const sig = await command('stop');
    expect((await post({ command: 'stop', issuedAt: now, signature: sig })).status).toBe(200);
    expect((await post({ command: 'stop', issuedAt: now, signature: sig })).status).toBe(409);
    const resume = await command('resume');
    expect((await post({ command: 'resume', issuedAt: now, signature: resume })).status).toBe(200);
    expect((await post({ command: 'resume', issuedAt: now, signature: resume })).status).toBe(409); // before: a resume could be replayed for 60 s
    expect((await post({ command: 'stop', issuedAt: now, signature: await command('stop', 'mainnet') })).status).toBe(401);
  });

  it('a session minted for another network (or without one) is refused even with the same secret', async () => {
    const other = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(ACCOUNT).setAudience('bulwark:mainnet').setIssuedAt().setExpirationTime('1h').sign(SECRET);
    const none = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(ACCOUNT).setIssuedAt().setExpirationTime('1h').sign(SECRET);
    expect((await app.request('/v1/me', { headers: authed(other) })).status).toBe(401);
    expect((await app.request('/v1/me', { headers: authed(none) })).status).toBe(401);
    expect((await app.request('/v1/me', { headers: authed(await signIn()) })).status).toBe(200);
  });
});

describe('F6 and F7: guard keys', () => {
  it('two requests at once create one key (F7), and keys are capped per account and across all accounts (F6)', async () => {
    let created = 0;
    const kms = make({ provisionAgent: async () => (await new Promise((r) => setTimeout(r, 20)), { keyId: `k${++created}`, address: `0x${String(created).padStart(40, 'a')}` }) });
    const token = await signIn(kms);
    store.putUser({ account: ACCOUNT, agentKeyRef: 'pending', agentAddress: null, region: 'allowed', residency: 'IN', citizenship: 'IN', telegramChatId: null, killSwitch: false, builderApproved: false });
    const ask = () => kms.request('/v1/onboarding/agent', { method: 'POST', headers: authed(token) });
    const [a, b] = await Promise.all([ask(), ask()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(created).toBe(1); // before: 2, and the first key stayed active
    // The cap across all accounts: many fresh wallets each under their own cap still meet it.
    const capped = make({ provisionAgent: async () => ({ keyId: `k${++created}`, address: `0x${String(created).padStart(40, 'b')}` }), limits: { keysPerDay: 2 } });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const w = privateKeyToAccount(`0x${String(i + 10).padStart(64, '1')}`);
      const t = await signIn(capped, w);
      store.putUser({ account: w.address.toLowerCase() as `0x${string}`, agentKeyRef: 'pending', agentAddress: null, region: 'allowed', residency: 'IN', citizenship: 'IN', telegramChatId: null, killSwitch: false, builderApproved: false });
      statuses.push((await capped.request('/v1/onboarding/agent', { method: 'POST', headers: authed(t) })).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    const late = privateKeyToAccount(`0x${'13'.repeat(32)}`);
    const lateToken = await signIn(capped, late);
    store.putUser({ account: late.address.toLowerCase() as `0x${string}`, agentKeyRef: 'pending', agentAddress: null, region: 'allowed', residency: 'IN', citizenship: 'IN', telegramChatId: null, killSwitch: false, builderApproved: false });
    const last = await capped.request('/v1/onboarding/agent', { method: 'POST', headers: authed(lateToken) });
    expect(last.status).toBe(429);
    expect(Number(last.headers.get('retry-after'))).toBe(86_400);
    expect(await last.json()).toMatchObject({ limit: 'keys_all', retryAfter: 86_400 });
    expect(KEYS_PER_DAY).toBeGreaterThan(0);
  });
});

describe('F8: the whole audit chain can be read', () => {
  it('pages back with `before` past 500 entries', async () => {
    const token = await signIn();
    for (let i = 0; i < 620; i++) await store.audit.append({ account: ACCOUNT, at: now + i, kind: 'alert', why: 'w', what: `e${i}` });
    const first = (await (await app.request('/v1/audit?limit=500', { headers: authed(token) })).json()) as Array<{ seq: number }>;
    const rest = (await (await app.request(`/v1/audit?limit=500&before=${first.at(-1)!.seq}`, { headers: authed(token) })).json()) as Array<{ seq: number }>;
    expect(first.length + rest.length).toBe(620);
    expect(rest.at(-1)!.seq).toBe(1);
    expect((await app.request('/v1/audit?limit=abc', { headers: authed(token) })).status).toBe(200);
    expect((await app.request('/v1/audit?before=-3', { headers: authed(token) })).status).toBe(400);
  });
});

describe('regions at every step', () => {
  it('the region endpoint uses where the request comes from now, and the latest country is recorded for the guard', async () => {
    const token = await signIn();
    onboard();
    const here = (await (await app.request('/v1/region', { headers: authed(token, fromProxy('SG')) })).json()) as { verdict: string; trading: boolean };
    expect(here).toMatchObject({ verdict: 'allowed', trading: true });
    const fromUs = (await (await app.request('/v1/region', { headers: authed(token, fromProxy('US')) })).json()) as { verdict: string; trading: boolean };
    expect(fromUs).toMatchObject({ verdict: 'blocked', trading: false });
    await new Promise((r) => setTimeout(r, 5));
    expect((await store.user(ACCOUNT))?.lastCountry).toBe('US');
  });
});

describe('operator alerting', () => {
  it('/health/guard fails when the worker is dead or stale, and the operator is told once after two failed checks, then on recovery', async () => {
    const sent: string[] = [];
    const watched = make({ operatorAlert: async (t: string) => void sent.push(t) });
    expect((await watched.request('/health/guard')).status).toBe(503); // no heartbeat yet
    await store.setOperatorState('worker_heartbeat', { network: 'testnet', lastMarkAt: now, staleAccounts: 0, tracked: 3 }, now);
    expect((await watched.request('/health/guard')).status).toBe(200);
    now += 90_000; // the worker stopped writing
    expect(await (await watched.request('/health/guard')).json()).toMatchObject({ ok: false, problems: [expect.stringMatching(/heartbeat/), expect.stringMatching(/stale/)] });
    await watched.watchdog();
    expect(sent).toEqual([]);
    await watched.watchdog();
    await watched.watchdog();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/unhealthy/);
    await store.setOperatorState('worker_heartbeat', { network: 'testnet', lastMarkAt: now, staleAccounts: 0, tracked: 3 }, now);
    await watched.watchdog();
    expect(sent.at(-1)).toMatch(/healthy again/);
  });
});

describe('a closed signup list (mainnet prerequisites; unset on testnet)', () => {
  it('when set, only listed accounts get a session', async () => {
    const closed = make({ signupAllowlist: new Set([ACCOUNT]) });
    expect(await signIn(closed)).toBeTruthy();
    const stranger = privateKeyToAccount(`0x${'99'.repeat(32)}`);
    const { nonce } = (await (await closed.request('/auth/nonce', { method: 'POST', body: JSON.stringify({ address: stranger.address }) })).json()) as { nonce: string };
    const message = createSiweMessage({ address: stranger.address, chainId: 42161, domain: DOMAIN, nonce, uri: `https://${DOMAIN}`, version: '1', issuedAt: new Date(now) });
    const res = await closed.request('/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature: await stranger.signMessage({ message }) }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_invited' });
  });
});
