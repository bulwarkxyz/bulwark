'use client';

import { describeRule } from '@bulwarkxyz/compiler';
import { assessRisk, linearPath, nextTimeIn, simulate, type GuardAction, type SimResult, type WindowName } from '@bulwarkxyz/guard-core';
import Link from 'next/link';
import { useState } from 'react';
import { useAccount } from 'wagmi';
import { fmtBuffer, fmtPct, fmtPx, fmtUsd } from '@/components/app/format';
import { TopBar } from '@/components/app/shell';
import { useSignedIn } from '@/lib/api';
import { useAccountView, useFills } from '@/lib/hl';
import { useMe } from '@/lib/me';

/** Path resolution: the guard looks once per step. */
const STEPS = 120;
const WHEN: Array<{ id: 'now' | WindowName; label: string }> = [
  { id: 'now', label: 'Right now' },
  { id: 'weekend', label: 'Weekend' },
  { id: 'overnight', label: 'Overnight' },
  { id: 'us_session', label: 'US session' },
];

function actionText(a: GuardAction): string {
  const c = 'coin' in a ? a.coin.replace('xyz:', '') : '';
  switch (a.type) {
    case 'order':
      return `${a.isBuy ? 'Buy' : 'Sell'} ${a.size} ${c} reduce-only (limit ${fmtPx(a.limitPx)})`;
    case 'trigger':
      return `Backstop: stop ${a.size} ${c} at ${fmtPx(a.triggerPx)}`;
    case 'transfer':
      return `Move ${fmtUsd(a.amount)} from ${a.source} to ${a.toDex || 'main dex'}`;
    case 'isolatedMargin':
      return `Add ${fmtUsd(a.amount)} margin to ${c}`;
    case 'cancel':
      return `Cancel order ${a.oid} on ${c}`;
    case 'alert':
      return `Alert: ${a.reason}`;
  }
}

function BufferChart({ guarded, unguarded }: { guarded: number[]; unguarded: number[] }) {
  const W = 760;
  const H = 220;
  const all = [...guarded, ...unguarded].filter(Number.isFinite);
  const hi = Math.max(2, ...all);
  const y = (b: number) => H - 10 - (Math.min(Math.max(b, 0), hi) / hi) * (H - 20);
  const line = (xs: number[]) => xs.map((b, i) => `${((i / (STEPS)) * W).toFixed(1)},${y(b).toFixed(1)}`).join(' ');
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Buffer over the path, with and without the guard">
      <line x1="0" x2={W} y1={y(1)} y2={y(1)} stroke="var(--crit)" strokeDasharray="4 4" />
      <polyline fill="none" stroke="var(--text-3)" strokeWidth="1.6" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" points={line(unguarded)} />
      <polyline fill="none" stroke="var(--guard-text)" strokeWidth="2" vectorEffect="non-scaling-stroke" points={line(guarded)} />
    </svg>
  );
}

