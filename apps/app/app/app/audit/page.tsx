'use client';

import { verifyChain, type AuditEntry } from '@bulwarkxyz/store/audit';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { fmtPx } from '@/components/app/format';
import { Icon } from '@/components/app/icons';
import { useSignedIn } from '@/lib/api';
import { GUARD_KINDS, attemptOf, useAudit } from '@/lib/audit';
import { useReview, useViewer } from '@/lib/review';
import { useTimes } from '@/lib/time';
import { QueryParam, revealById } from '@/components/app/query-param';
import { WalletPending } from '@/components/app/connect';

const KIND_LABEL: Record<string, string> = {
  key: 'Guard key',
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
  { id: 'guard', label: 'Guard actions', kinds: GUARD_KINDS },
  { id: 'rules', label: 'Rules', kinds: ['rule_confirmed', 'rule_draft_rejected'] },
  { id: 'commands', label: 'Commands', kinds: ['command', 'approval'] },
  { id: 'errors', label: 'Refusals', kinds: ['rejected', 'degraded'] },
];

/** Who wrote the entry: you (a signature), the guard (an action), or the checks and the system. */
const BY: Record<string, string> = { rule_confirmed: 'you', command: 'you', approval: 'you', guard_action: 'guard', backstop: 'guard', alert: 'guard', window: 'guard', degraded: 'guard', rejected: 'checks', rule_draft_rejected: 'system', key: 'system' };
/** Backstops priced for the whole pool say so (proof.pricing, apps/api/CONTRACT.md). */
const pricedTogether = (e: AuditEntry) => e.kind === 'backstop' && (e.proof as { pricing?: unknown } | null | undefined)?.pricing === 'together';
const shortHash = (h: string) => (h.startsWith('0x') ? `${h.slice(0, 6)}…${h.slice(-4)}` : h);

