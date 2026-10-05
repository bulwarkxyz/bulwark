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
    await sql`drop table if exists users, policies, latches, baselines, guard_orders, actions, audit_log, telegram_links cascade`;
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

  it('redeems a Telegram link code once, before it expires', async () => {
    await store.createTelegramCode('LINK01', A, 2000);
    expect(await store.redeemTelegramCode('LINK01', '77', 1000)).toBe(A);
    expect((await store.user(A))?.telegramChatId).toBe('77');
    expect(await store.redeemTelegramCode('LINK01', '78', 1000)).toBeNull();
    await store.createTelegramCode('OLD', A, 10);
    expect(await store.redeemTelegramCode('OLD', '79', 1000)).toBeNull();
  });

  it('chains the audit log, survives concurrent appends, and refuses edits and deletes', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.audit.append({ account: A, at: i, kind: 'alert', why: 'w', what: `m${i}` })));
    const chain = await store.audit.list(A, 100);
    expect(chain).toHaveLength(20);
    expect(verifyChain(chain)).toBeNull();
    await expect(sql`update audit_log set what = 'edited' where account = ${A} and seq = 1`).rejects.toThrow(/append-only/);
    await expect(sql`delete from audit_log where account = ${A}`).rejects.toThrow(/append-only/);
  });
});
