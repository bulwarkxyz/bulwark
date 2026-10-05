'use client';

import { verifyChain, type AuditEntry } from '@bulwarkxyz/store/audit';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Icon } from '@/components/app/icons';
import { api, useSignedIn } from '@/lib/api';
import { useReview, useViewer } from '@/lib/review';

const KIND_LABEL: Record<string, string> = {
  guard_action: 'Guard action',
  rejected: 'Refused by checks',
  rule_confirmed: 'Policy signed',
  rule_draft_rejected: 'Draft refused',
  approval: 'Approval',
  backstop: 'Backstop',
  command: 'Command',
  alert: 'Alert',
  window: 'Window opened',
  degraded: 'Held off',
};
/** Colour only where it means something: amber when the guard acted, red for refusals and pauses. */
const KIND_CHIP: Record<string, string> = { guard_action: 'chip-acting', alert: 'chip-acting', rejected: 'chip-risk', degraded: 'chip-risk' };
const FILTERS: Array<{ id: string; label: string; kinds: string[] | null }> = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'guard', label: 'Guard actions', kinds: ['guard_action', 'backstop', 'alert', 'window'] },
  { id: 'rules', label: 'Rules', kinds: ['rule_confirmed', 'rule_draft_rejected'] },
  { id: 'commands', label: 'Commands', kinds: ['command', 'approval'] },
  { id: 'errors', label: 'Refusals', kinds: ['rejected', 'degraded'] },
];

/** Review builds only: example entries, labelled as such (no hash chain to check). */
function reviewEntries(): AuditEntry[] {
  const t = Date.UTC(2026, 9, 5, 8, 0);
  const e = (seq: number, mins: number, kind: string, what: string, why: string) => ({ seq, at: t - mins * 60_000, kind, what, why, hash: `example-${seq}`, prevHash: `example-${seq - 1}`, proof: null }) as unknown as AuditEntry;
  return [
    e(6, 2, 'rule_confirmed', 'Policy version 3 signed in your wallet: 3 rules, max slippage 0.5%.', 'You signed it.'),
    e(5, 14, 'rule_draft_rejected', 'A translated draft was discarded before you saw it.', 'It contained a number you did not type.'),
    e(4, 31, 'backstop', 'Reduce-only stop placed for GOLD at your 1.8× line.', 'Backstop at your lowest line.'),
    e(3, 95, 'degraded', 'Held off for 9 s after a reconnect.', 'Marks were 12 s old.'),
    e(2, 300, 'command', 'Guard resumed.', 'You signed the command.'),
    e(1, 320, 'approval', 'Guard key approved as your agent on Hyperliquid.', 'You signed the approval.'),
  ];
}

