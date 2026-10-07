import { COMMAND_TYPES, POLICY_CONFIRMATION_TYPES, policyConfirmationDomain, policyHash, type Policy } from '@bulwarkxyz/guard-core';
import { MemoryStore } from '@bulwarkxyz/store';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { beforeEach, describe, expect, it } from 'vitest';
import { REPEAT_QUESTION, anthropicProvider } from '@bulwarkxyz/compiler';
import { STATUS_MAX_AGE_MS, createApp, retireKmsKeys } from '../src/app.js';

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
  app = createApp({ store, info, jwtSecret: new TextEncoder().encode('test-secret-test-secret-test-secret'), proxySecret: PROXY, siweDomain: DOMAIN, keyCustody: 'kms' as const, network: 'testnet' as const, now: () => now });
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
  it('the review link may sign in too, but only for its own nonce; any other site is refused; production stays the default', async () => {
    const REVIEW = 'review.bulwark.example';
    const two = createApp({ store, info, jwtSecret: new TextEncoder().encode('test-secret-test-secret-test-secret'), proxySecret: PROXY, siweDomain: DOMAIN, siweExtraDomains: [REVIEW], keyCustody: 'kms' as const, network: 'testnet' as const, now: () => now });
    const nonceFor = async (site?: string) => (await (await two.request('/auth/nonce', { method: 'POST', headers: site ? { 'x-bulwark-site': site } : {}, body: JSON.stringify({ address: user.address }) })).json()) as { nonce: string; domain: string };
    const signAs = async (domain: string, nonce: string) => {
      const message = createSiweMessage({ address: user.address, chainId: 42161, domain, nonce, uri: `https://${domain}`, version: '1', issuedAt: new Date(now) });
      return two.request('/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature: await user.signMessage({ message }) }) });
    };
    expect((await nonceFor()).domain).toBe(DOMAIN);
    expect((await nonceFor('evil.example')).domain).toBe(DOMAIN);
    const r = await nonceFor(REVIEW);
    expect(r.domain).toBe(REVIEW);
    expect((await signAs(REVIEW, r.nonce)).status).toBe(200);
    // A nonce issued for production can't be used to sign in as the review site, and vice versa.
    const p = await nonceFor();
    const wrong = await signAs(REVIEW, p.nonce);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ code: 'wrong_domain' });
    expect((await signAs('evil.example', (await nonceFor('evil.example')).nonce)).status).toBe(401);
  });

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

  it('answers 503, not 500, when KMS refuses to create a key', async () => {
    const token = await signIn();
    await app.request('/v1/onboarding/attest', { method: 'POST', headers: authed(token, fromProxy('IN')), body: JSON.stringify({ residency: 'IN', citizenship: 'IN' }) });
    const refusing = createApp({ store, info, jwtSecret: new TextEncoder().encode('test-secret-test-secret-test-secret'), proxySecret: PROXY, siweDomain: DOMAIN, keyCustody: 'kms' as const, network: 'testnet' as const, now: () => now, provisionAgent: async () => { throw Object.assign(new Error('not authorized to perform: kms:TagResource'), { name: 'AccessDeniedException' }); } });
    const res = await refusing.request('/v1/onboarding/agent', { method: 'POST', headers: authed(token) });
    expect(res.status).toBe(503);
    expect((await store.user(ACCOUNT))?.agentKeyRef).toBe('pending');
  });

  it('provisions a guard key only when KMS is configured', async () => {
    const token = await signIn();
    await app.request('/v1/onboarding/attest', { method: 'POST', headers: authed(token, fromProxy('IN')), body: JSON.stringify({ residency: 'IN', citizenship: 'IN' }) });
    expect((await app.request('/v1/onboarding/agent', { method: 'POST', headers: authed(token) })).status).toBe(503);
    const withKms = createApp({ store, info, jwtSecret: new TextEncoder().encode('test-secret-test-secret-test-secret'), proxySecret: PROXY, siweDomain: DOMAIN, keyCustody: 'kms' as const, network: 'testnet' as const, now: () => now, provisionAgent: async () => ({ keyId: 'key-1', address: '0x00000000000000000000000000000000000000aa' }) });
    const res = await withKms.request('/v1/onboarding/agent', { method: 'POST', headers: authed(token) });
    expect(await res.json()).toEqual({ agentAddress: '0x00000000000000000000000000000000000000aa' });
    expect((await store.user(ACCOUNT))?.agentKeyRef).toBe('kms:key-1');
  });
});

