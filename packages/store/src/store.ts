import type { Breach, CommandName, Policy, RetryChain } from '@bulwarkxyz/guard-core';
import type { Hex } from '@bulwarkxyz/hyperliquid';
import { MemoryAuditStore, type AuditStore } from './audit.js';

export interface GuardUser {
  account: Hex;
  /** Where the guard's agent key lives: `kms:<keyId>` in production, `env:<VAR>` on testnet only; `pending` before provisioning. */
  agentKeyRef: string;
  /** The agent address the user approves on Hyperliquid. */
  agentAddress?: Hex | null;
  /** Declared at onboarding (ISO 3166-1 alpha-2). */
  residency?: string | null;
  citizenship?: string | null;
  /** Region verdict at onboarding; blocked users are never stored. EU/EEA → guardOff (decision D4). */
  region: 'allowed' | 'guardOff';
  telegramChatId: string | null;
  killSwitch: boolean;
  /** The user's maxBuilderFee covers our fee (read from the exchange at onboarding and refresh). */
  builderApproved: boolean;
  /** Country (and subdivision) of the user's latest request through the app's proxy; regions are re-checked with it. */
  lastCountry?: string | null;
  lastSubdivision?: string | null;
}

export interface ConfirmedPolicy {
  policy: Policy;
  hash: string;
  /** The user's EIP-712 signature over the policy hash ("specific authorization"). */
  signature: Hex;
  signatureVerified: boolean;
  confirmedAt: number;
  /** The wallet chain id the signature was made with (needed to verify it again). Null for old rows. */
  chainId?: number | null;
  /** The network the signature names (F5). Null: signed before signatures named the network, so it needs a re-sign. */
  signedNetwork?: 'mainnet' | 'testnet' | null;
}

export interface Baseline {
  /** Start of the window instance this baseline belongs to (absent for `rule_confirmed`). */
  windowStart?: number;
  accountValue?: number;
  prices?: Record<string, number>;
}

/** An order the guard placed itself. The guard may only ever cancel these. */
/**
 * An order the guard placed and left resting on Hyperliquid (contract: apps/api/CONTRACT.md).
 * `kind` 'backstop' is the only kind today; 'stage' is reserved for stages placed on the exchange.
 */
export interface GuardOrder {
  oid: number;
  coin: string;
  kind: 'backstop' | 'stage';
  triggerPx: number;
  size: number;
  placedAt: number;
  /** The rule and buffer line the order belongs to (absent on orders placed before these were recorded). */
  ruleId?: string | null;
  line?: number | null;
  pricing?: 'single' | 'together' | null;
}

export interface RuleMemory {
  breaches: Record<string, Breach>;
  fires: Record<string, number[]>;
}

/** What the guard is doing for an account, as the worker last judged it. */
export type GuardState = 'protected' | 'acting' | 'at_risk' | 'paused' | 'stopped' | 'no_rules' | 'alerts_only';
/** Why the guard is paused. */
export type PausedReason = 'stale_data' | 'exchange_unreachable' | 'signer_error' | 'agent_expired' | 'resign_required' | 'operator_stop';
export const GUARD_STATES: readonly GuardState[] = ['protected', 'acting', 'at_risk', 'paused', 'stopped', 'no_rules', 'alerts_only'];
export const PAUSED_REASONS: readonly PausedReason[] = ['stale_data', 'exchange_unreachable', 'signer_error', 'agent_expired', 'resign_required', 'operator_stop'];

export interface GuardStatus {
  state: GuardState;
  /** Set only when `state` is `paused`. */
  reason: PausedReason | null;
  /** Last time the guard evaluated the account's rules on fresh data; null if it never has. */
  lastEvaluatedAt: number | null;
  /** When the worker wrote this status. */
  updatedAt: number;
}

