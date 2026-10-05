'use client';

import type { AccountRisk, PoolRisk, PositionRisk } from '@bulwarkxyz/guard-core';
import Link from 'next/link';
import { describeAction, tickerOf, type GuardState, type GuardView } from '@/lib/guard';
import { homeOpen, marketByCoin } from '@/lib/markets';
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

export function GuardCell({ g, pool, row }: { g: GuardView; pool: PoolRisk; row: PositionRisk }) {
  const st = poolState(g, pool);
  const armed = st === 'protected' || st === 'acting' || st === 'risk';
  const lvl = armed ? g.levelFor(pool, row) : null;
  const rule = lvl ? g.rules.find((r) => r.when.kind === 'buffer' && r.when.below === lvl.line) : null;
  const what = rule ? rule.then.map(describeAction).join(', then ') : 'act';
  return (
    <div className="gs">
      <GuardChip state={st} sm label={st === 'stopped' ? 'Not protected' : st === 'paused' ? 'Paused' : undefined} />
      <div className="what">
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
        ) : armed ? (
          <span className="tiny t3">{g.lines.length ? 'No line in reach' : 'No buffer lines'}</span>
        ) : null}
      </div>
    </div>
  );
}

export function sortedRows(risk: AccountRisk) {
  return [...risk.pools].sort((a, b) => a.buffer - b.buffer).flatMap((pool) => pool.positions.map((row) => ({ pool, row })));
}

/** Positions with Hyperliquid's columns plus Buffer and Guard. */
export function PositionsTable({ g, risk, now, highlight, compact }: { g: GuardView; risk: AccountRisk; now: number; highlight?: string; compact?: boolean }) {
  const rows = sortedRows(risk);
  return (
    <div className="tblw">
      <table className="tbl">
        <thead>
          <tr>
            <th>Market</th>
            <th>Side</th>
            <th className="r">Size</th>
            {compact ? null : <th className="r">Value</th>}
            <th className="r">Entry</th>
            <th className="r">Mark</th>
            <th className="r">PnL (ROE)</th>
            <th className="r">Liq. price</th>
            {compact ? null : <th className="r">Margin · lev.</th>}
            <th style={{ minWidth: compact ? 120 : 150 }}>Buffer</th>
            <th>Guard</th>
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
            return (
              <tr key={p.key} className={highlight === p.coin ? 'sel' : ''}>
                <td>
                  <div className="sym">
                    <span className="glyph">{t.slice(0, 2)}</span>
                    <div className="col" style={{ gap: 0 }}>
                      <b>{t}</b>
                      <span className="tiny t3">{pool.pool.kind === 'isolated' ? 'isolated' : 'cross'}</span>
                    </div>
                  </div>
                </td>
                <td>
                  <span className={`chip chip-sm ${p.size > 0 ? 'chip-long' : 'chip-short'}`}>{p.size > 0 ? 'Long' : 'Short'}</span>
                </td>
                <td className="r num">
                  {Math.abs(p.size)} {t}
                </td>
                {compact ? null : <td className="r num">{fmtUsd(row.notional)}</td>}
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
                <td className="r num ct">{row.liquidationPx ? fmtPx(row.liquidationPx) : '—'}</td>
                {compact ? null : (
                  <td className="r num">
                    {fmtUsd(margin)} · {p.leverage}×
                  </td>
                )}
                <td>
                  <div className="row nw" style={{ gap: 8 }}>
                    <span className="num" style={{ width: 52 }}>
                      {fmtBuffer(pool.buffer)}
                    </span>
                    <BufferMeter size="row" buffer={pool.buffer} lines={g.lines} state={poolState(g, pool)} />
                  </div>
                </td>
                <td>
                  <GuardCell g={g} pool={pool} row={row} />
                </td>
                <td className="r">{p.dex === 'xyz' ? <Link className="btn btn-sm" href={`/app/trade/${t}`}>Trade</Link> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Phone: one card per position, riskiest pool first, with its buffer and guard state. */
export function PositionCards({ g, risk, now }: { g: GuardView; risk: AccountRisk; now: number }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      {sortedRows(risk).map(({ pool, row }) => {
        const p = row.position;
        const t = tickerOf(p.coin);
        const m = marketByCoin(p.coin);
        const off = m ? !homeOpen(m.session, now) : false;
        return (
          <article key={p.key} className="panel pb col" style={{ gap: 8 }}>
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
          </article>
        );
      })}
    </div>
  );
}