describe('policy confirmation', () => {
  const policy: Policy = { version: 1, account: ACCOUNT, rules: [{ id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }], repeat: { mode: 'oncePerBreach' } }], execution: { maxSlippagePct: 1 } };

  it('refuses a policy until every stage has the repeat choice (when required), and says which stages need it', async () => {
    app = createApp({ store, info, jwtSecret: new TextEncoder().encode('test-secret-test-secret-test-secret'), proxySecret: PROXY, siweDomain: DOMAIN, keyCustody: 'kms' as const, network: 'testnet' as const, now: () => now, repeatChoiceRequired: true });
    const token = await signIn();
    const unchosen: Policy = { ...policy, rules: [...policy.rules, { id: 'stage-2', when: { kind: 'buffer', below: 1.5 }, then: [{ kind: 'alert' }] }] };
    const res = await app.request('/v1/policy', { method: 'POST', headers: authed(token), body: JSON.stringify({ policy: unchosen, signature: await sign(user, unchosen), chainId: 42161 }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ needsChoice: ['stage-2'] });
  });

  it('while not required (until the app sends it), a policy without the choice is accepted and runs as before', async () => {
    const token = await signIn();
    const unchosen: Policy = { ...policy, rules: [{ id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }] }] };
    const res = await app.request('/v1/policy', { method: 'POST', headers: authed(token), body: JSON.stringify({ policy: unchosen, signature: await sign(user, unchosen), chainId: 42161 }) });
    expect(res.status).toBe(200);
  });

  it('lists the stages of an older signed policy that still need the choice', async () => {
    const token = await signIn();
    await app.request('/v1/onboarding/attest', { method: 'POST', headers: authed(token, fromProxy('IN')), body: JSON.stringify({ residency: 'IN', citizenship: 'IN' }) });
    const old: Policy = { ...policy, rules: [{ id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }] }] };
    store.putPolicy(ACCOUNT, { policy: old, hash: policyHash(old), signature: '0x00', signatureVerified: true, confirmedAt: now });
    const me = (await (await app.request('/v1/me', { headers: authed(token) })).json()) as { policy: { needsRepeatChoice: string[] } };
    expect(me.policy.needsRepeatChoice).toEqual(['stage-1']);
  });
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
    const withBot = createApp({ store, info, jwtSecret: new TextEncoder().encode('test-secret-test-secret-test-secret'), proxySecret: PROXY, siweDomain: DOMAIN, keyCustody: 'kms' as const, network: 'testnet' as const, now: () => now, telegramBot: 'BulwarkGuardBot' });
    const r = (await (await withBot.request('/v1/telegram/code', { method: 'POST', headers: authed(token) })).json()) as { code: string; bot: string; link: string };
    expect(r).toMatchObject({ bot: '@BulwarkGuardBot', link: `https://t.me/BulwarkGuardBot?start=${r.code}` });
  });
});