export default function SimulatorPage() {
  const { address } = useAccount();
  const signedIn = useSignedIn();
  const view = useAccountView(address);
  const me = useMe();
  const fills = useFills(address);
  const [moves, setMoves] = useState<Record<string, string>>({});
  const [when, setWhen] = useState<'now' | WindowName>('now');
  const [res, setRes] = useState<{ sim: SimResult; unguarded: number[]; at: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const positions = view.data?.snapshot.positions ?? [];
  const policy = me.data?.policy?.policy;
  // The user's realised taker+maker fee rate across their fills; 0 when they have none yet.
  const notional = (fills.data ?? []).reduce((s, f) => s + Number(f.px) * Number(f.sz), 0);
  const feeRate = notional ? (fills.data ?? []).reduce((s, f) => s + Number(f.fee), 0) / notional : 0;
  const typed = positions.filter((p) => moves[p.coin]?.trim());
  const valid = typed.length > 0 && typed.every((p) => Number.isFinite(Number(moves[p.coin])) && Number(moves[p.coin]) > -100);

  function run() {
    setErr(null);
    if (!view.data || !policy) return;
    const at = when === 'now' ? Date.now() : nextTimeIn(when, Date.now());
    if (at === null) return setErr('No such time in the next week.');
    const start = Object.fromEntries(positions.map((p) => [p.coin, p.markAtSnapshot]));
    const pct = Object.fromEntries(typed.map((p) => [p.coin, Number(moves[p.coin])]));
    const path = linearPath(start, pct, STEPS);
    const sim = simulate({ policy, snapshot: view.data.snapshot, path, now: at, feeRate, automationAllowed: me.data?.user?.region !== 'guardOff' });
    const unguarded = path.map((m) => assessRisk(view.data!.snapshot, m).worst?.buffer ?? Number.POSITIVE_INFINITY);
    setRes({ sim, unguarded, at });
  }

  const guardedLine = res ? res.sim.steps.map((s) => s.buffer) : [];
  const acted = res?.sim.steps.filter((s) => s.actions.length) ?? [];

  return (
    <>
      <TopBar title="Simulator" />
      <div className="content">
        <span className="muted" style={{ fontSize: 13 }}>
          Move prices on your real account and see what your signed rules would do, step by step. It runs the same code the guard runs. Fills are taken at the worst price your slippage limit allows; funding and order-book depth are not modelled.
        </span>
        {!address || !signedIn ? (
          <div className="callout">Connect a wallet and sign in to simulate your account.</div>
        ) : !policy ? (
          <div className="callout guard">
            <span>
              You have no signed rules yet.{' '}
              <Link className="link" href="/app/rules">
                Set up your rules
              </Link>
            </span>
          </div>
        ) : !positions.length ? (
          <div className="callout">No open positions to simulate.</div>
        ) : null}

        {policy && positions.length ? (
          <div className="split">
            <section className="card">
              <div className="card-h">
                <h2>Price moves</h2>
              </div>
              <div className="card-b stack">
                {positions.map((p) => (
                  <div key={p.coin} className="row" style={{ justifyContent: 'space-between' }}>
                    <span>
                      <b>{p.coin.replace('xyz:', '')}</b>{' '}
                      <span className={p.size > 0 ? 'long' : 'short'}>{p.size > 0 ? 'long' : 'short'}</span>{' '}
                      <span className="faint num">at {fmtPx(p.markAtSnapshot)}</span>
                    </span>
                    <div className="input" style={{ width: 170 }}>
                      <input aria-label={`${p.coin} move in percent`} inputMode="decimal" placeholder="Your move" value={moves[p.coin] ?? ''} onChange={(e) => setMoves((m) => ({ ...m, [p.coin]: e.target.value }))} />
                      <span className="faint">%</span>
                    </div>
                  </div>
                ))}
                <span className="faint" style={{ fontSize: 12 }}>
                  Type a negative number for a fall. Markets you leave empty stay where they are.
                </span>
                <div className="field">
                  <label>When the move happens</label>
                  <div className="seg" role="radiogroup" aria-label="When">
                    {WHEN.map((w) => (
                      <button key={w.id} type="button" className={when === w.id ? 'on' : ''} aria-pressed={when === w.id} onClick={() => setWhen(w.id)}>
                        {w.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="kv">
                  <span>Fee rate used</span>
                  <span className="num">{feeRate ? `${(feeRate * 1e4).toFixed(2)} bps (your fills)` : 'none (no fills yet)'}</span>
                </div>
                <button type="button" className="btn btn-primary" disabled={!valid} onClick={run}>
                  Run
                </button>
                {err ? <span className="err">{err}</span> : null}
              </div>
            </section>

            <section className="card" aria-live="polite">
              <div className="card-h">
                <h2>Result</h2>
              </div>
              <div className="card-b stack">
                {!res ? (
                  <span className="faint">Type a move and run.</span>
                ) : (
                  <>
                    <div className="kv">
                      <span>Without the guard</span>
                      <span className={res.sim.unguardedLiquidatedAt !== null ? 'err' : ''}>{res.sim.unguardedLiquidatedAt !== null ? `liquidated ${Math.round((res.sim.unguardedLiquidatedAt / STEPS) * 100)}% of the way` : 'not liquidated'}</span>
                    </div>
                    <div className="kv">
                      <span>With your rules</span>
                      <span className={res.sim.liquidatedAt !== null ? 'err' : 'ok-text'}>{res.sim.liquidatedAt !== null ? `liquidated ${Math.round((res.sim.liquidatedAt / STEPS) * 100)}% of the way` : 'not liquidated'}</span>
                    </div>
                    <div className="kv">
                      <span>Buffer at the end</span>
                      <span className="num">{fmtBuffer(res.sim.final.buffer)}</span>
                    </div>
                    <div className="kv">
                      <span>Account value at the end</span>
                      <span className="num">{fmtUsd(res.sim.final.accountValue)}</span>
                    </div>
                    <div className="kv">
                      <span>Fees paid by guard orders</span>
                      <span className="num">{fmtUsd(res.sim.feesPaid)}</span>
                    </div>
                  </>
                )}
              </div>
            </section>
          </div>
        ) : null}

        {res ? (
          <>
            <section className="card">
              <div className="card-h">
                <h2>Buffer along the path</h2>
                <span className="row faint" style={{ marginLeft: 'auto', fontSize: 12, gap: 14 }}>
                  <span style={{ color: 'var(--guard-text)' }}>— with your rules</span>
                  <span>- - without</span>
                  <span style={{ color: 'var(--crit)' }}>- - liquidation (1×)</span>
                </span>
              </div>
              <div className="card-b">
                <BufferChart guarded={guardedLine} unguarded={res.unguarded} />
              </div>
            </section>
            <section className="card tbl-wrap">
              <div className="card-h">
                <h2>What the guard did</h2>
              </div>
              {acted.length ? (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Along the path</th>
                      <th>Rule</th>
                      <th>Action</th>
                      <th className="r">Buffer after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {acted.flatMap((s) =>
                      s.actions.map((a, j) => (
                        <tr key={`${s.step}-${j}`}>
                          <td className="num">{fmtPct((s.step / STEPS) * 100, 0, false)}</td>
                          <td className="num">{a.ruleId}</td>
                          <td style={{ whiteSpace: 'normal' }}>{actionText(a)}</td>
                          <td className="r num">{fmtBuffer(s.buffer)}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              ) : (
                <div className="card-b faint">Nothing fired on this path.</div>
              )}
            </section>
          </>
        ) : null}
        {policy ? (
          <section className="card">
            <div className="card-h">
              <h2>Rules simulated (policy v{policy.version})</h2>
            </div>
            <div className="card-b stack" style={{ gap: 6 }}>
              {policy.rules.map((r) => (
                <span key={r.id} style={{ fontSize: 13 }}>
                  <span className="pill-k num">{r.id}</span> {describeRule(r)}
                </span>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