export interface GuardStore {
  /** Operator-wide state (the global stop, the worker's heartbeat), as JSON by key. */
  operatorState<T = unknown>(key: string): Promise<{ value: T; at: number } | null>;
  setOperatorState(key: string, value: unknown, now: number): Promise<void>;
  /** Records where the user's latest request came from (the app's proxy headers). */
  setLastSeen(account: string, country: string | null, subdivision: string | null): Promise<void>;
  users(): Promise<GuardUser[]>;
  user(account: string): Promise<GuardUser | null>;
  policy(account: string): Promise<ConfirmedPolicy | null>;
  latched(account: string): Promise<Set<string>>;
  saveLatched(account: string, keys: ReadonlySet<string>): Promise<void>;
  /** "Once per breach" prices and per-rule action times (for limits), carried between evaluations. */
  ruleMemory(account: string): Promise<RuleMemory>;
  saveRuleMemory(account: string, m: RuleMemory): Promise<void>;
  /** Guard orders that did not fully fill and are retried while their stage holds. */
  retries(account: string): Promise<RetryChain[]>;
  saveRetries(account: string, chains: readonly RetryChain[]): Promise<void>;
  guardStatus(account: string): Promise<GuardStatus | null>;
  setGuardStatus(account: string, status: GuardStatus): Promise<void>;
  baselines(account: string): Promise<Record<string, Baseline>>;
  setBaseline(account: string, ruleId: string, b: Baseline | null): Promise<void>;
  guardOrders(account: string): Promise<GuardOrder[]>;
  addGuardOrder(account: string, o: GuardOrder): Promise<void>;
  removeGuardOrders(account: string, oids: readonly number[]): Promise<void>;
  recentActions(account: string, since: number): Promise<number[]>;
  addAction(account: string, at: number): Promise<void>;
  /** Links a Telegram chat with a one-time code; returns the account, or null if the code is unknown, used or expired. */
  redeemTelegramCode(code: string, chatId: string, now: number): Promise<string | null>;
  /** Forgets this Telegram chat on every account linked to it (sent from the chat itself); returns those accounts. */
  unlinkTelegramChat(chatId: string): Promise<string[]>;
  readonly audit: AuditStore;
}

export interface CommandRecord {
  id: number;
  command: CommandName;
  minutes: number;
  issuedAt: number;
  createdAt: number;
  /** Null while the worker has not finished it. */
  doneAt: number | null;
  result: Record<string, unknown> | null;
}

export interface PendingCommand {
  id: number;
  account: string;
  command: CommandName;
  minutes: number;
  issuedAt: number;
  /** When the API verified the signature and accepted it (the server's clock, not the browser's). */
  acceptedAt: number;
  /** The signature and what it was made with, so the worker verifies it itself (F3). */
  signature?: string;
  chainId?: number | null;
  network?: string | null;
}

export type AgentKeyStatus = 'pending' | 'active' | 'retired' | 'wiped';
export type KeyRequestKind = 'create' | 'rotate';

