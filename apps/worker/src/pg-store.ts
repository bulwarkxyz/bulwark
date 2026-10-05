import { readFileSync } from 'node:fs';
import { Policy } from '@bulwarkxyz/guard-core';
import type { Hex } from '@bulwarkxyz/hyperliquid';
import postgres from 'postgres';
import { GENESIS, entryHash, type AuditEntry, type AuditInput, type AuditStore } from './audit.js';
import type { Baseline, ConfirmedPolicy, GuardOrder, GuardStore, GuardUser } from './store.js';

type Sql = postgres.Sql;

export async function migrate(sql: Sql): Promise<void> {
  await sql.unsafe(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
}

class PgAudit implements AuditStore {
  constructor(private readonly sql: Sql) {}
  async append(input: AuditInput): Promise<AuditEntry> {
    const account = input.account.toLowerCase();
    return this.sql.begin(async (tx) => {
      // Serialise appends per account so the chain cannot fork.
      await tx`select pg_advisory_xact_lock(hashtext(${account}))`;
      const [last] = await tx<Array<{ seq: number; hash: string }>>`select seq, hash from audit_log where account = ${account} order by seq desc limit 1`;
      const seq = (last?.seq ?? 0) + 1;
      const prevHash = last?.hash ?? GENESIS;
      const entry: AuditEntry = { ...input, account, seq, prevHash, hash: entryHash(prevHash, { ...input, account, seq }) };
      await tx`insert into audit_log (account, seq, at, kind, why, what, proof, prev_hash, hash)
               values (${account}, ${seq}, ${input.at}, ${input.kind}, ${input.why}, ${input.what}, ${input.proof ? tx.json(input.proof as never) : null}, ${prevHash}, ${entry.hash})`;
      return entry;
    }) as Promise<AuditEntry>;
  }
  async list(account: string, limit = 100): Promise<AuditEntry[]> {
    const rows = await this.sql<Array<{ account: string; seq: number; at: string; kind: AuditEntry['kind']; why: string; what: string; proof: Record<string, unknown> | null; prev_hash: string; hash: string }>>`
      select * from audit_log where account = ${account.toLowerCase()} order by seq desc limit ${limit}`;
    return rows.map((r) => ({ account: r.account, seq: r.seq, at: Number(r.at), kind: r.kind, why: r.why, what: r.what, ...(r.proof ? { proof: r.proof } : {}), prevHash: r.prev_hash, hash: r.hash }));
  }
}

export class PgStore implements GuardStore {
  readonly audit: AuditStore;
  constructor(private readonly sql: Sql) {
    this.audit = new PgAudit(sql);
  }
  private k = (x: string) => x.toLowerCase();

  private toUser(r: Record<string, unknown>): GuardUser {
    return {
      account: r.account as Hex,
      agentKeyRef: r.agent_key_ref as string,
      region: r.region as GuardUser['region'],
      telegramChatId: (r.telegram_chat_id as string | null) ?? null,
      killSwitch: r.kill_switch as boolean,
      builderApproved: r.builder_approved as boolean,
    };
  }
  async upsertUser(u: GuardUser, now: number): Promise<void> {
    await this.sql`insert into users (account, agent_key_ref, region, telegram_chat_id, kill_switch, builder_approved, created_at)
      values (${this.k(u.account)}, ${u.agentKeyRef}, ${u.region}, ${u.telegramChatId}, ${u.killSwitch}, ${u.builderApproved}, ${now})
      on conflict (account) do update set agent_key_ref = excluded.agent_key_ref, region = excluded.region, telegram_chat_id = excluded.telegram_chat_id,
        kill_switch = excluded.kill_switch, builder_approved = excluded.builder_approved`;
  }
  async users() {
    return (await this.sql`select * from users`).map((r) => this.toUser(r));
  }
  async user(account: string) {
    const [r] = await this.sql`select * from users where account = ${this.k(account)}`;
    return r ? this.toUser(r) : null;
  }
  async confirmPolicy(account: string, cp: ConfirmedPolicy): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`update policies set active = false where account = ${this.k(account)} and active`;
      await tx`insert into policies (account, version, body, hash, signature, signature_verified, confirmed_at, active)
        values (${this.k(account)}, ${cp.policy.version}, ${tx.json(cp.policy as never)}, ${cp.hash}, ${cp.signature}, ${cp.signatureVerified}, ${cp.confirmedAt}, true)`;
    });
  }
  async policy(account: string): Promise<ConfirmedPolicy | null> {
    const [r] = await this.sql`select * from policies where account = ${this.k(account)} and active`;
    if (!r) return null;
    return { policy: Policy.parse(r.body), hash: r.hash, signature: r.signature, signatureVerified: r.signature_verified, confirmedAt: Number(r.confirmed_at) };
  }
  async latched(account: string) {
    const [r] = await this.sql`select keys from latches where account = ${this.k(account)}`;
    return new Set<string>((r?.keys as string[] | undefined) ?? []);
  }
  async saveLatched(account: string, keys: ReadonlySet<string>) {
    await this.sql`insert into latches (account, keys) values (${this.k(account)}, ${this.sql.json([...keys])})
      on conflict (account) do update set keys = excluded.keys`;
  }
  async baselines(account: string) {
    const rows = await this.sql`select rule_id, body from baselines where account = ${this.k(account)}`;
    return Object.fromEntries(rows.map((r) => [r.rule_id as string, r.body as Baseline]));
  }
  async setBaseline(account: string, ruleId: string, b: Baseline | null) {
    if (b === null) await this.sql`delete from baselines where account = ${this.k(account)} and rule_id = ${ruleId}`;
    else
      await this.sql`insert into baselines (account, rule_id, body) values (${this.k(account)}, ${ruleId}, ${this.sql.json(b as never)})
        on conflict (account, rule_id) do update set body = excluded.body`;
  }
  async guardOrders(account: string): Promise<GuardOrder[]> {
    const rows = await this.sql`select * from guard_orders where account = ${this.k(account)} order by placed_at`;
    return rows.map((r) => ({ oid: Number(r.oid), coin: r.coin, kind: r.kind, triggerPx: r.trigger_px, size: r.size, placedAt: Number(r.placed_at) }));
  }
  async addGuardOrder(account: string, o: GuardOrder) {
    await this.sql`insert into guard_orders (account, oid, coin, kind, trigger_px, size, placed_at)
      values (${this.k(account)}, ${o.oid}, ${o.coin}, ${o.kind}, ${o.triggerPx}, ${o.size}, ${o.placedAt}) on conflict do nothing`;
  }
  async removeGuardOrders(account: string, oids: readonly number[]) {
    if (oids.length) await this.sql`delete from guard_orders where account = ${this.k(account)} and oid in ${this.sql(oids as number[])}`;
  }
  async recentActions(account: string, since: number) {
    return (await this.sql`select at from actions where account = ${this.k(account)} and at >= ${since}`).map((r) => Number(r.at));
  }
  async addAction(account: string, at: number) {
    await this.sql`insert into actions (account, at) values (${this.k(account)}, ${at})`;
  }
  async createTelegramCode(code: string, account: string, expiresAt: number) {
    await this.sql`insert into telegram_links (code, account, expires_at) values (${code}, ${this.k(account)}, ${expiresAt})`;
  }
  async redeemTelegramCode(code: string, chatId: string, now: number) {
    return this.sql.begin(async (tx) => {
      const [row] = await tx`update telegram_links set used_at = ${now} where code = ${code} and used_at is null and expires_at >= ${now} returning account`;
      if (!row) return null;
      await tx`update users set telegram_chat_id = ${chatId} where account = ${row.account}`;
      return row.account as string;
    }) as Promise<string | null>;
  }
}
