'use client';

import { verifyChain, type AuditEntry } from '@bulwarkxyz/store/audit';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { useAccount } from 'wagmi';
import { TopBar } from '@/components/app/shell';
import { api, useSignedIn } from '@/lib/api';

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
const KIND_CHIP: Record<string, string> = { guard_action: 'chip-guard', rejected: 'chip-crit', degraded: 'chip-warn', command: 'chip-warn', rule_draft_rejected: 'chip-crit' };

export default function AuditPage() {
  const { address } = useAccount();
  const signedIn = useSignedIn();
  const [open, setOpen] = useState<number | null>(null);
  const log = useQuery({
    queryKey: ['audit', address],
    enabled: Boolean(address && signedIn),
    queryFn: () => api<AuditEntry[]>('/v1/audit?limit=500'),
    refetchInterval: 30_000,
  });
  const entries = [...(log.data ?? [])].sort((a, b) => b.seq - a.seq);
  // The API returns the newest 500; the chain is checked from the oldest one returned.
  const fromStart = entries.some((e) => e.seq === 1);
  const broken = log.data && fromStart ? verifyChain(log.data) : null;

  return (
    <>
      <TopBar title="Audit log">
        {log.data ? (
          <span className={`chip ${broken === null && fromStart ? 'chip-guard' : broken !== null ? 'chip-crit' : ''}`}>
            <i />
            {!entries.length ? 'Empty' : !fromStart ? 'Showing the newest 500' : broken === null ? `Chain verified · ${entries.length} entries` : `Chain broken at #${broken}`}
          </span>
        ) : null}
      </TopBar>
      <div className="content">
        <span className="muted" style={{ fontSize: 13 }}>
          Every action the guard sends, every action its checks refuse, and every policy and command you sign. Each entry includes the hash of the one before it; this page recomputes the chain in your browser.
        </span>
        {!address || !signedIn ? (
          <div className="callout">Connect a wallet and sign in to see your log.</div>
        ) : log.isLoading ? (
          <div className="skeleton" style={{ height: 160 }} />
        ) : log.error ? (
          <div className="callout crit">{(log.error as Error).message}</div>
        ) : !entries.length ? (
          <div className="callout">Nothing yet. Entries appear when you sign a policy or the guard acts.</div>
        ) : (
          <section className="card tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>#</th>
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
                      <td className="num faint">{e.seq}</td>
                      <td className="num">{new Date(e.at).toISOString().slice(0, 19).replace('T', ' ')}</td>
                      <td>
                        <span className={`chip ${KIND_CHIP[e.kind] ?? ''}`}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                      </td>
                      <td style={{ whiteSpace: 'normal', minWidth: 220 }}>{e.what}</td>
                      <td className="hide-sm muted" style={{ whiteSpace: 'normal', minWidth: 180 }}>
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
          </section>
        )}
      </div>
    </>
  );
}