/** An agent key's metadata. The sealed blob is never part of this shape. */
export interface AgentKeyInfo {
  account: string;
  network: string;
  address: Hex;
  status: AgentKeyStatus;
  masterKeyId: string | null;
  /** Set for keys held in AWS KMS (the key id; no key material). */
  kmsKeyId?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A KMS key that no longer signs for anyone and still has to be disabled and scheduled for deletion. */
export interface KmsKeyToRetire {
  account: string;
  network: string;
  address: Hex;
  kmsKeyId: string;
}

export interface KeyRequest {
  id: number;
  account: string;
  network: string;
  kind: KeyRequestKind;
  requestedAt: number;
}

/**
 * Sealed agent keys: the signing service's view only. The API's store type does not include it, so
 * API code has no way to read a blob, and no route can return one.
 */
export interface KeyVault {
  agentKeys(account: string, network: string): Promise<AgentKeyInfo[]>;
  pendingKeyRequests(network: string): Promise<KeyRequest[]>;
  finishKeyRequest(id: number, result: Record<string, unknown>, now: number): Promise<void>;
  putSealedKey(k: AgentKeyInfo & { sealed: string }): Promise<void>;
  sealedKey(account: string, network: string, address: string): Promise<{ sealed: string; masterKeyId: string } | null>;
  /** Live blobs not sealed under `masterKeyId` (to reseal after a master-key rotation). */
  sealedKeysNotUnder(masterKeyId: string, network: string): Promise<Array<{ account: string; address: string; sealed: string }>>;
  replaceSealed(account: string, network: string, address: string, sealed: string, masterKeyId: string, now: number): Promise<void>;
  setAgentKeyStatus(account: string, network: string, address: string, status: AgentKeyStatus, now: number): Promise<void>;
  /** Destroys the account's blobs on the network (all, or one address); status 'wiped'. Returns how many were live. */
  wipeAgentKeys(account: string, network: string, now: number, address?: string): Promise<number>;
  setUserAgent(account: string, agentKeyRef: string, agentAddress: string | null): Promise<void>;
  /** Records a key held in AWS KMS (id and address only). */
  putKmsKey(k: AgentKeyInfo & { kmsKeyId: string }): Promise<void>;
}

/** What the API needs on top of the worker's view. */
export interface ApiStore extends GuardStore {
  /** Asks the signing service for a new agent key. Idempotent while a request is pending. */
  requestAgentKey(account: string, network: string, kind: KeyRequestKind, now: number): Promise<{ id: number; created: boolean }>;
  agentKeys(account: string, network: string): Promise<AgentKeyInfo[]>;
  putKmsKey(k: AgentKeyInfo & { kmsKeyId: string }): Promise<void>;
  /** KMS keys that were wiped or replaced and are not yet disabled in AWS. */
  kmsKeysToRetire(network: string): Promise<KmsKeyToRetire[]>;
  markKmsRetired(account: string, network: string, address: string, now: number): Promise<void>;
  upsertUser(u: GuardUser, now: number): Promise<void>;
  setKillSwitch(account: string, on: boolean): Promise<void>;
  confirmPolicy(account: string, cp: ConfirmedPolicy): Promise<void>;
  createTelegramCode(code: string, account: string, expiresAt: number): Promise<void>;
  addCommand(c: { account: string; command: CommandName; minutes: number; issuedAt: number; signature: string; chainId?: number; network?: string }, now: number): Promise<number>;
  pendingCommands(): Promise<PendingCommand[]>;
  finishCommand(id: number, result: Record<string, unknown>, now: number): Promise<void>;
  /** One of the account's commands with its result (null for another account's id). */
  command(account: string, id: number): Promise<CommandRecord | null>;
  /** The user's alert preferences (in-app; Telegram is linked separately). */
  alertSettings(account: string): Promise<{ inApp: boolean }>;
  setAlertSettings(account: string, s: { inApp: boolean }): Promise<void>;
  /** The newest alert seq the user has seen (0 if none). */
  alertsSeen(account: string): Promise<number>;
  /** Moves the seen marker forward only; returns the marker after the call. */
  markAlertsSeen(account: string, upTo: number): Promise<number>;
}

export class MemoryStore implements ApiStore, KeyVault {
  readonly audit = new MemoryAuditStore();
  private readonly u = new Map<string, GuardUser>();
  private readonly p = new Map<string, ConfirmedPolicy>();
  private readonly l = new Map<string, Set<string>>();
  private readonly b = new Map<string, Record<string, Baseline>>();
  private readonly o = new Map<string, GuardOrder[]>();
  private readonly a = new Map<string, number[]>();
  private k = (x: string) => x.toLowerCase();
  private readonly ops = new Map<string, { value: unknown; at: number }>();
  async operatorState<T = unknown>(key: string) {
    return (this.ops.get(key) as { value: T; at: number } | undefined) ?? null;
  }
  async setOperatorState(key: string, value: unknown, now: number) {
    this.ops.set(key, { value, at: now });
  }
  async setLastSeen(account: string, country: string | null, subdivision: string | null) {
    const u = this.u.get(this.k(account));
    if (u) this.u.set(this.k(account), { ...u, lastCountry: country, lastSubdivision: subdivision });
  }

