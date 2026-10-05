'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { fmtPct, fmtPx, fmtUsd, upDown } from '@/components/app/format';
import { GuardChip } from '@/components/app/guard-ui';
import { Icon } from '@/components/app/icons';
import { poolState } from '@/components/app/positions-table';
import { BUILDER_ON, NETWORK } from '@/lib/env';
import { useGuardView, useNow } from '@/lib/guard';
import { realisedFeeBps, useAccountView, useFills, useMarketActivity, useXyzMarkets, type MarketCtx } from '@/lib/hl';
import { readLastMarket } from '@/lib/last-market';
import { MARKETS, homeOpen, sessionLabel, type Category, type Market, MARKETS_SOURCE, defaultMarket, hasData } from '@/lib/markets';
import { useReview, useViewer } from '@/lib/review';
import { useTimes } from '@/lib/time';

const CATS: Array<'All' | Category> = ['All', 'Commodities', 'Indices', 'Stocks'];
const SPEC = MARKETS_SOURCE.url;

function Testnet() {
  return NETWORK === 'testnet' ? <span className="tag tag-net">testnet</span> : null;
}

function noData(c: MarketCtx | undefined) {
  return !c || c.delisted;
}

function Detail({ m, ctx, now, position }: { m: Market; ctx: MarketCtx | undefined; now: number; position: React.ReactNode }) {
  const { utc } = useTimes();
  const { address } = useViewer();
  const fills = useFills(address);
  const paid = realisedFeeBps(fills.data, m.coin);
  const open = homeOpen(m.session, now);
  return (
    <aside className="panel" aria-label={`${m.ticker} details`}>
      <div className="ph" style={{ minHeight: 56 }}>
        <span className="glyph">{m.ticker.slice(0, 2)}</span>
        <div className="col" style={{ gap: 0 }}>
          <b>
            {m.ticker} · {m.name}
          </b>
          <span className="tiny t3">{m.coin} · perpetual</span>
        </div>
      </div>
      <div className="pb col" style={{ gap: 12 }}>
        {ctx && !ctx.delisted ? (
          <div className="row" style={{ alignItems: 'baseline', gap: 10 }}>
            <span className="num big">{fmtPx(ctx.mark)}</span>
            <span className={`num ${upDown(ctx.change)}`}>{fmtPct(ctx.change * 100)}</span>
          </div>
        ) : ctx?.delisted ? (
          <span className="small t2">Delisted{NETWORK === 'testnet' ? ' on testnet; it trades on mainnet' : ''}.</span>
        ) : (
          <span className="sk" style={{ width: 140, height: 26 }} />
        )}
        <div className="row">
          <span className="chip chip-sm">
            {open ? null : Icon.moon(12)}
            {sessionLabel(m.session, now, utc)}
          </span>
          <span className="chip chip-sm">{open ? 'Oracle: external price' : 'Oracle: trade.xyz off-hours price'}</span>
        </div>
        <div>
          <div className="kv line">
            <span>Funding / 1h</span>
            <span className="num">{ctx ? `${ctx.fundingHourlyPct.toFixed(4)}%` : '—'}</span>
          </div>
          <div className="kv line">
            <span>Max leverage</span>
            <span className="num">{ctx ? `${ctx.maxLeverage}×` : '—'}</span>
          </div>
          <div className="kv line">
            <span>Margin mode</span>
            <span>{ctx ? (ctx.onlyIsolated ? 'Isolated only' : 'Cross or isolated') : '—'}</span>
          </div>
          <div className="kv line">
            <span>Off-hours bound</span>
            <span className="num">{m.bound ? `±${m.bound.pct}% · ${m.bound.resets} reset${m.bound.resets > 1 ? 's' : ''}` : 'not published'}</span>
          </div>
          <div className="kv line">
            <span>Your fee rate on {m.ticker}</span>
            <span className="num">{paid === null ? 'no fills yet' : `${(paid / 100).toFixed(4)}%`}</span>
          </div>
          <div className="kv">
            <span>Bulwark fee</span>
            <span className="num">{BUILDER_ON ? '0.03% · 3 bps' : 'none on testnet'}</span>
          </div>
        </div>
        {position}
        <Link className="btn btn-ink btn-block" href={`/app/trade/${m.ticker}`}>
          Trade {m.ticker}
        </Link>
        <span className="tiny t3">
          Sessions and bounds: <a href={SPEC} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>trade.xyz specification index</a>, checked 5 Oct 2026. Margin mode and leverage are read live from Hyperliquid. <a href={MARKETS_SOURCE.all} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>All sources</a>
        </span>
      </div>
    </aside>
  );
}

