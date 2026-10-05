'use client';

import type { AuditEntry } from '@bulwarkxyz/store/audit';
import { useQuery } from '@tanstack/react-query';
import { api, useSignedIn } from './api';
import { useReview, useViewer } from './review';

/** The audit log (GET /v1/audit), newest 500. Shared by the Audit log screen and the guard actions panel. */
export function useAudit() {
  const review = useReview();
  const { address } = useViewer();
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: ['audit', address, review.on],
    enabled: Boolean(address && (signedIn || review.on)),
    queryFn: async () => (review.on ? reviewEntries() : api<AuditEntry[]>('/v1/audit?limit=500')),
    refetchInterval: 30_000,
  });
}

/** Entries the guard wrote while acting: its orders, its backstops, its alerts. */
export const GUARD_KINDS = ['guard_action', 'backstop', 'alert', 'window'];

/**
 * Order attempts, from the proof the worker writes for each one (apps/worker guard.ts auditRecords):
 * `attempt` counts from 1, `filled` is what that attempt filled, `limitPx` its limit price.
 */
export interface Attempt {
  n: number;
  filled: number | null;
  limitPx: number | null;
}
export function attemptOf(e: AuditEntry): Attempt | null {
  const p = e.proof as { attempt?: unknown; filled?: unknown; limitPx?: unknown } | undefined | null;
  if (!p || typeof p.attempt !== 'number') return null;
  return { n: p.attempt, filled: typeof p.filled === 'number' ? p.filled : null, limitPx: typeof p.limitPx === 'number' ? p.limitPx : Number(p.limitPx) || null };
}

/** Review builds only: example entries, labelled as such on screen (no hash chain to check). */
function reviewEntries(): AuditEntry[] {
  const t = Date.UTC(2026, 9, 5, 8, 0);
  const e = (seq: number, mins: number, kind: string, what: string, why: string, proof: Record<string, unknown> | null = null) =>
    ({ seq, at: t - mins * 60_000, kind, what, why, hash: `example-${seq}`, prevHash: `example-${seq - 1}`, proof }) as unknown as AuditEntry;
  return [
    e(10, 2, 'rule_confirmed', 'Policy version 3 signed in your wallet: 3 rules, max slippage 0.5%.', 'You signed it.'),
    e(9, 9, 'alert', 'Reduce order for GOLD has not fully filled after 3 attempts. The guard keeps trying while the line is crossed.', 'Buffer below your 2.5× line.'),
    e(8, 9, 'guard_action', 'order sent, filled 0.4 of 1.1 (attempt 3)', 'Buffer below your 2.5× line.', { attempt: 3, filled: 0.4, limitPx: 3871.2 }),
    e(7, 10, 'guard_action', 'order sent, filled 0 of 1.1 (attempt 2)', 'Buffer below your 2.5× line.', { attempt: 2, filled: 0, limitPx: 3874.9 }),
    e(6, 10, 'guard_action', 'order sent, filled 0.9 of 2', 'Buffer below your 2.5× line.', { attempt: 1, filled: 0.9, limitPx: 3880.4 }),
    e(5, 14, 'rule_draft_rejected', 'A translated draft was discarded before you saw it.', 'It contained a number you did not type.'),
    e(4, 31, 'backstop', 'Reduce-only stop placed for GOLD at your 1.8× line.', 'Backstop at your lowest line.'),
    e(3, 95, 'degraded', 'Held off for 9 s after a reconnect.', 'Marks were 12 s old.'),
    e(2, 300, 'command', 'Guard resumed.', 'You signed the command.'),
    e(1, 320, 'approval', 'Guard key approved as your agent on Hyperliquid.', 'You signed the approval.'),
  ];
}