  putUser(user: GuardUser) {
    this.u.set(this.k(user.account), user);
  }
  putPolicy(account: string, cp: ConfirmedPolicy) {
    this.p.set(this.k(account), cp);
  }
  async users() {
    return [...this.u.values()];
  }
  async user(account: string) {
    return this.u.get(this.k(account)) ?? null;
  }
  async policy(account: string) {
    return this.p.get(this.k(account)) ?? null;
  }
  async latched(account: string) {
    return new Set(this.l.get(this.k(account)) ?? []);
  }
  async saveLatched(account: string, keys: ReadonlySet<string>) {
    this.l.set(this.k(account), new Set(keys));
  }
  private readonly rm = new Map<string, RuleMemory>();
  async ruleMemory(account: string) {
    return structuredClone(this.rm.get(this.k(account)) ?? { breaches: {}, fires: {} });
  }
  async saveRuleMemory(account: string, m: RuleMemory) {
    this.rm.set(this.k(account), structuredClone(m));
  }
  private readonly r = new Map<string, RetryChain[]>();
  async retries(account: string) {
    return structuredClone(this.r.get(this.k(account)) ?? []);
  }
  async saveRetries(account: string, chains: readonly RetryChain[]) {
    this.r.set(this.k(account), structuredClone([...chains]));
  }
  private readonly st = new Map<string, GuardStatus>();
  async guardStatus(account: string) {
    const s = this.st.get(this.k(account));
    return s ? { ...s } : null;
  }
  async setGuardStatus(account: string, status: GuardStatus) {
    this.st.set(this.k(account), { ...status });
  }
  async baselines(account: string) {
    return { ...(this.b.get(this.k(account)) ?? {}) };
  }
  async setBaseline(account: string, ruleId: string, base: Baseline | null) {
    const cur = { ...(this.b.get(this.k(account)) ?? {}) };
    if (base) cur[ruleId] = base;
    else delete cur[ruleId];
    this.b.set(this.k(account), cur);
  }
  async guardOrders(account: string) {
    return [...(this.o.get(this.k(account)) ?? [])];
  }
  async addGuardOrder(account: string, order: GuardOrder) {
    this.o.set(this.k(account), [...(this.o.get(this.k(account)) ?? []), order]);
  }
  async removeGuardOrders(account: string, oids: readonly number[]) {
    this.o.set(this.k(account), (this.o.get(this.k(account)) ?? []).filter((x) => !oids.includes(x.oid)));
  }
  async recentActions(account: string, since: number) {
    return (this.a.get(this.k(account)) ?? []).filter((t) => t >= since);
  }
  async addAction(account: string, at: number) {
    this.a.set(this.k(account), [...(this.a.get(this.k(account)) ?? []).filter((t) => t >= at - 3_600_000), at]);
  }
  async upsertUser(u: GuardUser) {
    this.putUser(u);
  }
  async setKillSwitch(account: string, on: boolean) {
    const u = this.u.get(this.k(account));
    if (u) this.u.set(this.k(account), { ...u, killSwitch: on });
  }
  async confirmPolicy(account: string, cp: ConfirmedPolicy) {
    this.putPolicy(account, cp);
  }
  async createTelegramCode(code: string, account: string, expiresAt: number) {
    this.putTelegramCode(code, account, expiresAt);
  }
  private readonly cmds: Array<Omit<PendingCommand, 'acceptedAt'> & { createdAt: number; doneAt?: number; result?: Record<string, unknown> }> = [];
  async addCommand(c: { account: string; command: CommandName; minutes: number; issuedAt: number; signature?: string; chainId?: number; network?: string }, now = 0) {
    if (c.signature && this.cmds.some((x) => x.signature === c.signature)) throw new Error('duplicate key value violates unique constraint "commands_signature_once"');
    const id = this.cmds.length + 1;
    this.cmds.push({ id, account: this.k(c.account), command: c.command, minutes: c.minutes, issuedAt: c.issuedAt, createdAt: now, ...(c.signature ? { signature: c.signature } : {}), chainId: c.chainId ?? null, network: c.network ?? null });
    return id;
  }
  async command(account: string, id: number): Promise<CommandRecord | null> {
    const c = this.cmds.find((x) => x.id === id && x.account === this.k(account));
    return c ? { id: c.id, command: c.command, minutes: c.minutes, issuedAt: c.issuedAt, createdAt: c.createdAt, doneAt: c.doneAt ?? null, result: c.result ?? null } : null;
  }
  private readonly alertPrefs = new Map<string, { inApp: boolean }>();
  async alertSettings(account: string) {
    return { ...(this.alertPrefs.get(this.k(account)) ?? { inApp: true }) };
  }
  async setAlertSettings(account: string, s: { inApp: boolean }) {
    this.alertPrefs.set(this.k(account), { inApp: s.inApp });
  }
  private readonly seen = new Map<string, number>();
  async alertsSeen(account: string) {
    return this.seen.get(this.k(account)) ?? 0;
  }
  async markAlertsSeen(account: string, upTo: number) {
    const next = Math.max(this.seen.get(this.k(account)) ?? 0, upTo);
    this.seen.set(this.k(account), next);
    return next;
  }
  async pendingCommands() {
    return this.cmds.filter((c) => c.doneAt === undefined).map(({ id, account, command, minutes, issuedAt, createdAt, signature, chainId, network }) => ({ id, account, command, minutes, issuedAt, acceptedAt: createdAt, ...(signature ? { signature } : {}), chainId: chainId ?? null, network: network ?? null }));
  }
  async finishCommand(id: number, result: Record<string, unknown>, now: number) {
    const c = this.cmds.find((x) => x.id === id);
    if (c) Object.assign(c, { doneAt: now, result });
  }
  // ---------------------------------------------------------------- agent keys
  private readonly keys: Array<AgentKeyInfo & { sealed: string | null; kmsRetiredAt?: number }> = [];
  private readonly keyReqs: Array<KeyRequest & { doneAt?: number; result?: Record<string, unknown> }> = [];
  async requestAgentKey(account: string, network: string, kind: KeyRequestKind, now: number) {
    const open = this.keyReqs.find((r) => r.account === this.k(account) && r.network === network && r.doneAt === undefined);
    if (open) return { id: open.id, created: false };
    const id = this.keyReqs.length + 1;
    this.keyReqs.push({ id, account: this.k(account), network, kind, requestedAt: now });
    return { id, created: true };
  }
  async agentKeys(account: string, network: string): Promise<AgentKeyInfo[]> {
    return this.keys.filter((x) => x.account === this.k(account) && x.network === network).map(({ sealed: _s, kmsRetiredAt: _r, ...info }) => ({ ...info, kmsKeyId: info.kmsKeyId ?? null }));
  }
  async pendingKeyRequests(network: string) {
    return this.keyReqs.filter((r) => r.network === network && r.doneAt === undefined).map(({ id, account, network: n, kind, requestedAt }) => ({ id, account, network: n, kind, requestedAt }));
  }
  async finishKeyRequest(id: number, result: Record<string, unknown>, now: number) {
    const r = this.keyReqs.find((x) => x.id === id);
    if (r) Object.assign(r, { doneAt: now, result });
  }
  async putSealedKey(k: AgentKeyInfo & { sealed: string }) {
    this.keys.push({ ...k, account: this.k(k.account), address: k.address.toLowerCase() as Hex });
  }
  async putKmsKey(k: AgentKeyInfo & { kmsKeyId: string }) {
    this.keys.push({ ...k, sealed: null, account: this.k(k.account), address: k.address.toLowerCase() as Hex });
  }
  async kmsKeysToRetire(network: string): Promise<KmsKeyToRetire[]> {
    return this.keys
      .filter((x) => x.network === network && x.kmsKeyId && (x.status === 'retired' || x.status === 'wiped') && x.kmsRetiredAt === undefined)
      .map((x) => ({ account: x.account, network: x.network, address: x.address, kmsKeyId: x.kmsKeyId as string }));
  }
  async markKmsRetired(account: string, network: string, address: string, now: number) {
    const x = this.findKey(account, network, address);
    if (x) x.kmsRetiredAt = now;
  }
  private findKey(account: string, network: string, address: string) {
    return this.keys.find((x) => x.account === this.k(account) && x.network === network && x.address === address.toLowerCase());
  }
  async sealedKey(account: string, network: string, address: string) {
    const x = this.findKey(account, network, address);
    return x?.sealed && x.masterKeyId ? { sealed: x.sealed, masterKeyId: x.masterKeyId } : null;
  }
  async sealedKeysNotUnder(masterKeyId: string, network: string) {
    return this.keys.filter((x) => x.network === network && x.sealed && x.masterKeyId !== masterKeyId).map((x) => ({ account: x.account, address: x.address, sealed: x.sealed! }));
  }
  async replaceSealed(account: string, network: string, address: string, sealed: string, masterKeyId: string, now: number) {
    const x = this.findKey(account, network, address);
    if (x && x.sealed) Object.assign(x, { sealed, masterKeyId, updatedAt: now });
  }
  async setAgentKeyStatus(account: string, network: string, address: string, status: AgentKeyStatus, now: number) {
    const x = this.findKey(account, network, address);
    if (x) Object.assign(x, { status, updatedAt: now });
  }
  async wipeAgentKeys(account: string, network: string, now: number, address?: string) {
    let n = 0;
    for (const x of this.keys) {
      const live = x.sealed !== null || (Boolean(x.kmsKeyId) && x.status !== 'wiped');
      if (x.account !== this.k(account) || x.network !== network || !live) continue;
      if (address && x.address !== address.toLowerCase()) continue;
      Object.assign(x, { sealed: null, masterKeyId: null, status: 'wiped' as const, updatedAt: now });
      n++;
    }
    return n;
  }
  async setUserAgent(account: string, agentKeyRef: string, agentAddress: string | null) {
    const u = this.u.get(this.k(account));
    if (u) this.u.set(this.k(account), { ...u, agentKeyRef, agentAddress: (agentAddress?.toLowerCase() ?? null) as Hex | null });
  }