export default function MarketsPage() {
  const review = useReview();
  const markets = useXyzMarkets();
  const { address } = useViewer();
  const view = useAccountView(address);
  const g = useGuardView();
  const now = useNow();
  const { utc } = useTimes();
  const [cat, setCat] = useState<(typeof CATS)[number]>('All');
  const [q, setQ] = useState('');
  // Review "empty": a search that finds nothing (the review state is read from the URL after mount).
  useEffect(() => {
    if (review.state === 'empty') setQ('copper');
  }, [review.state]);
  const [sel, setSel] = useState(MARKETS[0]!.coin);
  const activity = useMarketActivity();
  const [picked, setPicked] = useState(false);
  // Until the visitor picks one, the detail shows the market the trade screen would open (one with data).
  useEffect(() => {
    if (!picked && activity.data) setSel(defaultMarket(activity.data, NETWORK, Date.now(), readLastMarket()).coin);
  }, [activity.data, picked]);
  const quiet = (coin: string, c: MarketCtx | undefined) => Boolean(activity.data && c && !c.delisted && !hasData(activity.data[coin], Date.now()));
  const loading = review.state === 'loading' || (!markets.data && !markets.isError);
  const stale = review.state === 'error' || markets.isError;
  const rows = useMemo(() => MARKETS.filter((m) => (cat === 'All' || m.category === cat) && `${m.ticker} ${m.name} ${(m.aliases ?? []).join(' ')}`.toLowerCase().includes(q.toLowerCase())), [cat, q]);
  const closed = MARKETS.filter((m) => !homeOpen(m.session, now));
  const selected = MARKETS.find((m) => m.coin === sel) ?? MARKETS[0]!;

  const posFor = (coin: string) => {
    for (const pool of view.data?.risk.pools ?? []) for (const row of pool.positions) if (row.position.coin === coin) return { pool, row };
    return null;
  };
  const youCell = (coin: string) => {
    const p = posFor(coin);
    if (!p) return null;
    return (
      <span className="row nw" style={{ gap: 6 }}>
        <GuardChip state={poolState(g, p.pool)} sm />
        <span className={`tiny ${p.row.position.size > 0 ? 'long' : 'short'}`}>{p.row.position.size > 0 ? 'Long' : 'Short'}</span>
      </span>
    );
  };

  return (
    <div className="pg">
      <div className="ptitle">
        <h1 className="h1">Markets</h1>
        <span className="chip chip-sm">HIP-3 · trade.xyz</span>
        <label className="input" style={{ minHeight: 36, width: 'min(320px, 100%)' }}>
          {Icon.search(14)}
          <input type="search" placeholder="Search oil, gold, NVDA…" aria-label="Search markets" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="seg" role="tablist" aria-label="Category" style={{ width: 'min(400px, 100%)' }}>
          {CATS.map((c) => (
            <button key={c} type="button" role="tab" aria-selected={cat === c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>
              {c}
            </button>
          ))}
        </div>
        <span className="sp" />
        <span className="small t3 hide-sm">{stale ? 'Not updating · retrying every 5 s' : loading ? 'Loading from Hyperliquid…' : 'Live from Hyperliquid · every 5 s'}</span>
      </div>

      {stale ? (
        <div className="banner b-crit">
          {Icon.alert()}
          <span>
            <b>Can’t load markets from Hyperliquid.</b> Showing the last prices received, if any. The app retries every 5 s.
          </span>
          <span className="sp" />
          <button type="button" className="btn btn-sm" onClick={() => markets.refetch()}>
            Retry now
          </button>
        </div>
      ) : null}
      {closed.length ? (
        <div className="banner">
          {Icon.moon()}
          <span>
            <b>{closed.length === MARKETS.length ? 'Every home market is closed.' : `Home market closed for ${closed.map((m) => m.ticker).join(', ')}.`}</b> Those perps keep trading on trade.xyz’s off-hours prices, each held within its bound until the home market reopens. Books are thinner. The guard keeps watching and acts on the same mark.
          </span>
        </div>
      ) : null}

      <div className="grid2 w340">
        <div className="panel">
          {loading ? (
            <div className="pb col" style={{ gap: 22, padding: '18px 14px' }}>
              {Array.from({ length: 8 }, (_, i) => (
                <span key={i} className="sk" style={{ width: `${86 + ((i * 3) % 10)}%` }} />
              ))}
            </div>
          ) : !rows.length ? (
            <div className="empty" style={{ padding: '80px 16px' }}>
              <div className="ico">{Icon.markets(18)}</div>
              <b>No market matches “{q}”.</b>
              <span className="small">Bulwark lists trade.xyz’s stock, index and commodity perps. Try “oil”, “gold” or a ticker.</span>
              <button type="button" className="btn btn-sm" onClick={() => setQ('')}>
                Clear search
              </button>
            </div>
          ) : (
            <>
              <div className="tblw hide-sm">
                <table className="tbl" style={{ fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th>Market</th>
                      <th className="r">Last price</th>
                      <th className="r">24h change</th>
                      <th className="r">24h volume</th>
                      <th className="r">Open interest</th>
                      <th className="r">Funding / 1h</th>
                      <th className="r">Max lev.</th>
                      <th>Home market</th>
                      <th>You</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => {
                      const c = markets.data?.get(m.coin);
                      const open = homeOpen(m.session, now);
                      return (
                        <tr key={m.coin} className={sel === m.coin ? 'sel' : ''} onClick={() => (setSel(m.coin), setPicked(true))} style={{ cursor: 'pointer' }}>
                          <td>
                            <Link className="sym" href={`/app/trade/${m.ticker}`} onClick={(e) => e.stopPropagation()}>
                              <span className="glyph">{m.ticker.slice(0, 2)}</span>
                              <span className="col" style={{ gap: 0 }}>
                                <b>{m.ticker}</b>
                                <span className="tiny t3">{c?.delisted ? `${m.name} · delisted${NETWORK === 'testnet' ? ' on testnet' : ''}` : quiet(m.coin, c) ? `${m.name} · no recent trades on ${NETWORK}` : m.name}</span>
                              </span>
                            </Link>
                          </td>
                          <td className="r num">{noData(c) ? '—' : fmtPx(c!.mark)}</td>
                          <td className={`r num ${c && !c.delisted ? upDown(c.change) : 't3'}`}>{noData(c) ? '—' : fmtPct(c!.change * 100)}</td>
                          <td className="r num">{noData(c) ? '—' : c!.dayVolumeUsd > 0 ? fmtUsd(c!.dayVolumeUsd) : NETWORK === 'testnet' ? 'no trades' : fmtUsd(0)}</td>
                          <td className="r num">{noData(c) ? '—' : fmtUsd(c!.openInterestUsd)}</td>
                          <td className="r num">{noData(c) ? '—' : `${c!.fundingHourlyPct.toFixed(4)}%`}</td>
                          <td className="r num">{c ? `${c.maxLeverage}×` : '—'}</td>
                          <td>
                            <span className={`small ${open ? '' : 't2'}`}>{sessionLabel(m.session, now, utc)}</span>
                          </td>
                          <td>{youCell(m.coin)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mobile-only col" style={{ gap: 0 }}>
                {rows.map((m) => {
                  const c = markets.data?.get(m.coin);
                  return (
                    <Link key={m.coin} className="row nw" href={`/app/trade/${m.ticker}`} style={{ padding: 12, borderBottom: '1px solid var(--line)' }}>
                      <span className="glyph">{m.ticker.slice(0, 2)}</span>
                      <span className="col" style={{ gap: 1, flex: 1 }}>
                        <b>
                          {m.ticker} · <span className="t2" style={{ fontWeight: 400 }}>{m.name}</span>
                        </b>
                        <span className="tiny t3">{c?.delisted ? `Delisted${NETWORK === 'testnet' ? ' on testnet' : ''}` : quiet(m.coin, c) ? `No recent trades on ${NETWORK}` : sessionLabel(m.session, now, utc)}</span>
                      </span>
                      {youCell(m.coin)}
                      <span className="col" style={{ gap: 1, alignItems: 'flex-end' }}>
                        <span className="num">{noData(c) ? '—' : fmtPx(c!.mark)}</span>
                        <span className={`num tiny ${c && !c.delisted ? upDown(c.change) : 't3'}`}>{noData(c) ? '' : fmtPct(c!.change * 100)}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
              {NETWORK === 'testnet' ? (
                <div className="row small t3" style={{ padding: '10px 12px', borderTop: '1px solid var(--line)' }}>
                  <Testnet />
                  <span>Volume, open interest and funding are testnet figures. Markets with no testnet trades say so instead of showing zero.</span>
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="hide-sm">
          <Detail
            m={selected}
            ctx={markets.data?.get(selected.coin)}
            now={now}
            position={(() => {
              const p = posFor(selected.coin);
              return p ? (
                <div className="panel pb col" style={{ gap: 6, background: 'var(--s2)' }}>
                  <div className="row nw">
                    <span className="small t2">Your position</span>
                    <span className="sp" />
                    <span className={`chip chip-sm ${p.row.position.size > 0 ? 'chip-long' : 'chip-short'}`}>{p.row.position.size > 0 ? 'Long' : 'Short'}</span>
                    <span className="num small">{Math.abs(p.row.position.size)}</span>
                  </div>
                  <GuardChip state={poolState(g, p.pool)} sm />
                </div>
              ) : null;
            })()}
          />
        </div>
      </div>
    </div>
  );
}
