'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { fmtPct, fmtPx, fmtUsd, upDown } from '@/components/app/format';
import { Icon } from '@/components/app/icons';
import { TopBar } from '@/components/app/shell';
import { BUILDER_ON, NETWORK } from '@/lib/env';
import { realisedFeeBps, useFills, useXyzMarkets, type MarketCtx } from '@/lib/hl';
import { MARKETS, homeOpen, sessionLabel, type Category, type Market } from '@/lib/markets';

const CATS: Array<'All' | Category> = ['All', 'Commodities', 'Indices', 'Stocks'];

function MarketDetail({ m, ctx }: { m: Market; ctx: MarketCtx | undefined }) {
  const { address } = useAccount();
  const fills = useFills(address);
  const now = Date.now();
  const open = homeOpen(m.session, now);
  const paid = realisedFeeBps(fills.data, m.coin);
  return (
    <aside className="card" aria-label={`${m.ticker} details`}>
      <div className="card-h">
        <span className="glyph">{m.ticker.slice(0, 2)}</span>
        <div>
          <h2>
            {m.ticker} · {m.name}
          </h2>
          <span className="faint" style={{ fontSize: 12 }}>
            {m.coin} · perpetual
          </span>
        </div>
      </div>
      <div className="card-b stack" style={{ gap: 14 }}>
        <div className="row" style={{ alignItems: 'baseline', gap: 12 }}>
          <span className="big num">{ctx ? fmtPx(ctx.mark) : '—'}</span>
          {ctx ? <span className={`num ${upDown(ctx.change)}`}>{fmtPct(ctx.change * 100)}</span> : null}
        </div>
        <div className="row">
          <span className={`chip ${open ? 'chip-guard' : ''}`}>
            <i />
            {open ? 'Oracle: external feed' : 'Oracle: off-hours price'}
          </span>
          <span className="chip">
            <i />
            {sessionLabel(m.session, now)}
          </span>
        </div>
        <div>
          <div className="kv">
            <span>Funding</span>
            <span className="num">{ctx ? `${fmtPct(ctx.fundingAprPct, 1, false)} APR · ${ctx.fundingAprPct >= 0 ? 'longs pay' : 'shorts pay'}` : '—'}</span>
          </div>
          <div className="kv">
            <span>Max leverage</span>
            <span className="num">{ctx ? `${ctx.maxLeverage}×` : '—'}</span>
          </div>
          <div className="kv">
            <span>Margin mode</span>
            <span>{ctx ? (ctx.onlyIsolated ? 'Isolated only' : 'Cross or isolated') : '—'}</span>
          </div>
          {m.bound ? (
            <div className="kv">
              <span>Off-hours price bound</span>
              <span className="num">
                ±{m.bound.pct}% · {m.bound.resets} reset{m.bound.resets > 1 ? 's' : ''}
              </span>
            </div>
          ) : null}
          <div className="kv">
            <span>Your fee rate paid here</span>
            <span className="num">{paid === null ? 'no fills yet' : `${paid.toFixed(2)} bps`}</span>
          </div>
          <div className="kv">
            <span>Our fee (builder code)</span>
            <span className="num">{BUILDER_ON ? '3 bps' : 'none yet'}</span>
          </div>
        </div>
        <Link className="btn btn-primary" href={`/app/trade/${m.ticker}`}>
          Trade {m.ticker} with the guard
        </Link>
        <span className="faint" style={{ fontSize: 12 }}>
          Sessions and bounds: <a className="link" href="https://docs.trade.xyz/perpetuals/specifications-and-schedules/specification-index.md">trade.xyz spec index</a>. {NETWORK === 'testnet' ? 'Testnet data.' : ''}
        </span>
      </div>
    </aside>
  );
}

export default function MarketsPage() {
  const markets = useXyzMarkets();
  const [cat, setCat] = useState<(typeof CATS)[number]>('All');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(MARKETS[0]!.coin);
  const rows = useMemo(
    () => MARKETS.filter((m) => (cat === 'All' || m.category === cat) && `${m.ticker} ${m.name}`.toLowerCase().includes(q.toLowerCase())).filter((m) => markets.data?.get(m.coin)?.delisted !== true),
    [cat, q, markets.data],
  );
  const now = Date.now();
  const anyClosed = MARKETS.some((m) => m.category !== 'Commodities' && !homeOpen(m.session, now));
  const selected = MARKETS.find((m) => m.coin === sel) ?? MARKETS[0]!;

  return (
    <>
      <TopBar title="Markets">
        <span className="chip hide-sm">HIP-3 · trade.xyz</span>
        <label className="input hide-sm" style={{ minHeight: 38, width: 260 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input type="search" placeholder="Search oil, gold, NVDA…" aria-label="Search markets" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </TopBar>
      <div className="content" style={{ maxWidth: 'none' }}>
        {anyClosed ? (
          <div className="callout" style={{ alignItems: 'center' }}>
            <span style={{ color: 'var(--text-2)', display: 'flex' }}>{Icon.clock()}</span>
            <span className="muted">
              <b style={{ color: 'var(--text)' }}>Some home markets are closed.</b> Those perps keep trading on trade.xyz’s off-hours price within set bounds. Your guard stays armed.
            </span>
          </div>
        ) : null}
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="seg" role="tablist" aria-label="Category" style={{ width: 'min(520px, 100%)' }}>
            {CATS.map((c) => (
              <button key={c} type="button" role="tab" aria-selected={cat === c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>
                {c}
              </button>
            ))}
          </div>
          <span className="faint hide-sm">Live from Hyperliquid · refreshes every 5 s</span>
        </div>
        <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1fr) 340px' }}>
          <div className="card tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Market</th>
                  <th className="r">Mark</th>
                  <th className="r">24h</th>
                  <th className="r hide-sm">Funding APR</th>
                  <th className="r hide-sm">Open interest</th>
                  <th className="hide-sm">Home market</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const c = markets.data?.get(m.coin);
                  return (
                    <tr key={m.coin} className={sel === m.coin ? 'sel' : ''} onClick={() => setSel(m.coin)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div className="sym">
                          <span className="glyph">{m.ticker.slice(0, 2)}</span>
                          <div>
                            <b>{m.ticker}</b>
                            <div className="faint" style={{ fontSize: 12 }}>
                              {m.name}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="r num">{c ? fmtPx(c.mark) : <span className="skeleton" style={{ display: 'inline-block', width: 60 }} />}</td>
                      <td className={`r num ${c ? upDown(c.change) : ''}`}>{c ? fmtPct(c.change * 100) : ''}</td>
                      <td className={`r num hide-sm ${c && c.fundingAprPct < 0 ? 'down' : ''}`}>{c ? fmtPct(c.fundingAprPct, 1, false) : ''}</td>
                      <td className="r num hide-sm">{c ? fmtUsd(c.openInterestUsd) : ''}</td>
                      <td className="hide-sm">
                        <span className={`chip ${homeOpen(m.session, now) ? 'chip-guard' : ''}`}>
                          <i />
                          {sessionLabel(m.session, now)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {markets.isError ? <div className="card-b err">Could not load markets from Hyperliquid. Retrying.</div> : null}
          </div>
          <MarketDetail m={selected} ctx={markets.data?.get(selected.coin)} />
        </div>
      </div>
    </>
  );
}