/** The log as JSON, exactly as received (hashes included), so it can be checked outside the app. */
function exportJson(entries: readonly AuditEntry[], account: string | undefined) {
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bulwark-audit-${account ? account.slice(0, 8) : 'log'}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export default function AuditPage() {
  const review = useReview();
  const { address, connected, pending } = useViewer();
  const signedIn = useSignedIn();
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState('all');
  const log = useAudit();
  const times = useTimes();
  const all = [...(log.data ?? [])].sort((a, b) => b.seq - a.seq);
  // ?seq=12 (a notification's link): show every kind, open that entry and bring it into view.
  const [target, setTarget] = useState<number | null>(null);
  const onSeq = useCallback((v: string | null) => setTarget(v && /^\d+$/.test(v) ? Number(v) : null), []);
  const found = target !== null && all.some((e) => e.seq === target);
  useEffect(() => {
    if (!found || target === null) return;
    setFilter('all');
    setOpen(target);
    revealById(window.matchMedia('(max-width: 760px)').matches ? `auditc-${target}` : `audit-${target}`);
  }, [found, target]);
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
      <QueryParam name="seq" onChange={onSeq} />
      <div className="ptitle">
        <h1 className="h1">Audit log</h1>
        {chip}
        <span className="sp" />
        <div className="seg seg-scroll" role="tablist" aria-label="Filter" style={{ width: 'min(520px, 100%)' }}>
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-sm" disabled={!all.length} onClick={() => exportJson([...all].reverse(), address)}>
          Export JSON
        </button>
      </div>
      <p className="small t2" style={{ margin: 0, maxWidth: 900 }}>
        Every action the guard sends (each retry of an order that didn’t fully fill is its own entry, numbered by attempt), every action its checks refuse, and every policy and command you sign. Each entry carries the hash of the one before it, and this page recomputes the chain in your browser, so an edited or deleted entry shows up here.
      </p>

      {broken !== null ? (
        <div className="banner b-crit">
          {Icon.alert()}
          <span>
            <b>The chain does not verify at entry {broken}.</b> Its stored hash does not match the entry before it. Treat entries from {broken} onward as unverified, and keep a copy of the log.
          </span>
          <span className="sp" />
          <button type="button" className="btn btn-sm" disabled={!all.length} onClick={() => exportJson([...all].reverse(), address)}>
            Export JSON
          </button>
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
        {pending ? (
          <WalletPending pad={90} panel={false} />
        ) : empty ? (
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
          <>
          <ul className="mobile-only alist" aria-label="Entries">
            {entries.map((e) => {
              const a = attemptOf(e);
              return (
                <li key={e.seq} id={`auditc-${e.seq}`}>
                  <div className="row nw" style={{ gap: 8 }}>
                    <span className={`num tiny ${broken !== null && e.seq >= broken ? 'ct' : 't3'}`}>#{e.seq}</span>
                    <span className="num tiny t2">{times.fmt(e.at, 'short')}</span>
                    <span className={`chip chip-sm ${KIND_CHIP[e.kind] ?? ''}`}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                    <span className="sp" />
                    <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open === e.seq} onClick={() => setOpen(open === e.seq ? null : e.seq)}>
                      {open === e.seq ? 'Hide proof' : 'Proof'}
                    </button>
                  </div>
                  <span className="small">{e.what}</span>
                  <span className="tiny t2">{e.why}</span>
                  {pricedTogether(e) ? <span className="tag" style={{ alignSelf: 'flex-start' }}>priced together</span> : null}
                  {a ? (
                    <span className={`tiny num ${a.n > 1 ? 'wt' : 't2'}`}>
                      Attempt {a.n}
                      {a.filled !== null ? ` · filled ${a.filled}` : ''}
                      {a.limitPx ? ` · limit ${fmtPx(a.limitPx)}` : ''}
                    </span>
                  ) : null}
                  {open === e.seq ? <div className="code">{JSON.stringify({ hash: e.hash, prevHash: e.prevHash, proof: e.proof ?? null }, null, 2)}</div> : null}
                </li>
              );
            })}
          </ul>
          <div className="tblw hide-sm">
            <table className="tbl" style={{ fontSize: 13 }}>
              <thead>
                <tr>
                  <th className="r">#</th>
                  <th>When ({times.label})</th>
                  <th>Kind</th>
                  <th>What happened</th>
                  <th className="r">Attempt</th>
                  <th>By</th>
                  <th>Hash</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <Fragment key={e.seq}>
                    <tr id={`audit-${e.seq}`}>
                      <td className={`r num ${broken !== null && e.seq >= broken ? 'ct' : 't3'}`}>{e.seq}</td>
                      <td className="num">{times.fmt(e.at, 'full')}</td>
                      <td>
                        <span className={`chip chip-sm ${KIND_CHIP[e.kind] ?? ''}`}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                      </td>
                      <td style={{ whiteSpace: 'normal', minWidth: 260 }}>
                        {e.what}
                        {e.why ? <span className="tiny t3" style={{ display: 'block' }}>{e.why}</span> : null}
                        {pricedTogether(e) ? <span className="tag" style={{ marginTop: 4, display: 'inline-block' }}>priced together</span> : null}
                      </td>
                      <td className="r num">{(() => {
                        const a = attemptOf(e);
                        if (!a) return <span className="t3">—</span>;
                        return (
                          <span className={a.n > 1 ? 'wt' : undefined}>
                            {a.n}
                            {a.filled !== null ? <span className="t3"> · filled {a.filled}</span> : null}
                            {a.limitPx ? <span className="t3"> · limit {fmtPx(a.limitPx)}</span> : null}
                          </span>
                        );
                      })()}</td>
                      <td className="t2">{BY[e.kind] ?? 'system'}</td>
                      <td>
                        <button type="button" className="linkbtn num tiny t3" aria-expanded={open === e.seq} aria-label={`Entry ${e.seq}: show the hash, the one before it, and the exchange evidence`} onClick={() => setOpen(open === e.seq ? null : e.seq)}>
                          {shortHash(e.hash)}
                        </button>
                      </td>
                    </tr>
                    {open === e.seq ? (
                      <tr>
                        <td colSpan={7} style={{ whiteSpace: 'normal' }}>
                          <div className="code">{JSON.stringify({ hash: e.hash, prevHash: e.prevHash, proof: e.proof ?? null }, null, 2)}</div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </section>
    </div>
  );
}
