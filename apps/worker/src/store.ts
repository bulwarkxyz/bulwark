import type { Policy } from '@bulwarkxyz/guard-core';
import type { Hex } from '@bulwarkxyz/hyperliquid';
import { MemoryAuditStore, type AuditStore } from './audit.js';

export interface GuardUser {
  account: Hex;
  /** Where the guard's agent key lives: `kms:<keyId>` in production, `local:<keychain service>` in dev. */
  agentKeyRef: string;
  /** Region verdict at onboarding; blocked users are never stored. EU/EEA → guardOff (decision D4). */
  region: 'allowed' | 'guardOff';
  telegramChatId: string | null;
  killSwitch: boolean;
  /** The user's maxBuilderFee covers our fee (read from the exchange at onboarding and refresh). */
  builderApproved: boolean;
}

export interface ConfirmedPolicy {
  policy: Policy;
  hash: string;
  /** The user's EIP-712 signature over the policy hash ("specific authorization"). */
  signature: Hex;
  signatureVerified: boolean;
  confirmedAt: number;
}

export interface Baseline {
  /** Start of the window instance this baseline belongs to (absent for `rule_confirmed`). */
  windowStart?: number;
  accountValue?: number;
  prices?: Record<string, number>;
}

/** An order the guard placed itself. The guard may only ever cancel these. */
export interface GuardOrder {
  oid: number;
  coin: string;
  kind: 'backstop';
  triggerPx: number;
  size: number;
  placedAt: number;
}

export interface GuardStore {
  users(): Promise<GuardUser[]>;
  user(account: string): Promise<GuardUser | null>;
  policy(account: string): Promise<ConfirmedPolicy | null>;
  latched(account: string): Promise<Set<string>>;
  saveLatched(account: string, keys: ReadonlySet<string>): Promise<void>;
  baselines(account: string): Promise<Record<string, Baseline>>;
  setBaseline(account: string, ruleId: string, b: Baseline | null): Promise<void>;
  guardOrders(account: string): Promise<GuardOrder[]>;
  addGuardOrder(account: string, o: GuardOrder): Promise<void>;
  removeGuardOrders(account: string, oids: readonly number[]): Promise<void>;
  recentActions(account: string, since: number): Promise<number[]>;
  addAction(account: string, at: number): Promise<void>;
  readonly audit: AuditStore;
}

export class MemoryStore implements GuardStore {
  readonly audit = new MemoryAuditStore();
  private readonly u = new Map<string, GuardUser>();
  private readonly p = new Map<string, ConfirmedPolicy>();
  private readonly l = new Map<string, Set<string>>();
  private readonly b = new Map<string, Record<string, Baseline>>();
  private readonly o = new Map<string, GuardOrder[]>();
  private readonly a = new Map<string, number[]>();
  private k = (x: string) => x.toLowerCase();

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
}
