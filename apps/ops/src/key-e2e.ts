/**
 * End-to-end guard-key check on the live stack, with a throwaway account:
 * sign in → region step → guard key created (KMS custody) → signed wipe → the worker stops the guard
 * and retires the key → the API disables the KMS key and schedules its deletion. With provisioner
 * credentials in the environment, it then asks AWS for the key's state.
 *
 *   BASE=https://<site> pnpm --filter @bulwarkxyz/ops key-e2e
 *
 * Creates one real KMS key (scheduled for deletion at the end). Prints no secrets.
 */
import { DescribeKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { COMMAND_TYPES, policyConfirmationDomain } from '@bulwarkxyz/guard-core';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const BASE = process.env.BASE ?? 'https://bulwark.0xo.in';
const api = (p: string) => `${BASE}/api/bw${p}`;
const account = privateKeyToAccount(generatePrivateKey());
const ACCOUNT = account.address.toLowerCase();
const log = (step: string, data: unknown = '') => console.log(JSON.stringify({ step, ...(typeof data === 'object' ? (data as object) : { data }) }));

async function call<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(api(path), {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

async function main() {
  log('account', { account: ACCOUNT });
  const { body: n } = await call<{ nonce: string; domain: string }>('/auth/nonce', { body: { address: account.address } });
  const message = createSiweMessage({ address: account.address, chainId: 42161, domain: n.domain, nonce: n.nonce, uri: `https://${n.domain}`, version: '1', issuedAt: new Date() });
  const { body: v } = await call<{ token: string }>('/auth/verify', { body: { message, signature: await account.signMessage({ message }) } });
  const token = v.token;
  log('signed in', { ok: Boolean(token) });

  const attest = await call<Record<string, unknown>>('/v1/onboarding/attest', { body: { residency: 'IN', citizenship: 'IN' }, token });
  log('region', { status: attest.status, ...attest.body });
  const agent = await call<{ agentAddress?: string; error?: string }>('/v1/onboarding/agent', { body: {}, token });
  log('guard key', { status: agent.status, ...agent.body });
  const me = await call<{ keyCustody: string; newKeyCustody: string; user: { agentKeyRef: string } }>('/v1/me', { token });
  log('me', { keyCustody: me.body.keyCustody, newKeyCustody: me.body.newKeyCustody, refKind: me.body.user?.agentKeyRef.split(':')[0] });

  const issuedAt = Date.now();
  const signature = await account.signTypedData({ domain: policyConfirmationDomain(42161), types: COMMAND_TYPES, primaryType: 'BulwarkCommand', message: { network: 'testnet', account: account.address, command: 'wipe', minutes: 0, issuedAt: BigInt(issuedAt) } });
  const wipe = await call<Record<string, unknown>>('/v1/commands', { body: { command: 'wipe', issuedAt, signature, chainId: 42161 }, token });
  log('wipe sent', { status: wipe.status });

  // Worker: every 2 s; API retirement: every 15 s.
  type Entry = { kind: string; why: string; what: string; proof?: { kmsKeyId?: string } };
  let entries: Entry[] = [];
  for (let i = 0; i < 30; i++) {
    entries = (await call<Entry[]>('/v1/audit?limit=50', { token })).body ?? [];
    if (entries.some((e) => /disabled; AWS deletes it/.test(e.what))) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  for (const e of [...entries].reverse()) if (e.kind === 'key' || e.kind === 'command') log('audit', { kind: e.kind, what: e.what });
  const keyId = entries.find((e) => e.proof?.kmsKeyId)?.proof?.kmsKeyId;
  const after = await call<{ user: { agentKeyRef: string } }>('/v1/me', { token });
  log('after wipe', { agentKeyRef: after.body.user?.agentKeyRef });

  if (keyId && process.env.AWS_ACCESS_KEY_ID) {
    const kms = new KMSClient({ region: process.env.AWS_REGION ?? 'ap-southeast-1' });
    const d = await kms.send(new DescribeKeyCommand({ KeyId: keyId }));
    log('aws', { keyId, keyState: d.KeyMetadata?.KeyState, deletionDate: d.KeyMetadata?.DeletionDate?.toISOString(), keySpec: d.KeyMetadata?.KeySpec, origin: d.KeyMetadata?.Origin });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
