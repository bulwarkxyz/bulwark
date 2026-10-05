'use client';

import { useQuery } from '@tanstack/react-query';
import { NETWORK } from '@/lib/env';
import { info, useBook, type MarketCtx } from '@/lib/hl';
import { MARKETS_SOURCE, type Market } from '@/lib/markets';
import { useTimes } from '@/lib/time';
import { fmtPct, fmtPx } from './format';

const HOME = { futures: 'CME/NYMEX futures hours', futuresBrent: 'ICE futures hours', usStocks: 'US stock market hours', korea: 'Korea Exchange hours' } as const;

/** Depth: cumulative size on each side of the book, from the same book the order book shows. */
export function DepthChart({ coin, ticker }: { coin: string; ticker: string }) {
  const book = useBook(coin);
  const bids = book.data?.bids ?? [];
  const asks = book.data?.asks ?? [];
  if (!bids.length && !asks.length) return <div className="empty">No resting orders on this book{NETWORK === 'testnet' ? ' on testnet' : ''}.</div>;
  const cum = (ls: typeof bids) => {
    let t = 0;
    return ls.map((l) => ({ px: l.px, total: (t += l.sz) }));
  };
  const b = cum(bids);
  const a = cum(asks);
  const lo = b.length ? b[b.length - 1]!.px : a[0]!.px;
  const hi = a.length ? a[a.length - 1]!.px : b[0]!.px;
  const max = Math.max(b[b.length - 1]?.total ?? 0, a[a.length - 1]?.total ?? 0, 1e-12);
  const W = 600;
  const H = 260;
  const x = (px: number) => (hi === lo ? W / 2 : ((px - lo) / (hi - lo)) * W);
  const y = (t: number) => H - (t / max) * (H - 16);
  const area = (pts: Array<{ px: number; total: number }>, from: number) => (pts.length ? `M${x(pts[0]!.px)},${H} ${pts.map((p) => `L${x(p.px)},${y(p.total)}`).join(' ')} L${x(pts[pts.length - 1]!.px)},${H} L${from},${H}Z` : '');
  const mid = bids[0] && asks[0] ? (bids[0].px + asks[0].px) / 2 : null;
  return (
    <div className="pb col" style={{ flex: 1, gap: 6 }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', flex: 1, minHeight: 220 }} role="img" aria-label={`Depth of the ${ticker} book: cumulative size of bids and asks`}>
        <path d={area(b, x(b[0]?.px ?? lo))} fill="var(--long-soft)" stroke="var(--long)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <path d={area(a, x(a[0]?.px ?? hi))} fill="var(--short-soft)" stroke="var(--short)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {mid ? <line x1={x(mid)} x2={x(mid)} y1={0} y2={H} stroke="var(--text-3)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      <div className="row tiny t2" style={{ justifyContent: 'space-between' }}>
        <span className="num">{fmtPx(lo)}</span>
        <span>
          <span className="long">Bids</span> · <span className="short">Asks</span> · cumulative {ticker}, up to <span className="num">{max.toLocaleString('en-US', { maximumFractionDigits: 4 })}</span>
          {mid ? (
            <>
              {' '}
              · mid <span className="num">{fmtPx(mid)}</span>
            </>
          ) : null}
        </span>
        <span className="num">{fmtPx(hi)}</span>
      </div>
    </div>
  );
}

/** Funding: Hyperliquid's hourly rate for the last 7 days (positive: longs pay shorts). */
export function FundingChart({ coin }: { coin: string }) {
  const times = useTimes();
  const q = useQuery({
    queryKey: ['funding-history', NETWORK, coin],
    queryFn: () => info.request<Array<{ time: number; fundingRate: string }>>({ type: 'fundingHistory', coin, startTime: Date.now() - 7 * 86_400_000 }),
    refetchInterval: 300_000,
  });
  if (q.isLoading) return <div className="pb"><div className="skb" style={{ height: 220 }} /></div>;
  if (q.isError) return <div className="empty small">Can’t load funding history: {(q.error as Error).message}</div>;
  const rows = (q.data ?? []).map((r) => ({ t: r.time, pct: Number(r.fundingRate) * 100 }));
  if (!rows.length) return <div className="empty small">No funding paid in the last 7 days{NETWORK === 'testnet' ? ' (testnet funding is often zero)' : ''}.</div>;
  const W = 600;
  const H = 240;
  const max = Math.max(...rows.map((r) => Math.abs(r.pct)), 1e-9);
  const bw = W / rows.length;
  const zero = H / 2;
  const allZero = rows.every((r) => r.pct === 0);
  const last = rows[rows.length - 1]!;
  return (
    <div className="pb col" style={{ flex: 1, gap: 6 }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', flex: 1, minHeight: 200 }} role="img" aria-label="Hourly funding over the last 7 days">
        <line x1={0} x2={W} y1={zero} y2={zero} stroke="var(--line-2)" vectorEffect="non-scaling-stroke" />
        {rows.map((r, i) => {
          const h = (Math.abs(r.pct) / max) * (H / 2 - 8);
          return <rect key={r.t} x={i * bw} width={Math.max(bw - 0.5, 0.5)} y={r.pct >= 0 ? zero - h : zero} height={h} fill="var(--text-2)" />;
        })}
      </svg>
      <div className="row tiny t2" style={{ justifyContent: 'space-between' }}>
        <span>{times.fmt(rows[0]!.t, 'short')}</span>
        <span>
          {allZero ? 'Zero every hour' : <>Up to <span className="num">{max.toFixed(4)}%</span> an hour</>} · latest <span className="num">{last.pct.toFixed(4)}%</span> · above the line, longs pay shorts{NETWORK === 'testnet' ? ' · testnet' : ''}
        </span>
        <span>{times.fmt(last.t, 'short')}</span>
      </div>
    </div>
  );
}

/** Market info: what the market is and the rules it trades under, from live meta and trade.xyz's published table. */
export function MarketInfo({ m, ctx }: { m: Market; ctx: MarketCtx | undefined }) {
  return (
    <div className="pb col" style={{ gap: 0 }}>
      <div className="kv line"><span className="small">Market</span><span className="small">{m.name} · {m.ticker}-USDC on trade.xyz</span></div>
      <div className="kv line"><span className="small">API name</span><span className="small num">{m.coin}{m.aliases?.length ? ` (also shown as ${m.aliases.join(', ')})` : ''}</span></div>
      <div className="kv line"><span className="small">Home market</span><span className="small">{HOME[m.session]}</span></div>
      <div className="kv line">
        <span className="small">Off-hours price</span>
        <span className="small">{m.bound ? <>held within <span className="num">±{m.bound.pct}%</span> · {m.bound.resets} re-anchor{m.bound.resets === 1 ? '' : 's'}</> : 'no bound published'}</span>
      </div>
      {ctx ? (
        <>
          <div className="kv line"><span className="small">Max leverage</span><span className="small num">{ctx.maxLeverage}×</span></div>
          <div className="kv line"><span className="small">Margin mode</span><span className="small">{ctx.onlyIsolated ? 'Isolated only' : 'Cross or isolated'}{NETWORK === 'testnet' ? ' (testnet meta)' : ''}</span></div>
          <div className="kv line"><span className="small">Mark · oracle</span><span className="small num">{fmtPx(ctx.mark)} · {fmtPx(ctx.oracle)}</span></div>
          <div className="kv line"><span className="small">Funding</span><span className="small">every hour · now <span className="num">{ctx.fundingHourlyPct.toFixed(4)}%</span> ({fmtPct(ctx.fundingAprPct, 1, false)} a year)</span></div>
          <div className="kv line"><span className="small">Size step</span><span className="small num">{(10 ** -ctx.szDecimals).toFixed(ctx.szDecimals)} {m.ticker}</span></div>
        </>
      ) : null}
      <div className="kv"><span className="small">Source</span><a className="small" href={MARKETS_SOURCE.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>{MARKETS_SOURCE.label}</a></div>
    </div>
  );
}