describe('AI translator', () => {
  const policy: Policy = { version: 1, account: ACCOUNT, rules: [{ id: 'stage-1', when: { kind: 'buffer', below: 3 }, then: [{ kind: 'alert' }] }], execution: { maxSlippagePct: 1 } };
  const reply = (out: unknown) => ({ messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) } });
  const withTranslator = (out: unknown) => createApp({ store, info, jwtSecret: new TextEncoder().encode('test-secret-test-secret-test-secret'), proxySecret: PROXY, siweDomain: DOMAIN, keyCustody: 'kms' as const, network: 'testnet' as const, now: () => now, translator: anthropicProvider(reply(out)) });
  const draft = (a: ReturnType<typeof createApp>, token: string, text: string, extra: Record<string, unknown> = {}) => a.request('/v1/rules/draft', { method: 'POST', headers: authed(token), body: JSON.stringify({ text, ...extra }) });
  const confirm = () => store.confirmPolicy(ACCOUNT, { policy, hash: policyHash(policy), signature: '0x', signatureVerified: true, confirmedAt: now });

  it('is off without a key; for a first policy it needs the slippage limit the user typed, and drafts version 1', async () => {
    const token = await signIn();
    expect((await draft(app, token, 'below 2x alert me')).status).toBe(503);
    const t = withTranslator({ outcome: 'rule', rule: { when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }], repeat: { mode: 'oncePerBreach' } }, message: '' });
    expect((await draft(t, token, 'below 2x alert me, only once')).status).toBe(400);
    expect((await draft(t, token, 'below 2x alert me, only once', { maxSlippagePct: 25 })).status).toBe(400);
    const res = await draft(t, token, 'below 2x alert me, only once', { maxSlippagePct: 0.8 });
    expect(await res.json()).toMatchObject({ kind: 'draft', policy: { version: 1, execution: { maxSlippagePct: 0.8 }, rules: [{ id: 'ai-1', repeat: { mode: 'oncePerBreach' } }] } });
  });

  it('asks rather than picks when the sentence does not say once or every time', async () => {
    const token = await signIn();
    await confirm();
    // The model claims "every time"; the sentence says neither, so the API asks the fixed question and drafts nothing.
    const res = await draft(withTranslator({ outcome: 'rule', rule: { when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }], repeat: { mode: 'everyCrossing' } }, message: '' }), token, 'If my buffer drops below 2x, alert me');
    const body = await res.json();
    expect(body).toEqual({ kind: 'clarify', question: REPEAT_QUESTION });
  });

  it('returns a checked draft with a fixed description and the next policy version', async () => {
    const token = await signIn();
    await confirm();
    const res = await draft(withTranslator({ outcome: 'rule', rule: { when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }], repeat: { mode: 'everyCrossing' } }, message: '' }), token, 'If my buffer drops below 2x, alert me every time');
    expect(await res.json()).toMatchObject({ kind: 'draft', description: 'When the buffer falls below 2×, alert you. Acts every time the line is crossed.', policy: { version: 2 }, rule: { id: 'ai-2' } });
  });

  it('never shows a draft with a number the user did not type, and logs the rejection', async () => {
    const token = await signIn();
    await confirm();
    const res = await draft(withTranslator({ outcome: 'rule', rule: { when: { kind: 'buffer', below: 1.5 }, then: [{ kind: 'close', target: { kind: 'all' } }] }, message: '' }), token, 'close everything when it gets risky');
    const body = (await res.json()) as { kind: string; rule?: unknown };
    expect(body.kind).toBe('rejected');
    expect(body.rule).toBeUndefined();
    expect(store.audit.raw(ACCOUNT).at(-1)).toMatchObject({ kind: 'rule_draft_rejected' });
  });

  it('caps translations per hour', async () => {
    const token = await signIn();
    await confirm();
    const a = withTranslator({ outcome: 'clarify', rule: null, message: 'Which market?' });
    for (let i = 0; i < 30; i++) expect((await draft(a, token, 'cut it')).status).toBe(200);
    expect((await draft(a, token, 'cut it')).status).toBe(429);
  });
});

