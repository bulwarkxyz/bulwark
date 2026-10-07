'use client';

import type { AccountRisk, PoolRisk, PositionRisk } from '@bulwarkxyz/guard-core';
import Link from 'next/link';
import { NO_BACKSTOP_LINE, describeAction, marginTooLarge, noBackstopText, orderLabel, tickerOf, useGuardOrders, type GuardState, type GuardView } from '@/lib/guard';
import { homeOpen, marketByCoin } from '@/lib/markets';
import { PositionTpslButton } from './position-tpsl';
import { Tip } from './tip';
import { useViewer } from '@/lib/review';
import { closeIntent, ticketIntent } from '@/lib/ticket-intent';
import { BufferMeter, GuardChip } from './guard-ui';
import { fmtBuffer, fmtPct, fmtPx, fmtSignedUsd, fmtUsd, upDown } from './format';

/** The guard state of one pool, from the user's own lines. */
export function poolState(g: GuardView, pool: PoolRisk): GuardState {
  if (!(g.state === 'protected' || g.state === 'acting' || g.state === 'risk')) return g.state;
  if (!g.lines.length) return 'protected';
  if (pool.buffer < Math.min(...g.lines)) return 'risk';
  if (pool.buffer < Math.max(...g.lines)) return 'acting';
  return 'protected';
}

/** The pool's guard chip (stopped and paused say so in words). */
export function PoolChip({ g, pool }: { g: GuardView; pool: PoolRisk }) {
  const st = poolState(g, pool);
  return <GuardChip state={st} sm label={st === 'stopped' ? 'Not protected' : st === 'paused' ? 'Paused' : undefined} />;
}

export function GuardCell({ g, pool, row, noResting }: { g: GuardView; pool: PoolRisk; row: PositionRisk; noResting?: boolean }) {
  return (
    <div className="gs">
      <PoolChip g={g} pool={pool} />
      <GuardActsAt g={g} pool={pool} row={row} noResting={noResting} />
    </div>
  );
}

/** Where the guard acts for this position: the price of the next line (solver), and any order it has resting (API). */
export function GuardActsAt({ g, pool, row, align, noResting }: { g: GuardView; pool: PoolRisk; row: PositionRisk; align?: 'right'; noResting?: boolean }) {
  const st = poolState(g, pool);
  const armed = st === 'protected' || st === 'acting' || st === 'risk';
  const lvl = armed ? g.levelFor(pool, row) : null;
  const rule = lvl ? g.rules.find((r) => r.when.kind === 'buffer' && r.when.below === lvl.line) : null;
  const what = rule ? rule.then.map(describeAction).join(', then ') : 'act';
  // What the guard has resting on Hyperliquid for this market, as the API reports it.
  const resting = useGuardOrders(useViewer().address).forCoin(row.position.coin);
  return (
      <div className="what" style={align === 'right' ? { alignItems: 'flex-end', textAlign: 'right' } : undefined}>
        {lvl ? (
          <>
            <span className="small">
              {what.charAt(0).toUpperCase() + what.slice(1)} at <span className="num">{fmtPx(lvl.price)}</span>
            </span>
            <span className="tiny t3 num">
              {fmtPct(lvl.move * 100, 1)} · {lvl.line}×
            </span>
          </>
        ) : armed && g.lines.some((l) => pool.buffer < l) ? (
          <span className="small">{(() => {
            const line = Math.min(...g.lines.filter((l) => pool.buffer < l));
            const r = g.rules.find((x) => x.when.kind === 'buffer' && x.when.below === line);
            return `Below ${line}×: ${r ? r.then.map(describeAction).join(', then ') : 'acting'}`;
          })()}</span>
        ) : armed && marginTooLarge(g, row.position.coin) && !resting.length ? (
          <Tip className="tiny t2" text={noBackstopText(marginTooLarge(g, row.position.coin)!)}>
            {NO_BACKSTOP_LINE}
          </Tip>
        ) : armed ? (
          <span className="tiny t3">{g.lines.length ? 'No line in reach' : 'No buffer lines'}</span>
        ) : null}
        {(noResting ? [] : resting).map((o) => (
          <span key={o.oid} className="tiny t2">
            {orderLabel(o)}: resting at <span className="num">{fmtPx(o.triggerPx)}</span>
          </span>
        ))}
      </div>
  );
}