export default function AuditPage() {
  const review = useReview();
  const { address, connected } = useViewer();
  const signedIn = useSignedIn();
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState('all');
  const log = useQuery({
    queryKey: ['audit', address, review.on],
    enabled: Boolean(address && (signedIn || review.on)),
    queryFn: async () => (review.on ? reviewEntries() : api<AuditEntry[]>('/v1/audit?limit=500')),
    refetchInterval: 30_000,
  });
  const all = [...(log.data ?? [])].sort((a, b) => b.seq - a.seq);
  const kinds = FILTERS.find((f) => f.id === filter)?.kinds ?? null;
  const entries = kinds ? all.filter((e) => kinds.includes(e.kind)) : all;
  // The API returns the newest 500; the chain is checked from the oldest one returned.
  const fromStart = all.some((e) => e.seq === 1);
  const broken = review.state === 'error' ? 4 : log.data && fromStart && !review.on ? verifyChain(log.data) : null;
  const loading = review.state === 'loading' || (Boolean(address && (signedIn || review.on)) && log.isLoading);
  const empty = review.state === 'empty' || !connected;

  const chip = loading ? (
    <span className="chip">Verifying the chain…</span>
  ) : broken !== null ? (
    <span className="chip chip-risk">Chain broken at #{broken}</span>
  ) : review.on && all.length ? (
    <span className="chip">Example entries · chain not checked</span>
  ) : all.length ? (
    <span className="chip">
      {Icon.check()}
      {fromStart ? `Chain verified in your browser · ${all.length} entries` : 'Showing the newest 500'}
    </span>
  ) : null;

  return (
    <div className="pg">
      <div className="ptitle">
        <h1 className="h1">Audit log</h1>
        {chip}
        <span className="sp" />
        <div className="seg" role="tablist" aria-label="Filter" style={{ width: 'min(520px, 100%)' }}>
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <p className="small t2" style={{ margin: 0, maxWidth: 900 }}>
        Every action the guard sends, every action its checks refuse, and every policy and command you sign. Each entry carries the hash of the one before it, and this page recomputes the chain in your browser, so an edited or deleted entry shows up here.
      </p>

      {broken !== null ? (
        <div className="banner b-crit">
          {Icon.alert()}
          <span>
            <b>The chain does not verify at entry {broken}.</b> Its stored hash does not match the entry before it. Treat entries from {broken} onward as unverified, and keep a copy of the log.
          </span>
        </div>
      ) : null}
      {log.error ? (
        <div className="banner b-crit">
          {Icon.alert()}
          <span>
            <b>Can’t load the log.</b> {(log.error as Error).message}
          </span>
          <span className="sp" />
          <button type="button" className="btn btn-sm" onClick={() => log.refetch()}>
            Retry
          </button>
        </div>
      ) : null}

      <section className="panel">
        {empty ? (
          <div className="empty" style={{ padding: '90px 16px' }}>
            <div className="ico">{Icon.audit(18)}</div>
            <b>{connected ? 'No entries yet.' : 'No wallet connected.'}</b>
            <span className="small" style={{ maxWidth: 460 }}>
              {connected ? 'The first entry is written when you sign your first rules. After that, every guard action, rule change and signed command lands here.' : 'Connect and sign in to see your log.'}
            </span>
            <Link className="btn btn-sm" href={connected ? '/app/rules' : '/app/onboarding'}>
              {connected ? 'Write your first rule' : 'Connect wallet'}
            </Link>
          </div>
        ) : !signedIn && !review.on ? (
          <div className="pb small t2">Sign in (top right) to see your log.</div>
        ) : loading ? (
          <div className="pb col" style={{ gap: 18, padding: '20px 14px' }}>
            <b className="small">Verifying the chain in your browser…</b>
            <span className="sk" style={{ width: '96%' }} />
            <span className="sk" style={{ width: '90%' }} />
            <span className="sk" style={{ width: '94%' }} />
          </div>
        ) : !entries.length ? (
          <div className="empty">Nothing in this filter yet.</div>
        ) : (
          <div className="tblw">
            <table className="tbl" style={{ fontSize: 13 }}>
              <thead>
                <tr>
                  <th className="r">#</th>
                  <th>When (UTC)</th>
                  <th>Kind</th>
                  <th>What happened</th>
                  <th className="hide-sm">Why</th>
                  <th className="r">Proof</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <Fragment key={e.seq}>
                    <tr>
                      <td className={`r num ${broken !== null && e.seq >= broken ? 'ct' : 't3'}`}>{e.seq}</td>
                      <td className="num">{new Date(e.at).toISOString().slice(0, 19).replace('T', ' ')}</td>
                      <td>
                        <span className={`chip chip-sm ${KIND_CHIP[e.kind] ?? ''}`}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                      </td>
                      <td style={{ whiteSpace: 'normal', minWidth: 220 }}>{e.what}</td>
                      <td className="hide-sm t2" style={{ whiteSpace: 'normal', minWidth: 180 }}>
                        {e.why}
                      </td>
                      <td className="r">
                        <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open === e.seq} onClick={() => setOpen(open === e.seq ? null : e.seq)}>
                          {open === e.seq ? 'Hide' : 'Show'}
                        </button>
                      </td>
                    </tr>
                    {open === e.seq ? (
                      <tr>
                        <td colSpan={6} style={{ whiteSpace: 'normal' }}>
                          <div className="code">{JSON.stringify({ hash: e.hash, prevHash: e.prevHash, proof: e.proof ?? null }, null, 2)}</div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