describe('encrypted-at-rest guard keys (sealed custody)', () => {
  const sealedApp = () => createApp({ store, info, jwtSecret: new TextEncoder().encode('test-secret-test-secret-test-secret'), proxySecret: PROXY, siweDomain: DOMAIN, keyCustody: 'sealed', network: 'testnet', now: () => now });
  const BLOB = 'bwk1.m1.AAAAAAAAAAAAAAAA.c2VjcmV0LWNpcGhlcnRleHQ.dGFnLXRhZy10YWctdGFnLQ';
  const ADDR = '0x00000000000000000000000000000000000000bb';

  it('files a key request (202) for the signing service and returns the address once it exists', async () => {
    const token = await signIn();
    const a = sealedApp();
    await a.request('/v1/onboarding/attest', { method: 'POST', headers: authed(token, fromProxy('IN')), body: JSON.stringify({ residency: 'IN', citizenship: 'IN' }) });
    const first = await a.request('/v1/onboarding/agent', { method: 'POST', headers: authed(token) });
    expect(first.status).toBe(202);
    await a.request('/v1/onboarding/agent', { method: 'POST', headers: authed(token) });
    expect(await store.pendingKeyRequests('testnet')).toHaveLength(1); // idempotent
    // the signing service fulfils it
    await store.putSealedKey({ account: ACCOUNT, network: 'testnet', address: ADDR, sealed: BLOB, masterKeyId: 'm1', status: 'active', createdAt: now, updatedAt: now });
    await store.setUserAgent(ACCOUNT, `sealed:${ADDR}`, ADDR);
    const done = await a.request('/v1/onboarding/agent', { method: 'POST', headers: authed(token) });
    expect(await done.json()).toEqual({ agentAddress: ADDR });
  });

  it('no route returns key material', async () => {
    const token = await signIn();
    const a = sealedApp();
    await a.request('/v1/onboarding/attest', { method: 'POST', headers: authed(token, fromProxy('IN')), body: JSON.stringify({ residency: 'IN', citizenship: 'IN' }) });
    await store.putSealedKey({ account: ACCOUNT, network: 'testnet', address: ADDR, sealed: BLOB, masterKeyId: 'm1', status: 'active', createdAt: now, updatedAt: now });
    await store.setUserAgent(ACCOUNT, `sealed:${ADDR}`, ADDR);
    const bodies: string[] = [];
    for (const path of ['/v1/me', '/v1/policy', '/v1/guard-orders', '/v1/audit']) bodies.push(await (await a.request(path, { headers: authed(token) })).text());
    for (const [path, body] of [['/v1/onboarding/agent', {}], ['/v1/guard-key/rotate', {}]] as const) bodies.push(await (await a.request(path, { method: 'POST', headers: authed(token), body: JSON.stringify(body) })).text());
    for (const b of bodies) {
      expect(b).not.toContain('bwk1');
      expect(b).not.toContain('c2VjcmV0');
    }
    const me = JSON.parse(bodies[0]!);
    expect(me).toMatchObject({ keyCustody: 'sealed', keyStatus: 'ready', agent: { address: ADDR } });
  });

  it('the API code has no way to read a sealed key', () => {
    const { readdirSync, readFileSync } = require('node:fs') as typeof import('node:fs');
    const dir = new URL('../src/', import.meta.url);
    const src = readdirSync(dir).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
    for (const forbidden of ['sealedKey(', 'sealedKeysNotUnder', 'SIGNER_MASTER_KEYS', 'withAgentKey', 'SealedDigestSigner', 'parseMasterKeys']) expect(src).not.toContain(forbidden);
  });

  it('wipe is a signed command that stops the guard at once', async () => {
    const token = await signIn();
    await app.request('/v1/onboarding/attest', { method: 'POST', headers: authed(token, fromProxy('IN')), body: JSON.stringify({ residency: 'IN', citizenship: 'IN' }) });
    const sig = await user.signTypedData({ domain: policyConfirmationDomain(42161), types: COMMAND_TYPES, primaryType: 'BulwarkCommand', message: { account: ACCOUNT, command: 'wipe', minutes: 0, issuedAt: BigInt(now) } });
    const res = await app.request('/v1/commands', { method: 'POST', headers: authed(token), body: JSON.stringify({ command: 'wipe', issuedAt: now, signature: sig, chainId: 42161 }) });
    expect(res.status).toBe(200);
    expect((await store.user(ACCOUNT))?.killSwitch).toBe(true);
    expect((await store.pendingCommands()).map((c) => c.command)).toContain('wipe');
  });
});