export function sortedRows(risk: AccountRisk) {
  return [...risk.pools].sort((a, b) => a.buffer - b.buffer).flatMap((pool) => pool.positions.map((row) => ({ pool, row })));
}

function CloseButton({ coin, size, here }: { coin: string; size: number; here: boolean }) {
  const t = tickerOf(coin);
  return here ? (
    <button type="button" className="btn btn-sm" onClick={() => ticketIntent.emit(closeIntent(coin, size))}>
      Close
    </button>
  ) : (
    <Link className="btn btn-sm" href={`/app/trade/${t}?close=1`}>
      Close
    </Link>
  );
}

/**
 * Positions with Hyperliquid's columns plus the pool's buffer and the guard. `compact` (the trade screen's
 * bottom panel) keeps the guard in one cell; the Positions screen splits it into state and "acts at".
 */
/** `mark`: a row to point at (a notification's link), without changing what Close does. */
export function PositionsTable({ g, risk, now, highlight, compact, mark }: { g: GuardView; risk: AccountRisk; now: number; highlight?: string; compact?: boolean; mark?: string | null }) {
  const rows = sortedRows(risk);
  return (
    <div className="tblw">
      <table className="tbl">
        <thead>
          <tr>
            <th>{compact ? 'Market' : 'Pool · market'}</th>
            <th>Side</th>
            <th className="r">Size</th>
            {compact ? <th className="r">Value</th> : null}
            <th className="r">Entry</th>
            <th className="r">Mark</th>
            <th className="r">PnL (ROE)</th>
            {compact ? <th className="r">Liq. price</th> : null}
            <th className="r">Margin · lev.</th>
            {compact ? <th className="r">Buffer</th> : <th style={{ minWidth: 150 }}>Buffer</th>}
            <th>Guard</th>
            {compact ? null : <th className="r">Guard acts at</th>}
            {compact ? null : <th className="r">Liq. price</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ pool, row }) => {
            const p = row.position;
            const t = tickerOf(p.coin);
            const m = marketByCoin(p.coin);
            const off = m ? !homeOpen(m.session, now) : false;
            const margin = p.api.marginUsed;
            const liq = <td className="r num ct">{row.liquidationPx ? fmtPx(row.liquidationPx) : '—'}</td>;
            return (
              <tr key={p.key} id={`pos-${p.coin}`} className={highlight === p.coin || mark === p.coin ? 'sel' : ''}>
                <td>
                  <div className="sym">
                    <span className="glyph">{t.slice(0, 2)}</span>
                    <div className="col" style={{ gap: 0 }}>
                      <b>{t}</b>
                      <span className="tiny t3">{pool.pool.kind === 'isolated' ? (compact ? 'isolated' : 'Isolated pool') : compact ? 'cross' : 'Cross pool'}</span>
                    </div>
                  </div>
                </td>
                <td>
                  <span className={`chip chip-sm ${p.size > 0 ? 'chip-long' : 'chip-short'}`}>{p.size > 0 ? 'Long' : 'Short'}</span>
                </td>
                <td className="r num">
                  {Math.abs(p.size)} {t}
                </td>
                {compact ? <td className="r num">{fmtUsd(row.notional)}</td> : null}
                <td className="r num">{fmtPx(p.entryPx)}</td>
                <td className="r">
                  <span className="num">{fmtPx(row.mark)}</span>
                  {off ? (
                    <>
                      <br />
                      <span className="tiny t3">off-hours price</span>
                    </>
                  ) : null}
                </td>
                <td className={`r num ${upDown(row.unrealizedPnl)}`}>
                  {fmtSignedUsd(row.unrealizedPnl)} <span className="t3">{margin > 0 ? fmtPct((row.unrealizedPnl / margin) * 100, 1) : ''}</span>
                </td>
                {compact ? liq : null}
                <td className="r num">
                  {fmtUsd(margin)} · {p.leverage}×
                </td>
                {compact ? (
                  <td className="r num">{fmtBuffer(pool.buffer)}</td>
                ) : (
                  <td>
                    <div className="row nw" style={{ gap: 8 }}>
                      <span className="num" style={{ width: 52 }}>
                        {fmtBuffer(pool.buffer)}
                      </span>
                      <BufferMeter size="row" buffer={pool.buffer} lines={g.lines} state={poolState(g, pool)} />
                    </div>
                  </td>
                )}
                {compact ? (
                  <td>
                    <GuardCell g={g} pool={pool} row={row} noResting />
                  </td>
                ) : (
                  <>
                    <td>
                      <PoolChip g={g} pool={pool} />
                    </td>
                    <td className="r">
                      <GuardActsAt g={g} pool={pool} row={row} align="right" />
                    </td>
                    {liq}
                  </>
                )}
                <td className="r">
                  {p.dex === 'xyz' ? (
                    <span className="row nw" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <PositionTpslButton coin={p.coin} size={p.size} liquidationPx={row.liquidationPx} />
                      <CloseButton coin={p.coin} size={p.size} here={highlight === p.coin} />
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Phone: one card per position, riskiest pool first, with its buffer and guard state. */
export function PositionCards({ g, risk, now, mark }: { g: GuardView; risk: AccountRisk; now: number; mark?: string | null }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      {sortedRows(risk).map(({ pool, row }) => {
        const p = row.position;
        const t = tickerOf(p.coin);
        const m = marketByCoin(p.coin);
        const off = m ? !homeOpen(m.session, now) : false;
        return (
          <article key={p.key} id={`posc-${p.coin}`} className={`panel pb col ${mark === p.coin ? 'target' : ''}`} style={{ gap: 8 }}>
            <div className="row nw">
              <span className="glyph">{t.slice(0, 2)}</span>
              <b>{t}</b>
              <span className={`chip chip-sm ${p.size > 0 ? 'chip-long' : 'chip-short'}`}>{p.size > 0 ? 'Long' : 'Short'}</span>
              <span className="num small">{Math.abs(p.size)}</span>
              <span className="sp" />
              <span className={`num small ${upDown(row.unrealizedPnl)}`}>{fmtSignedUsd(row.unrealizedPnl)}</span>
            </div>
            <div className="row nw" style={{ gap: 8 }}>
              <span className="num small" style={{ width: 52 }}>
                {fmtBuffer(pool.buffer)}
              </span>
              <BufferMeter size="row" buffer={pool.buffer} lines={g.lines} state={poolState(g, pool)} />
            </div>
            <div className="row nw" style={{ justifyContent: 'space-between' }}>
              <GuardCell g={g} pool={pool} row={row} />
              <span className="tiny">
                Liq. <span className="num ct">{row.liquidationPx ? fmtPx(row.liquidationPx) : '—'}</span>
              </span>
            </div>
            <div className="row nw" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="row tiny t3">
                <span>
                  Entry <span className="num">{fmtPx(p.entryPx)}</span>
                </span>
                <span>
                  Mark <span className="num">{fmtPx(row.mark)}</span>
                  {off ? ' (off-hours)' : ''}
                </span>
                <span>
                  <span className="num">{fmtUsd(p.api.marginUsed)}</span> · {p.leverage}× · {pool.pool.kind === 'isolated' ? 'isolated' : 'cross'}
                </span>
              </div>
              {p.dex === 'xyz' ? (
                <span className="row nw" style={{ gap: 6 }}>
                  <PositionTpslButton coin={p.coin} size={p.size} liquidationPx={row.liquidationPx} />
                  <CloseButton coin={p.coin} size={p.size} here={false} />
                </span>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
