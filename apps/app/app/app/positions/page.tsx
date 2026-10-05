'use client';

import Link from 'next/link';
import { useState } from 'react';
import { fmtBuffer, fmtPct, fmtPx, fmtSignedUsd, upDown } from '@/components/app/format';
import { BufferMeter, GuardChip } from '@/components/app/guard-ui';
import { Icon } from '@/components/app/icons';
import { PositionCards, PositionsTable, poolState } from '@/components/app/positions-table';
import { useSignedIn } from '@/lib/api';
import { useCommand } from '@/lib/commands';
import { STATE_STALE_MS, describeAction, nextWindowOpen, TOGETHER_NOTE, orderLabel, tickerOf, useGuardOrders, useGuardView, useNow } from '@/lib/guard';
import { useAccountView, useFills } from '@/lib/hl';
import { homeOpen, marketByCoin } from '@/lib/markets';
import { useMe } from '@/lib/me';
import { useReview, useViewer } from '@/lib/review';
import { useTimes } from '@/lib/time';

export default function PositionsPage() {
  const review = useReview();
  const { address, connected } = useViewer();
  const signedIn = useSignedIn();
  const view = useAccountView(address);
  const me = useMe();
  const g = useGuardView();
  const now = useNow();
  const orders = useGuardOrders(address);
  const times = useTimes();
  const command = useCommand();
  const [minutes, setMinutes] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const minutesN = Number(minutes);

  const risk = view.data?.risk;
  const loading = review.state === 'loading' || (connected && !risk && !view.isError);
  const paused = g.state === 'paused';
  const nPos = risk?.pools.reduce((s, p) => s + p.positions.length, 0) ?? 0;
  const closedMarkets = (risk?.pools ?? []).flatMap((p) => p.positions).filter((r) => {
    const m = marketByCoin(r.position.coin);
    return m ? !homeOpen(m.session, now) : false;
  });
  const worst = g.worst;
  const worstRow = worst?.positions.reduce((a, b) => (Math.abs(a.notional) >= Math.abs(b.notional) ? a : b));
  // Rules that run in a fixed window, soonest first (null: the window is open now).
  const byTime = g.rules
    .filter((r) => r.window)
    .map((r) => ({ does: r.then.map(describeAction).join(', then '), at: nextWindowOpen(r.window!, now) }))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const [showClosed, setShowClosed] = useState(false);
  const fills = useFills(address);
  const dayStart = (() => {
    const d = new Date(now);
    return times.utc ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  })();
  const closedToday = (fills.data ?? []).filter((f) => f.time >= dayStart && f.dir.startsWith('Close'));
  const doesAt = (line: number) => {
    const r = g.rules.find((x) => x.when.kind === 'buffer' && x.when.below === line);
    return r ? r.then.map(describeAction).join(', ') : '';
  };

  async function unwind() {
    setBusy(true);
    setMsg(null);
    try {
      await command('unwind', minutesN);
      setMsg({ ok: true, text: `Unwind sent. The guard will close every position in slices over ${minutesN} minutes.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pg">
      <div className="ptitle">
        <h1 className="h1">Positions</h1>
        <span className="small t2">{!connected ? 'Not connected' : loading ? 'Loading…' : `${nPos} position${nPos === 1 ? '' : 's'} · ${risk?.pools.length ?? 0} margin pool${risk?.pools.length === 1 ? '' : 's'} · ${risk?.mode === 'unified' ? 'unified account' : risk?.mode === 'standard' ? 'standard account' : (risk?.mode ?? '')}`}</span>
        <span className="sp" />
        {g.exampleRules ? <span className="tag">Example rules</span> : null}
      </div>

      {paused ? (
        <div className="banner b-crit">
          {Icon.alert()}
          <span>
            <b>The guard is paused. {g.source === 'guard' ? (g.reasonText ?? '') : g.ageMs !== null && g.ageMs > STATE_STALE_MS ? `Account data is ${Math.round(g.ageMs / 1000)} s old.` : 'The app can’t reach Hyperliquid’s data.'}</b> It will not act on stale numbers and resumes by itself when fresh data arrives. Its resting backstop orders stay on Hyperliquid and still fill. If you need to act now, use Unwind or close a position yourself.
          </span>
        </div>
      ) : null}
      {closedMarkets.length && !paused ? (
        <div className="banner">
          {Icon.moon()}
          <span>
            <b>Home market closed for {[...new Set(closedMarkets.map((r) => tickerOf(r.position.coin)))].join(', ')}.</b> Those positions mark on trade.xyz’s off-hours price, held within each market’s bound. The guard keeps watching. A gap at the reopen can jump past a line, which is why the backstops below rest on Hyperliquid.
          </span>
        </div>
      ) : null}
      {risk && !risk.supported ? (
        <div className="banner b-warn">
          <span>This account uses portfolio margin. Bulwark shows it read-only and the guard does not act on it.</span>
        </div>
      ) : null}

      {!connected ? (
        <div className="panel">
          <div className="empty" style={{ padding: '80px 16px' }}>
            <div className="ico">{Icon.positions(18)}</div>
            <b>No wallet connected.</b>
            <span className="small">Connect to see your positions, each with its guard state and the price at which the guard acts.</span>
            <Link className="btn btn-sm btn-ink" href="/app/onboarding">
              Connect wallet
            </Link>
          </div>
        </div>
      ) : loading ? (
        <>
          <div className="panel pb col" style={{ gap: 16 }}>
            <span className="sk" style={{ width: '40%', height: 28 }} />
            <span className="sk" style={{ width: '100%', height: 12 }} />
          </div>
          <div className="panel pb col" style={{ gap: 20 }}>
            <span className="sk" style={{ width: '96%' }} />
            <span className="sk" style={{ width: '92%' }} />
            <span className="sk" style={{ width: '94%' }} />
          </div>
        </>
      ) : !nPos ? (
        <div className="panel">
          <div className="empty" style={{ padding: '80px 16px' }}>
            <div className="ico">{Icon.positions(18)}</div>
            <b>No open positions.</b>
            <span className="small" style={{ maxWidth: 460 }}>
              {g.lines.length ? 'Your rules are signed. The guard starts watching the moment you open a position, and each position will show its guard state here.' : 'Open a position, then write your rules so the guard can watch it.'}
            </span>
            <div className="row" style={{ justifyContent: 'center' }}>
              <Link className="btn btn-sm btn-ink" href="/app">
                Browse markets
              </Link>
              <Link className="btn btn-sm" href="/app/rules">
                {g.lines.length ? 'Review rules' : 'Write rules'}
              </Link>
            </div>
          </div>
        </div>
      ) : risk ? (
        <>
          {/* Phones: the buffer in one compact card. */}
          <section className="panel pb col mobile-only" aria-label="Account buffer" style={{ gap: 10 }}>
            <div className="row nw" style={{ justifyContent: 'space-between' }}>
              <GuardChip state={worst ? poolState(g, worst) : g.state} />
              <span className="num" style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-.03em' }}>
                {worst ? fmtBuffer(worst.buffer) : '—'}
              </span>
            </div>
            <BufferMeter buffer={worst?.buffer ?? null} lines={g.lines} state={worst ? poolState(g, worst) : g.state} labels does={doesAt} />
            <div className="kv line">
              <span className="small">{g.crossed ? 'Guard now' : 'Next by price'}</span>
              <span className="small" style={{ textAlign: 'right' }}>
                {g.crossed ? `below ${g.crossed.line}× on ${g.crossed.ticker}: ${g.crossed.does}` : g.next ? <>{g.next.does} · {g.next.ticker} <span className="num">{fmtPx(g.next.price)}</span> <span className="num t3">{fmtPct(g.next.move * 100, 1)}</span></> : g.lines.length ? 'no line within reach' : 'no lines'}
              </span>
            </div>
            {byTime.length ? (
              <div className="kv">
                <span className="small">Next by time</span>
                <span className="small" style={{ textAlign: 'right' }}>
                  {byTime[0]!.does} · {byTime[0]!.at === null ? 'window open now' : `${times.fmt(byTime[0]!.at)} ${times.label}`}
                </span>
              </div>
            ) : null}
          </section>
          <section className="panel hide-sm" aria-label="Account buffer">
            <div className="ph">
              <h2>Account buffer</h2>
              <span className="tiny t3">the lowest pool sets it · liquidation at 1.00×</span>
              <span className="sp" />
              <Link className="btn btn-sm" href="/app/rules">
                {g.lines.length ? 'Edit lines' : 'Set lines'}
              </Link>
            </div>
            <div className="pb bufgrid">
              <div className="col" style={{ gap: 4 }}>
                <span className="num" style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-.03em' }}>
                  {worst ? fmtBuffer(worst.buffer) : '—'}
                </span>
                <span className="small t2">
                  {worstRow ? `${tickerOf(worstRow.position.coin)}${worst && worst.positions.length > 1 ? ` + ${worst.positions.length - 1} more` : ''} pool` : ''}
                  {worst && Number.isFinite(worst.ratio) ? ` · margin ratio ${(worst.ratio * 100).toFixed(1)}%` : ''}
                </span>
                <span style={{ marginTop: 4 }}>
                  <GuardChip state={worst ? poolState(g, worst) : g.state} />
                </span>
              </div>
              <div style={{ paddingTop: 6 }}>
                <BufferMeter buffer={worst?.buffer ?? null} lines={g.lines} state={worst ? poolState(g, worst) : g.state} labels does={doesAt} />
                {!g.lines.length ? <span className="tiny t3">No lines yet: the meter shows only liquidation. Your lines appear here when you add rules.</span> : null}
              </div>
              <div className="col" style={{ gap: 0 }}>
                <div className="kv line">
                  <span className="small">{g.crossed ? 'Guard now' : 'Next by price'}</span>
                  <span className="small" style={{ textAlign: 'right' }}>
                    {g.crossed ? (
                      <span className={g.state === 'risk' ? 'ct' : 'wt'}>
                        below {g.crossed.line}× on {g.crossed.ticker}: {g.crossed.does}
                      </span>
                    ) : g.next ? (
                      <>
                        {g.next.does} · {g.next.ticker} <span className="num">{fmtPx(g.next.price)}</span> <span className="num t3">{fmtPct(g.next.move * 100, 1)}</span>
                      </>
                    ) : (
                      <span className="t2">{g.lines.length ? 'no line within reach' : 'no lines'}</span>
                    )}
                  </span>
                </div>
                {byTime.length ? (
                  <div className="kv line">
                    <span className="small">Next by time</span>
                    <span className="small" style={{ textAlign: 'right' }}>
                      {byTime[0]!.does} · {byTime[0]!.at === null ? <span className="wt">window open now</span> : <span className="num">{times.fmt(byTime[0]!.at)} {times.label}</span>}
                    </span>
                  </div>
                ) : null}
                <div className="kv">
                  <span className="small">Without the guard</span>
                  <span className="small">
                    {worstRow?.liquidationPx ? (
                      <>
                        {tickerOf(worstRow.position.coin)} liquidates at <span className="num ct">{fmtPx(worstRow.liquidationPx)}</span>{' '}
                        <span className="num t3">{fmtPct(((worstRow.liquidationPx - worstRow.mark) / worstRow.mark) * 100, 1)}</span>
                      </>
                    ) : (
                      <span className="t2">no liquidation price</span>
                    )}
                  </span>
                </div>
              </div>
            </div>
          </section>

          <div className="mobile-only col" style={{ gap: 10 }}>
            <b>By margin pool, riskiest first</b>
            <PositionCards g={g} risk={risk} now={now} />
          </div>
          <section className="panel hide-sm" aria-label="Positions by margin pool">
            <div className="ph">
              <h2>By margin pool, riskiest first</h2>
              <span className="sp" />
              <label className="row nw small t2" style={{ gap: 6 }}>
                <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
                Show closed today
              </label>
              <span className="tiny t3">
                Unrealised{' '}
                <span className={`num ${upDown(risk.pools.reduce((s, p) => s + p.positions.reduce((t, r) => t + r.unrealizedPnl, 0), 0))}`}>
                  {fmtSignedUsd(risk.pools.reduce((s, p) => s + p.positions.reduce((t, r) => t + r.unrealizedPnl, 0), 0))}
                </span>
              </span>
            </div>
            <PositionsTable g={g} risk={risk} now={now} />
            {showClosed ? (
              closedToday.length ? (
                <div className="tblw" style={{ borderTop: '1px solid var(--line)' }}>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Closed today ({times.label})</th>
                        <th>Market</th>
                        <th>Direction</th>
                        <th className="r">Price</th>
                        <th className="r">Size</th>
                        <th className="r">Closed PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {closedToday.map((f, i) => (
                        <tr key={`${f.time}-${i}`}>
                          <td className="num">{times.fmt(f.time, 'clock')}</td>
                          <td>
                            <b>{tickerOf(f.coin)}</b>
                          </td>
                          <td>{f.dir}</td>
                          <td className="r num">{fmtPx(Number(f.px))}</td>
                          <td className="r num">{f.sz}</td>
                          <td className={`r num ${upDown(Number(f.closedPnl))}`}>{fmtSignedUsd(Number(f.closedPnl))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="pb small t2" style={{ borderTop: '1px solid var(--line)' }}>Nothing closed today.</div>
              )
            ) : null}
          </section>

          <div className="grid2 even">
            <section className="panel" aria-label="The guard's resting orders">
              <div className="ph">
                <h2>The guard’s resting orders</h2>
                <span className="tiny t3">{orders.example ? 'example, from the example rules' : 'reduce-only, on Hyperliquid'}</span>
              </div>
              {!signedIn && !review.on ? (
                <div className="pb small t2">Sign in to see the guard’s orders.</div>
              ) : orders.orders.length ? (
                <>
                <ul className="mobile-only plist">
                  {orders.orders.map((o) => (
                    <li key={o.oid} className="row nw" style={{ justifyContent: 'space-between', flexDirection: 'row' }}>
                      <span className="small">
                        {tickerOf(o.coin)} · {orderLabel(o).toLowerCase()}
                      </span>
                      <span className="num small">
                        {fmtPx(o.triggerPx)} · {Math.abs(o.size)} {tickerOf(o.coin)}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="tblw hide-sm">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Market</th>
                        <th>Order</th>
                        <th className="r">Trigger</th>
                        <th className="r">Size</th>
                        <th className="r">Placed ({times.label})</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.orders.map((o) => (
                        <tr key={o.oid}>
                          <td>
                            <b>{tickerOf(o.coin)}</b>
                          </td>
                          <td style={{ whiteSpace: 'normal' }}>{orderLabel(o)} · reduce-only{o.pricing === 'together' ? <span className="tiny t3" style={{ display: 'block' }}>{TOGETHER_NOTE}</span> : null}</td>
                          <td className="r num">{fmtPx(o.triggerPx)}</td>
                          <td className="r num">{Math.abs(o.size)}</td>
                          <td className="r num">{times.fmt(o.placedAt, 'short')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                </>
              ) : (
                <div className="pb small t2">{orders.error ? `Can’t load the guard’s orders: ${orders.error.message}` : me.data?.policy ? 'None resting right now.' : 'No rules yet, so no backstops.'}</div>
              )}
              <div className="pb tiny t3" style={{ borderTop: '1px solid var(--line)' }}>
                They rest on Hyperliquid, so they fill even if Bulwark’s engine is offline.
              </div>
            </section>

            <section className="panel" aria-label="Unwind everything">
              <div className="ph">
                <h2>Unwind everything</h2>
                <span className="tiny t3">your command, signed in your wallet</span>
              </div>
              <div className="pb col" style={{ gap: 10 }}>
                <span className="small t2">Closes every position with reduce-only orders, in equal slices over the time you type, from 5 minutes to 7 days.</span>
                <div className="row nw unwind-row" style={{ alignItems: 'flex-end' }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label htmlFor="unwind-min">Over how many minutes</label>
                    <div className="input">
                      <input id="unwind-min" inputMode="numeric" placeholder="Your number, 5 to 10080" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
                      <span className="unit">min</span>
                    </div>
                  </div>
                  <button type="button" className="btn btn-crit" disabled={busy || !signedIn || !me.data?.user || !(minutesN >= 5 && minutesN <= 10080)} onClick={unwind}>
                    {busy ? 'Waiting for signature…' : 'Unwind…'}
                  </button>
                </div>
                {!me.data?.user ? <span className="tiny t3">Finish setup to use the unwind.</span> : null}
                {msg ? <span className={`small ${msg.ok ? '' : 'ct'}`}>{msg.text}</span> : null}
                <div className="disclose">
                  {Icon.shield(14)}
                  <span>
                    <b>Reduce-only is enforced by our engine, not by Hyperliquid.</b> The guard key cannot withdraw.
                  </span>
                </div>
              </div>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