describe('guard status', () => {
  const policy: Policy = { version: 1, account: ACCOUNT, rules: [{ id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }] }], execution: { maxSlippagePct: 1 } };
  const onboard = () => {
    store.putUser({ account: ACCOUNT, agentKeyRef: 'sealed:0x1', agentAddress: '0x0000000000000000000000000000000000000001', region: 'allowed', telegramChatId: null, killSwitch: false, builderApproved: false });
    store.putPolicy(ACCOUNT, { policy, hash: policyHash(policy), signature: '0x00', signatureVerified: true, confirmedAt: now });
  };
  const get = async (token: string) => (await app.request('/v1/guard/status', { headers: authed(token) })).json();

  it('needs a session', async () => expect((await app.request('/v1/guard/status')).status).toBe(401));

  it('serves what the worker wrote: state, paused reason and last evaluation', async () => {
    const token = await signIn();
    onboard();
    for (const [state, reason] of [['protected', null], ['acting', null], ['at_risk', null], ['alerts_only', null], ['paused', 'exchange_unreachable'], ['paused', 'signer_error'], ['paused', 'agent_expired'], ['paused', 'stale_data']] as const) {
      await store.setGuardStatus(ACCOUNT, { state, reason, lastEvaluatedAt: now - 2000, updatedAt: now - 1000 });
      expect(await get(token)).toEqual({ state, reason, lastEvaluatedAt: now - 2000, updatedAt: now - 1000 });
    }
  });

  it('no_rules before onboarding or without a signed policy', async () => {
    const token = await signIn();
    expect(await get(token)).toEqual({ state: 'no_rules', reason: null, lastEvaluatedAt: null, updatedAt: null });
  });

  it('stopped at once when the kill switch is on, whatever the worker last wrote', async () => {
    const token = await signIn();
    onboard();
    await store.setGuardStatus(ACCOUNT, { state: 'protected', reason: null, lastEvaluatedAt: now, updatedAt: now });
    await store.setKillSwitch(ACCOUNT, true);
    expect(await get(token)).toMatchObject({ state: 'stopped', reason: null, lastEvaluatedAt: now });
  });

  it('paused (stale_data) when the worker has not reported, has stopped reporting, or has not seen the latest change', async () => {
    const token = await signIn();
    onboard();
    expect(await get(token)).toEqual({ state: 'paused', reason: 'stale_data', lastEvaluatedAt: null, updatedAt: null });
    await store.setGuardStatus(ACCOUNT, { state: 'protected', reason: null, lastEvaluatedAt: now - STATUS_MAX_AGE_MS - 1, updatedAt: now - STATUS_MAX_AGE_MS - 1 });
    expect(await get(token)).toMatchObject({ state: 'paused', reason: 'stale_data', lastEvaluatedAt: now - STATUS_MAX_AGE_MS - 1 });
    await store.setGuardStatus(ACCOUNT, { state: 'no_rules', reason: null, lastEvaluatedAt: null, updatedAt: now });
    expect(await get(token)).toMatchObject({ state: 'paused', reason: 'stale_data' }); // rules just signed
    await store.setGuardStatus(ACCOUNT, { state: 'stopped', reason: null, lastEvaluatedAt: now, updatedAt: now });
    expect(await get(token)).toMatchObject({ state: 'paused', reason: 'stale_data' }); // just resumed
  });
});