  private readonly codes = new Map<string, { account: string; expiresAt: number; used: boolean }>();
  putTelegramCode(code: string, account: string, expiresAt: number) {
    this.codes.set(code, { account: this.k(account), expiresAt, used: false });
  }
  async redeemTelegramCode(code: string, chatId: string, now: number) {
    const c = this.codes.get(code);
    if (!c || c.used || c.expiresAt < now) return null;
    c.used = true;
    const u = this.u.get(c.account);
    if (u) this.u.set(c.account, { ...u, telegramChatId: chatId });
    return c.account;
  }
  async unlinkTelegramChat(chatId: string) {
    const out: string[] = [];
    for (const [k, u] of this.u) if (u.telegramChatId === chatId) (this.u.set(k, { ...u, telegramChatId: null }), out.push(k));
    return out;
  }
}

/**
 * A database belongs to one network (mainnet prerequisites, 8 Oct 2026). The first service to start stamps it; a service
 * for the other network then refuses to start against it, so tables and sessions never cross networks.
 */
export async function stampNetwork(store: Pick<GuardStore, 'operatorState' | 'setOperatorState'>, network: 'testnet' | 'mainnet', now: number): Promise<void> {
  const stamp = await store.operatorState<{ network: string }>('network');
  if (!stamp) return store.setOperatorState('network', { network }, now);
  if (stamp.value.network !== network) throw new Error(`this database belongs to ${stamp.value.network}; refusing to run ${network} against it`);
}
