/**
 * Integration test against a real Postgres. Runs when DATABASE_URL is set (CI service, or
 * `docker run -p 54329:5432 -e POSTGRES_PASSWORD=pw postgres:16` locally); skipped otherwise.
 */
import { policyHash, type Policy } from '@bulwarkxyz/guard-core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../src/audit.js';
import { PgStore, migrate } from '../src/pg-store.js';

const url = process.env.DATABASE_URL;
const A = '0x9959260f1aa229f8a70e0c495ca9b251106c1a86' as const;

describe.skipIf(!url)('postgres store', () => {
  const sql = postgres(url as string, { onnotice: () => undefined });
  const store = new PgStore(sql);

  beforeAll(async () => {
    await sql`drop table if exists users, policies, latches, baselines, guard_orders, actions, audit_log, telegram_links, commands, agent_keys, agent_key_requests, guard_status cascade`;
    await migrate(sql);
    await migrate(sql); // idempotent
    await store.upsertUser({ account: A, agentKeyRef: 'kms:key-1', region: 'allowed', telegramChatId: null, killSwitch: false, builderApproved: false }, 1);
  });
  afterAll(async () => sql.end());

  it('stores the confirmed policy and keeps only one active version', async () => {
    const p: Policy = { version: 1, account: A, rules: [{ id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }] }], execution: { maxSlippagePct: 1 } };
    await store.confirmPolicy(A, { policy: p, hash: policyHash(p), signature: '0xsig', signatureVerified: true, confirmedAt: 1 });
    const p2 = { ...p, version: 2 };
    await store.confirmPolicy(A, { policy: p2, hash: policyHash(p2), signature: '0xsig2', signatureVerified: true, confirmedAt: 2 });
    const active = await store.policy(A);
    expect(active?.policy.version).toBe(2);
    expect(active?.hash).toBe(policyHash(p2));
  });

  it('round-trips latches, baselines, guard orders and actions', async () => {
    await store.saveLatched(A, new Set(['stage-1@dex:xyz']));
    expect([...(await store.latched(A))]).toEqual(['stage-1@dex:xyz']);
    await store.setBaseline(A, 'weekend', { windowStart: 10, accountValue: 99.5, prices: { 'xyz:CL': 91.5 } });
    expect((await store.baselines(A)).weekend?.accountValue).toBe(99.5);
    await store.setBaseline(A, 'weekend', null);
    expect(await store.baselines(A)).toEqual({});
    await store.addGuardOrder(A, { oid: 7, coin: 'xyz:CL', kind: 'backstop', triggerPx: 80.1, size: 0.24, placedAt: 5 });
    expect(await store.guardOrders(A)).toEqual([{ oid: 7, coin: 'xyz:CL', kind: 'backstop', triggerPx: 80.1, size: 0.24, placedAt: 5 }]);
    await store.removeGuardOrders(A, [7]);
    expect(await store.guardOrders(A)).toEqual([]);
    await store.addAction(A, 100);
    expect(await store.recentActions(A, 50)).toEqual([100]);
  });

  it('round-trips retry chains next to the latches, without touching them', async () => {
    await store.saveLatched(A, new Set(['stage-1@dex:xyz']));
    const chain = { keys: ['stage-1@dex:xyz'], ruleId: 'stage-1', reason: 'buffer 1.80× below your 2× line', dex: 'xyz', coin: 'xyz:CL', isBuy: false, remaining: 0.12, failures: 2, lastAttemptAt: 50, alerted: false };
    await store.saveRetries(A, [chain]);
    expect(await store.retries(A)).toEqual([chain]);
    expect([...(await store.latched(A))]).toEqual(['stage-1@dex:xyz']);
    await store.saveLatched(A, new Set());
    expect(await store.retries(A)).toEqual([chain]);
    await store.saveRetries(A, []);
    expect(await store.retries(A)).toEqual([]);
    expect(await store.retries('0x0000000000000000000000000000000000000001')).toEqual([]);
  });

  it('KMS keys: recorded without material, queued for retirement once wiped, then marked retired', async () => {
    const A = '0x00000000000000000000000000000000000000c0';
    await store.upsertUser({ account: A, agentKeyRef: 'kms:k-1', region: 'allowed', telegramChatId: null, killSwitch: false, builderApproved: false }, 1);
    await store.putKmsKey({ account: A, network: 'testnet', address: '0x00000000000000000000000000000000000000a1', kmsKeyId: 'k-1', status: 'active', masterKeyId: null, createdAt: 1, updatedAt: 1 });
    expect((await store.agentKeys(A, 'testnet')).at(-1)).toMatchObject({ kmsKeyId: 'k-1', status: 'active' });
    expect(await store.kmsKeysToRetire('testnet')).toEqual([]);
    expect(await store.wipeAgentKeys(A, 'testnet', 5, '0x00000000000000000000000000000000000000A1')).toBe(1);
    expect(await store.kmsKeysToRetire('testnet')).toEqual([{ account: A, network: 'testnet', address: '0x00000000000000000000000000000000000000a1', kmsKeyId: 'k-1' }]);
    await store.markKmsRetired(A, 'testnet', '0x00000000000000000000000000000000000000a1', 6);
    expect(await store.kmsKeysToRetire('testnet')).toEqual([]);
    expect(await store.wipeAgentKeys(A, 'testnet', 7, '0x00000000000000000000000000000000000000a1')).toBe(0);
  });

  it('round-trips the guard status; a reason only with paused', async () => {
    expect(await store.guardStatus(A)).toBeNull();
    await store.setGuardStatus(A, { state: 'paused', reason: 'stale_data', lastEvaluatedAt: 10, updatedAt: 20 });
    expect(await store.guardStatus(A)).toEqual({ state: 'paused', reason: 'stale_data', lastEvaluatedAt: 10, updatedAt: 20 });
    await store.setGuardStatus(A, { state: 'protected', reason: null, lastEvaluatedAt: 30, updatedAt: 30 });
    expect(await store.guardStatus(A)).toEqual({ state: 'protected', reason: null, lastEvaluatedAt: 30, updatedAt: 30 });
    await expect(store.setGuardStatus(A, { state: 'protected', reason: 'stale_data', lastEvaluatedAt: 30, updatedAt: 31 })).rejects.toThrow();
  });

  it('redeems a Telegram link code once, before it expires', async () => {
    await store.createTelegramCode('LINK01', A, 2000);
    expect(await store.redeemTelegramCode('LINK01', '77', 1000)).toBe(A);
    expect((await store.user(A))?.telegramChatId).toBe('77');
    expect(await store.redeemTelegramCode('LINK01', '78', 1000)).toBeNull();
    await store.createTelegramCode('OLD', A, 10);
    expect(await store.redeemTelegramCode('OLD', '79', 1000)).toBeNull();
  });

  it('queues signed commands and flips the kill switch', async () => {
    const id = await store.addCommand({ account: A, command: 'stop', minutes: 0, issuedAt: 5, signature: '0xs' }, 6);
    expect(await store.pendingCommands()).toEqual([{ id, account: A, command: 'stop', minutes: 0, issuedAt: 5 }]);
    await store.finishCommand(id, { cancelled: 2 }, 7);
    expect(await store.pendingCommands()).toEqual([]);
    await store.setKillSwitch(A, true);
    expect((await store.user(A))?.killSwitch).toBe(true);
  });

  it('chains the audit log, survives concurrent appends, and refuses edits and deletes', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.audit.append({ account: A, at: i, kind: 'alert', why: 'w', what: `m${i}` })));
    const chain = await store.audit.list(A, 100);
    expect(chain).toHaveLength(20);
    expect(verifyChain(chain)).toBeNull();
    await expect(sql`update audit_log set what = 'edited' where account = ${A} and seq = 1`).rejects.toThrow(/append-only/);
    await expect(sql`delete from audit_log where account = ${A}`).rejects.toThrow(/append-only/);
  });

  it('agent keys: one open request per account, metadata never includes the blob, wipe destroys it', async () => {
    const r1 = await store.requestAgentKey(A, 'testnet', 'create', 10);
    const r2 = await store.requestAgentKey(A, 'testnet', 'create', 11);
    expect(r1.created).toBe(true);
    expect(r2).toEqual({ id: r1.id, created: false });
    expect((await store.pendingKeyRequests('testnet')).map((r) => r.id)).toEqual([r1.id]);
    await store.putSealedKey({ account: A, network: 'testnet', address: '0x00000000000000000000000000000000000000aa', sealed: 'bwk1.m1.iv.ct.tag', masterKeyId: 'm1', status: 'active', createdAt: 12, updatedAt: 12 });
    await store.finishKeyRequest(r1.id, { address: '0x…aa' }, 12);
    expect(await store.pendingKeyRequests('testnet')).toEqual([]);
    const meta = await store.agentKeys(A, 'testnet');
    expect(meta).toHaveLength(1);
    expect(JSON.stringify(meta)).not.toContain('bwk1');
    expect(await store.sealedKey(A, 'testnet', '0x00000000000000000000000000000000000000AA')).toEqual({ sealed: 'bwk1.m1.iv.ct.tag', masterKeyId: 'm1' });
    expect(await store.sealedKeysNotUnder('m2', 'testnet')).toHaveLength(1);
    await store.replaceSealed(A, 'testnet', '0x00000000000000000000000000000000000000aa', 'bwk1.m2.iv.ct.tag', 'm2', 13);
    expect(await store.sealedKeysNotUnder('m2', 'testnet')).toHaveLength(0);
    await store.setUserAgent(A, 'sealed:0x00000000000000000000000000000000000000aa', '0x00000000000000000000000000000000000000aa');
    expect((await store.user(A))?.agentKeyRef).toBe('sealed:0x00000000000000000000000000000000000000aa');
    expect(await store.wipeAgentKeys(A, 'testnet', 14)).toBe(1);
    expect(await store.sealedKey(A, 'testnet', '0x00000000000000000000000000000000000000aa')).toBeNull();
    const [row] = await sql`select sealed, status from agent_keys where account = ${A}`;
    expect(row).toEqual({ sealed: null, status: 'wiped' });
  });

  it('accepts the wipe command', async () => {
    const id = await store.addCommand({ account: A, command: 'wipe', minutes: 0, issuedAt: 20, signature: '0xsig' }, 20);
    expect((await store.pendingCommands()).find((c) => c.id === id)?.command).toBe('wipe');
  });
});

