import { canonicalJson } from '@bulwarkxyz/guard-core';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Append-only, hash-chained audit log, one chain per account. Each entry commits to the previous
 * entry's hash, so any edit or deletion breaks every later hash and `verifyChain` finds it.
 */
export type AuditKind =
  | 'guard_action' // an action the guard sent (or tried to)
  | 'rejected' // an action the invariant gate refused
  | 'rule_confirmed' // the user signed a policy version
  | 'rule_draft_rejected' // an AI draft failed number provenance or "only adds protection"
  | 'approval' // the user signed approveAgent / approveBuilderFee
  | 'backstop' // backstop placed or replaced
  | 'command' // panic unwind or kill switch
  | 'alert' // a message sent to the user
  | 'window' // a rule window opened and its baseline was set
  | 'degraded' // data stale or exchange unreachable: the guard held off
  | 'key'; // a guard key was created, replaced or wiped (never the key itself)

export interface AuditInput {
  account: string;
  at: number;
  kind: AuditKind;
  /** Plain-language "why". */
  why: string;
  /** Plain-language "what happened". */
  what: string;
  /** Exchange evidence: order ids, fills, signatures, latency. */
  proof?: Record<string, unknown>;
}

export interface AuditEntry extends AuditInput {
  seq: number;
  prevHash: string;
  hash: string;
}

export const GENESIS = `0x${'0'.repeat(64)}`;

export function entryHash(prevHash: string, input: AuditInput & { seq: number }): string {
  const body = canonicalJson({ ...input, account: input.account.toLowerCase(), prevHash });
  return `0x${bytesToHex(keccak_256(utf8ToBytes(body)))}`;
}

export interface AuditStore {
  append(input: AuditInput): Promise<AuditEntry>;
  /** Newest first; `before`: only entries with a lower seq (to page back through the whole chain). */
  list(account: string, limit?: number, before?: number): Promise<AuditEntry[]>;
}

/** Recomputes every hash in order; returns the first broken seq, or null if the chain is intact. */
export function verifyChain(entries: readonly AuditEntry[]): number | null {
  let prev = GENESIS;
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  for (const e of sorted) {
    const { prevHash, hash, ...rest } = e;
    if (prevHash !== prev || entryHash(prev, rest) !== hash) return e.seq;
    prev = hash;
  }
  return null;
}

export class MemoryAuditStore implements AuditStore {
  private readonly chains = new Map<string, AuditEntry[]>();
  async append(input: AuditInput): Promise<AuditEntry> {
    const key = input.account.toLowerCase();
    const chain = this.chains.get(key) ?? [];
    const prevHash = chain.at(-1)?.hash ?? GENESIS;
    const seq = chain.length + 1;
    const entry: AuditEntry = { ...input, seq, prevHash, hash: entryHash(prevHash, { ...input, seq }) };
    chain.push(entry);
    this.chains.set(key, chain);
    return entry;
  }
  async list(account: string, limit = 100, before?: number): Promise<AuditEntry[]> {
    const all = (this.chains.get(account.toLowerCase()) ?? []).filter((e) => before === undefined || e.seq < before);
    return all.slice(-limit).reverse();
  }
  /** Test helper: direct access to the stored chain. */
  raw(account: string): AuditEntry[] {
    return this.chains.get(account.toLowerCase()) ?? [];
  }
}
