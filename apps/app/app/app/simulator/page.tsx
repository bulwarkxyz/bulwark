'use client';

import { describeRule } from '@bulwarkxyz/compiler';
import { assessRisk, linearPath, nextTimeIn, simulate, type GuardAction, type SimResult, type WindowName } from '@bulwarkxyz/guard-core';
import Link from 'next/link';
import { useState } from 'react';
import { fmtBuffer, fmtPct, fmtPx, fmtUsd } from '@/components/app/format';
import { GuardChip } from '@/components/app/guard-ui';
import { Icon } from '@/components/app/icons';
import { useSignedIn } from '@/lib/api';
import { tickerOf, useGuardView, useNow } from '@/lib/guard';
import { useAccountView, useFills } from '@/lib/hl';
import { homeOpen, marketByCoin } from '@/lib/markets';
import { useMe } from '@/lib/me';
import { useReview, useViewer } from '@/lib/review';

/** Path resolution: the guard looks once per step. */
const STEPS = 120;
const WHEN: Array<{ id: 'now' | WindowName; label: string }> = [
  { id: 'now', label: 'Right now' },
  { id: 'weekend', label: 'Weekend' },
  { id: 'overnight', label: 'Overnight' },
  { id: 'us_session', label: 'US session' },
];

function actionText(a: GuardAction): string {
  const c = 'coin' in a ? tickerOf(a.coin) : '';
  switch (a.type) {
    case 'order':
      return `${a.isBuy ? 'Buy' : 'Sell'} ${a.size} ${c}, reduce-only (limit ${fmtPx(a.limitPx)})`;
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

/** Buffer along the path (log scale, liquidation at the bottom), with the user's lines. */
function BufferChart({ guarded, unguarded, lines }: { guarded: number[]; unguarded: number[]; lines: number[] }) {
  const W = 760;
  const H = 230;
  const L = 44;
  const finite = [...guarded, ...unguarded, ...lines].filter((b) => Number.isFinite(b) && b > 0);
  const top = Math.max(2, ...finite) * 1.1;
  const y = (b: number) => H - 22 - (Math.log(Math.max(1, Math.min(b, top))) / Math.log(top)) * (H - 40);
  const x = (i: number) => L + (i / STEPS) * (W - L - 12);
  const line = (xs: number[]) => xs.map((b, i) => `${x(i).toFixed(1)},${y(Number.isFinite(b) ? b : top).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Buffer along the path, with and without the guard">
      <line x1={L} x2={W - 12} y1={y(1)} y2={y(1)} stroke="var(--crit)" strokeWidth="1.5" />
      <text x={L - 6} y={y(1) + 4} textAnchor="end" fontSize="11" fill="var(--crit)">1.00×</text>
      {lines.map((l) => (
        <g key={l}>
          <line x1={L} x2={W - 12} y1={y(l)} y2={y(l)} stroke="var(--warn)" strokeDasharray="4 4" />
          <text x={L - 6} y={y(l) + 4} textAnchor="end" fontSize="11" fill="var(--text-2)">{l}×</text>
        </g>
      ))}
      <polyline fill="none" stroke="var(--text-2)" strokeWidth="2" strokeDasharray="6 5" points={line(unguarded)} />
      <polyline fill="none" stroke="var(--guard-g)" strokeWidth="2.5" points={line(guarded)} />
      <text x={L} y={H - 4} fontSize="11" fill="var(--text-3)">start</text>
      <text x={W - 12} y={H - 4} textAnchor="end" fontSize="11" fill="var(--text-3)">end of path</text>
    </svg>
  );
}

export default function SimulatorPage() {
  const review = useReview();
  const { address, connected } = useViewer();
  const signedIn = useSignedIn() || review.on;
  const view = useAccountView(address);
  const me = useMe();
  const g = useGuardView();
  const now = useNow();
  const fills = useFills(address);
  const [moves, setMoves] = useState<Record<string, string>>({});
  const [when, setWhen] = useState<'now' | WindowName>(review.state === 'closed' ? 'weekend' : 'now');
  const [res, setRes] = useState<{ sim: SimResult; unguarded: number[]; at: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const positions = view.data?.snapshot.positions ?? [];
  const policy = me.data?.policy?.policy;
  const loading = review.state === 'loading' || (connected && !view.data && !view.isError);
  // The user's realised fee rate across their own fills; none when they have no fills yet.
  const notional = (fills.data ?? []).reduce((s, f) => s + Number(f.px) * Number(f.sz), 0);
  const feeRate = notional ? (fills.data ?? []).reduce((s, f) => s + Number(f.fee), 0) / notional : 0;
  const typed = positions.filter((p) => moves[p.coin]?.trim());
  const bad = typed.find((p) => !(Number.isFinite(Number(moves[p.coin])) && Number(moves[p.coin]) > -100 && Number(moves[p.coin]) <= 500));
  const valid = typed.length > 0 && !bad;
  const closedNow = positions.some((p) => {
    const m = marketByCoin(p.coin);
    return m ? !homeOpen(m.session, now) : false;
  });

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

  const acted = res?.sim.steps.filter((s) => s.actions.length) ?? [];
  const forcedError = review.state === 'error';

  return (
    <div className="pg">
      <div className="ptitle">
        <h1 className="h1">Simulator</h1>
        <span className="small t2">Moves prices on your real positions and runs your signed rules through the same code the guard runs.</span>
        <span className="sp" />
        {g.exampleRules ? <span className="tag">Example rules</span> : null}
      </div>

      {when !== 'now' || closedNow ? (
        <div className="banner">
          {Icon.moon()}
          <span>
            <b>{when === 'weekend' ? 'Weekend path.' : closedNow ? 'A home market is closed now.' : 'Off-hours path.'}</b> Rules with a time window run as they would at that time. The simulator moves prices in a straight line; it does not model trade.xyz’s off-hours bounds or their re-anchors, so a real weekend can reach a line in jumps.
          </span>
        </div>
      ) : null}

      {!connected ? (
        <div className="panel">
          <div className="empty" style={{ padding: '80px 16px' }}>
            <div className="ico">{Icon.simulator(18)}</div>
            <b>No wallet connected.</b>
            <span className="small">Connect to simulate your own positions with your own rules.</span>
            <Link className="btn btn-sm btn-ink" href="/app/onboarding">
              Connect wallet
            </Link>
          </div>
        </div>
      ) : loading ? (
        <div className="grid2 lead400">
          <div className="panel pb col" style={{ gap: 14 }}>
            <span className="sk" style={{ width: '60%' }} />
            <span className="sk" style={{ width: '90%', height: 36 }} />
            <span className="sk" style={{ width: '90%', height: 36 }} />
          </div>
          <div className="panel pb">
            <div className="skb" style={{ height: 230 }} />
          </div>
        </div>
      ) : !signedIn || !policy ? (
        <div className="panel">
          <div className="empty" style={{ padding: '80px 16px' }}>
            <div className="ico">{Icon.shield(18)}</div>
            <b>No signed rules yet.</b>
            <span className="small">The simulator runs your rules; write them first.</span>
            <Link className="btn btn-sm btn-ink" href="/app/rules">
              Write rules
            </Link>
          </div>
        </div>
      ) : !positions.length ? (
        <div className="panel">
          <div className="empty" style={{ padding: '80px 16px' }}>
            <div className="ico">{Icon.positions(18)}</div>
            <b>No open positions to simulate.</b>
            <Link className="btn btn-sm" href="/app">
              Browse markets
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="grid2 lead400">
            <section className="panel" aria-label="Scenario">
              <div className="ph">
                <h2>Scenario</h2>
                <span className="sp" />
                <span className="tiny t3">nothing is pre-filled</span>
              </div>
              <div className="pb col" style={{ gap: 10 }}>
                <span className="small t2">Type a move for each market you want to test. A negative number is a fall; empty markets stay where they are.</span>
                {positions.map((p) => (
                  <div key={p.coin} className="row nw">
                    <span className="glyph">{tickerOf(p.coin).slice(0, 2)}</span>
                    <span style={{ flex: 1 }}>
                      <b>{tickerOf(p.coin)}</b> <span className={p.size > 0 ? 'long' : 'short'}>{p.size > 0 ? 'Long' : 'Short'}</span> <span className="t3 num small">at {fmtPx(p.markAtSnapshot)}</span>
                    </span>
                    <div className="input" style={{ width: 140, minHeight: 36 }}>
                      <input aria-label={`${tickerOf(p.coin)} move in percent`} inputMode="decimal" placeholder="Your move" value={moves[p.coin] ?? ''} onChange={(e) => setMoves((m) => ({ ...m, [p.coin]: e.target.value }))} />
                      <span className="unit">%</span>
                    </div>
                  </div>
                ))}
                <div className="field">
                  <label>When the move happens</label>
                  <div className="seg" role="radiogroup" aria-label="When" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gridAutoFlow: 'row' }}>
                    {WHEN.map((w) => (
                      <button key={w.id} type="button" className={when === w.id ? 'on' : ''} aria-pressed={when === w.id} onClick={() => setWhen(w.id)}>
                        {w.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="kv">
                  <span className="small">Fee rate used</span>
                  <span className="num small">{feeRate ? `${(feeRate * 100).toFixed(4)}% (your fills)` : 'none (no fills yet)'}</span>
                </div>
                <button type="button" className="btn btn-ink btn-block" disabled={!valid} onClick={run}>
                  Run the simulation
                </button>
                {forcedError || bad ? (
                  <div className="banner b-crit">
                    {Icon.alert()}
                    <span>
                      <b>Can’t run this one.</b> {bad ? `The move for ${tickerOf(bad.coin)} is ${moves[bad.coin]}%. ` : 'A move is out of range. '}Type a move between −99% and +500%.
                    </span>
                  </div>
                ) : null}
                {err ? <span className="small ct">{err}</span> : null}
                <div className="disclose">
                  {Icon.info(14)}
                  <span>Fills at the worst price your slippage allows; your real fee rate is charged. Funding and book depth are not modelled. Not a forecast.</span>
                </div>
              </div>
            </section>

            <div className="col" style={{ gap: 16 }} aria-live="polite">
              {!res ? (
                <div className="panel">
                  <div className="empty" style={{ padding: '90px 16px' }}>
                    <div className="ico">{Icon.simulator(18)}</div>
                    <b>Type a move for at least one market, then run it.</b>
                    <span className="small" style={{ maxWidth: 440 }}>
                      You’ll see the account with and without the guard, side by side, and every action the guard would take.
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid2 even">
                    <section className="panel pb col" style={{ gap: 6 }} aria-label="Without the guard">
                      <div className="row nw">
                        <b>Without the guard</b>
                        <span className="sp" />
                        <span className={`chip chip-sm ${res.sim.unguardedLiquidatedAt !== null ? 'chip-risk' : 'chip-off'}`}>{res.sim.unguardedLiquidatedAt !== null ? 'Liquidated' : 'Not liquidated'}</span>
                      </div>
                      <div className="kv line">
                        <span className="small">Liquidated</span>
                        <span className="small">{res.sim.unguardedLiquidatedAt !== null ? `${Math.round((res.sim.unguardedLiquidatedAt / STEPS) * 100)}% of the way` : 'no'}</span>
                      </div>
                      <div className="kv">
                        <span className="small">Lowest buffer</span>
                        <span className="num small">{fmtBuffer(Math.min(...res.unguarded))}</span>
                      </div>
                    </section>
                    <section className="panel pb col" style={{ gap: 6 }} aria-label="With your rules">
                      <div className="row nw">
                        <b>With your rules</b>
                        <span className="sp" />
                        {res.sim.liquidatedAt !== null ? <span className="chip chip-sm chip-risk">Liquidated</span> : <GuardChip state="protected" sm label="Not liquidated" />}
                      </div>
                      <div className="kv line">
                        <span className="small">Buffer at the end</span>
                        <span className="num small">{fmtBuffer(res.sim.final.buffer)}</span>
                      </div>
                      <div className="kv line">
                        <span className="small">Account value at the end</span>
                        <span className="num small">{fmtUsd(res.sim.final.accountValue)}</span>
                      </div>
                      <div className="kv">
                        <span className="small">Guard actions · fees</span>
                        <span className="num small">
                          {acted.reduce((s, x) => s + x.actions.length, 0)} · {fmtUsd(res.sim.feesPaid)}
                        </span>
                      </div>
                    </section>
                  </div>
                  <section className="panel">
                    <div className="ph">
                      <h2>Lowest pool buffer along the path</h2>
                      <span className="sp" />
                      <span className="row tiny t2" style={{ gap: 14 }}>
                        <span className="row nw" style={{ gap: 6 }}>
                          <span style={{ width: 18, height: 3, background: 'var(--guard-g)', display: 'inline-block' }} />
                          with your rules
                        </span>
                        <span className="row nw" style={{ gap: 6 }}>
                          <span style={{ width: 18, borderTop: '2px dashed var(--text-2)', display: 'inline-block' }} />
                          without the guard
                        </span>
                      </span>
                    </div>
                    <div className="pb">
                      <BufferChart guarded={res.sim.steps.map((s) => s.buffer)} unguarded={res.unguarded} lines={g.lines} />
                    </div>
                  </section>
                </>
              )}
            </div>
          </div>

          {res ? (
            <section className="panel">
              <div className="ph">
                <h2>What the guard did</h2>
                <span className="tiny t3">in order</span>
              </div>
              {acted.length ? (
                <div className="tblw">
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
                </div>
              ) : (
                <div className="pb small t2">Nothing fired on this path.</div>
              )}
            </section>
          ) : null}

          <section className="panel">
            <div className="ph">
              <h2>Rules simulated</h2>
              <span className="tiny t3">version {me.data?.policy?.version}</span>
            </div>
            <div className="pb col" style={{ gap: 6 }}>
              {policy.rules.map((r) => (
                <span key={r.id} className="small">
                  <span className="tag num">{r.id}</span> {describeRule(r)}
                </span>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