describe('KMS custody (active)', () => {
  let n = 0;
  const kmsApp = (retired: string[] = []) =>
    createApp({
      store, info, jwtSecret: new TextEncoder().encode('test-secret-test-secret-test-secret'), proxySecret: PROXY, siweDomain: DOMAIN, keyCustody: 'kms' as const, network: 'testnet' as const, now: () => now,
      provisionAgent: async () => ({ keyId: `key-${++n}`, address: `0x${String(n).padStart(40, 'a')}` as `0x${string}` }),
      retireKmsKey: async (id) => void retired.push(id),
    });
  const onboard = async (a: ReturnType<typeof kmsApp>) => {
    const token = await signIn();
    await a.request('/v1/onboarding/attest', { method: 'POST', headers: authed(token, fromProxy('IN')), body: JSON.stringify({ residency: 'IN', citizenship: 'IN' }) });
    await a.request('/v1/onboarding/agent', { method: 'POST', headers: authed(token) });
    return token;
  };

  it('records the KMS key (id and address only) and logs that its private key cannot leave KMS', async () => {
    const a = kmsApp();
    await onboard(a);
    const [k] = await store.agentKeys(ACCOUNT, 'testnet');
    expect(k).toMatchObject({ status: 'active', kmsKeyId: `key-${n}`, masterKeyId: null });
    expect(store.audit.raw(ACCOUNT).at(-1)?.what).toMatch(/created in AWS KMS .* cannot leave KMS/);
  });

  it('rotation creates a replacement KMS key that waits for approval; asking again returns the same one', async () => {
    const a = kmsApp();
    const token = await onboard(a);
    const r1 = (await (await a.request('/v1/guard-key/rotate', { method: 'POST', headers: authed(token) })).json()) as { pendingAgent: { address: string } };
    const r2 = (await (await a.request('/v1/guard-key/rotate', { method: 'POST', headers: authed(token) })).json()) as { pendingAgent: { address: string } };
    expect(r2.pendingAgent.address).toBe(r1.pendingAgent.address);
    expect((await store.agentKeys(ACCOUNT, 'testnet')).map((k) => k.status)).toEqual(['active', 'pending']);
  });

  it('a wiped KMS key is disabled and scheduled for deletion in AWS, once, and logged', async () => {
    const retired: string[] = [];
    const a = kmsApp(retired);
    await onboard(a);
    const keyId = `key-${n}`;
    const deps = { store, network: 'testnet' as const, retireKmsKey: async (id: string) => void retired.push(id), now: () => now };
    expect(await retireKmsKeys(deps)).toEqual({ retired: 0, failed: 0 }); // still in use: untouched
    await store.wipeAgentKeys(ACCOUNT, 'testnet', now); // what the worker's wipe does
    expect(await retireKmsKeys(deps)).toEqual({ retired: 1, failed: 0 });
    expect(await retireKmsKeys(deps)).toEqual({ retired: 0, failed: 0 });
    expect(retired).toEqual([keyId]);
    expect(store.audit.raw(ACCOUNT).at(-1)?.what).toMatch(/AWS KMS key .* disabled; AWS deletes it after 7 days/);
  });

  it('a failed retirement is tried again; a key already pending deletion counts as done', async () => {
    const a = kmsApp();
    await onboard(a);
    await store.wipeAgentKeys(ACCOUNT, 'testnet', now);
    const fail = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    const gone = Object.assign(new Error('pending deletion'), { name: 'KMSInvalidStateException' });
    const deps = (e: Error) => ({ store, network: 'testnet' as const, retireKmsKey: async () => { throw e; }, now: () => now });
    expect(await retireKmsKeys(deps(fail))).toEqual({ retired: 0, failed: 1 });
    expect(await retireKmsKeys(deps(gone))).toEqual({ retired: 1, failed: 0 });
    expect(await store.kmsKeysToRetire('testnet')).toEqual([]);
  });
});

describe('command results and alerts', () => {
  const onboard = () => store.putUser({ account: ACCOUNT, agentKeyRef: 'kms:k', agentAddress: '0x0000000000000000000000000000000000000001', region: 'allowed', telegramChatId: null, killSwitch: false, builderApproved: false });

  it('returns a command and, once the worker has done it, its result; never another account’s', async () => {
    const token = await signIn();
    onboard();
    const sig = await user.signTypedData({ domain: policyConfirmationDomain(42161), types: COMMAND_TYPES, primaryType: 'BulwarkCommand', message: { account: ACCOUNT, command: 'stop', minutes: 0, issuedAt: BigInt(now) } });
    const { id } = (await (await app.request('/v1/commands', { method: 'POST', headers: authed(token), body: JSON.stringify({ command: 'stop', issuedAt: now, signature: sig, chainId: 42161 }) })).json()) as { id: number };
    expect(await (await app.request(`/v1/commands/${id}`, { headers: authed(token) })).json()).toMatchObject({ id, command: 'stop', doneAt: null, result: null });
    await store.finishCommand(id, { cancelled: 1 }, now + 2000);
    expect(await (await app.request(`/v1/commands/${id}`, { headers: authed(token) })).json()).toMatchObject({ doneAt: now + 2000, result: { cancelled: 1 } });
    const other = await signIn(stranger);
    expect((await app.request(`/v1/commands/${id}`, { headers: authed(other) })).status).toBe(404);
  });

  it('unlinking Telegram removes the chat id', async () => {
    const token = await signIn();
    store.putUser({ account: ACCOUNT, agentKeyRef: 'kms:k', agentAddress: '0x0000000000000000000000000000000000000001', region: 'allowed', telegramChatId: '42', killSwitch: false, builderApproved: false });
    expect(await (await app.request('/v1/telegram', { headers: authed(token) })).json()).toEqual({ linked: true, chatId: '42' });
    expect((await app.request('/v1/telegram')).status).toBe(401);
    expect(await (await app.request('/v1/telegram', { method: 'DELETE', headers: authed(token) })).json()).toEqual({ linked: false });
    expect(await (await app.request('/v1/telegram', { headers: authed(token) })).json()).toEqual({ linked: false, chatId: null });
    expect((await store.user(ACCOUNT))?.telegramChatId).toBeNull();
  });

  it('alerts carry the rule and market they are about, and a read marker follows the user across devices', async () => {
    const token = await signIn();
    expect((await app.request('/v1/alerts/seen', { method: 'POST', headers: authed(token), body: JSON.stringify({ upTo: 1 }) })).status).toBe(409);
    onboard();
    await store.audit.append({ account: ACCOUNT, at: now + 1, kind: 'alert', why: 'Liquidation reported by the exchange', what: 'x', proof: { fill: { coin: 'xyz:GOLD' } } });
    await store.audit.append({ account: ACCOUNT, at: now + 2, kind: 'alert', why: 'buffer below your line', what: 'y', proof: { ruleId: 'stage-2' } });
    await store.audit.append({ account: ACCOUNT, at: now + 3, kind: 'degraded', why: 'late data', what: 'z' });
    const feed = (await (await app.request(`/v1/alerts?since=${now}`, { headers: authed(token) })).json()) as Array<{ seq: number; ruleId: string | null; coin: string | null }>;
    expect(feed.map((e) => [e.ruleId, e.coin])).toEqual([[null, null], ['stage-2', null], [null, 'xyz:GOLD']]);
    expect(await (await app.request('/v1/alerts/seen', { headers: authed(token) })).json()).toEqual({ upTo: 0, unread: 3 });
    const middle = feed[1]!.seq;
    expect(await (await app.request('/v1/alerts/seen', { method: 'POST', headers: authed(token), body: JSON.stringify({ upTo: middle }) })).json()).toEqual({ upTo: middle });
    expect(await (await app.request('/v1/alerts/seen', { method: 'POST', headers: authed(token), body: JSON.stringify({ upTo: 0 }) })).json()).toEqual({ upTo: middle });
    expect((await (await app.request('/v1/alerts/seen', { headers: authed(token) })).json()) as object).toEqual({ upTo: middle, unread: 1 });
    expect((await app.request('/v1/alerts/seen', { method: 'POST', headers: authed(token), body: JSON.stringify({ upTo: -1 }) })).status).toBe(400);
  });

  it('in-app alerts: a setting next to Telegram, and a feed of what the guard told the user', async () => {
    const token = await signIn();
    onboard();
    expect(await (await app.request('/v1/settings/alerts', { headers: authed(token) })).json()).toEqual({ inApp: true, telegram: { linked: false } });
    expect((await app.request('/v1/settings/alerts', { method: 'PUT', headers: authed(token), body: JSON.stringify({ inApp: 'no' }) })).status).toBe(400);
    expect(await (await app.request('/v1/settings/alerts', { method: 'PUT', headers: authed(token), body: JSON.stringify({ inApp: false }) })).json()).toEqual({ inApp: false });
    await store.audit.append({ account: ACCOUNT, at: now + 1, kind: 'alert', why: 'buffer 1.4× below your 1.5× line', what: 'alert' });
    await store.audit.append({ account: ACCOUNT, at: now + 2, kind: 'guard_action', why: 'x', what: 'order sent' });
    const feed = (await (await app.request(`/v1/alerts?since=${now}`, { headers: authed(token) })).json()) as Array<{ kind: string }>;
    expect(feed.map((e) => e.kind)).toEqual(['alert']);
  });
});
