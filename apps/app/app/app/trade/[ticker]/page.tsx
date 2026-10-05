'use client';

import Link from 'next/link';
import { use, useEffect, useRef, useState } from 'react';
import { BottomPanel } from '@/components/app/bottom-panel';
import { CandleChart, type ChartLine } from '@/components/app/candle-chart';
import { fmtPct, fmtPx, fmtUsd, upDown } from '@/components/app/format';
import { GuardChip } from '@/components/app/guard-ui';
import { Icon } from '@/components/app/icons';
import { DepthChart, FundingChart, MarketInfo } from '@/components/app/market-panels';
import { OrderBook } from '@/components/app/order-book';
import { GuardCell } from '@/components/app/positions-table';
import { Ticket } from '@/components/app/ticket';
import { NETWORK } from '@/lib/env';
import { describeAction, orderKindLabel, useGuardOrders, useGuardView, useNow } from '@/lib/guard';
import { useAccountView, useCandles, useTrades, useXyzMarkets, type MarketCtx } from '@/lib/hl';
import { MARKETS, homeOpen, marketByTicker, sessionLabel, type Market } from '@/lib/markets';
import { useReview, useViewer } from '@/lib/review';
import { priceAtLine } from '@bulwarkxyz/guard-core';
import { useTimes } from '@/lib/time';
import { closeIntent, ticketIntent } from '@/lib/ticket-intent';

const TF = [
  { id: '5m', hours: 12 },
  { id: '15m', hours: 36 },
  { id: '1h', hours: 24 * 5 },
  { id: '4h', hours: 24 * 20 },
  { id: '1d', hours: 24 * 120 },
] as const;
const HOME = { futures: 'CME/NYMEX', futuresBrent: 'ICE', usStocks: 'US stocks', korea: 'KRX' } as const;

function Testnet() {
  return NETWORK === 'testnet' ? <span className="tag tag-net">testnet</span> : null;
}

/** Hourly funding with the time to the next payment (Hyperliquid pays every hour). */
function Funding({ ctx }: { ctx: MarketCtx }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const left = 3_600_000 - (now % 3_600_000);
  const mm = String(Math.floor(left / 60_000)).padStart(2, '0');
  const ss = String(Math.floor((left % 60_000) / 1000)).padStart(2, '0');
  return (
    <span className="num" title={`${fmtPct(ctx.fundingAprPct, 2, false)} a year at this rate`}>
      {ctx.fundingHourlyPct.toFixed(4)}% · {mm}:{ss} <Testnet />
    </span>
  );
}

function MarketPicker({ m, maxLev }: { m: Market; maxLev?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="msel" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="glyph">{m.ticker.slice(0, 2)}</span>
        <span className="col" style={{ gap: 0, alignItems: 'flex-start' }}>
          <b style={{ fontSize: 14 }}>{m.ticker}-USDC</b>
          <span className="tiny t3">{m.name} · xyz</span>
        </span>
        {maxLev ? <span className="chip chip-sm num">{maxLev}×</span> : null}
        {Icon.caret()}
      </button>
      {open ? (
        <div className="mkmenu" role="listbox">
          {MARKETS.map((x) => (
            <Link key={x.coin} href={`/app/trade/${x.ticker}`} role="option" aria-selected={x.coin === m.coin} className={x.coin === m.coin ? 'on' : ''} onClick={() => setOpen(false)}>
              <span className="glyph">{x.ticker.slice(0, 2)}</span>
              <b>{x.ticker}</b>
              <span className="small t3">{x.name}</span>
            </Link>
          ))}
          <Link href="/app" className="small t2" onClick={() => setOpen(false)}>
            All markets →
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export default function TradePage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = use(params);
  const m = marketByTicker(ticker) ?? MARKETS[0]!;
  const review = useReview();
  const { address, connected } = useViewer();
  const markets = useXyzMarkets();
  const ctx = markets.data?.get(m.coin);
  const [tf, setTf] = useState<(typeof TF)[number]>(TF[2]);
  const candles = useCandles(m.coin, tf.id, tf.hours);
  const view = useAccountView(address);
  const g = useGuardView();
  const guardOrders = useGuardOrders(address);
  const now = useNow();
  const { utc } = useTimes();
  const [phoneTab, setPhoneTab] = useState<'chart' | 'book' | 'trades' | 'info'>('chart');
  const [chartTab, setChartTab] = useState<'chart' | 'depth' | 'funding' | 'info'>('chart');
  const recentTrades = useTrades(m.coin);
  const lastTrade = recentTrades.data?.[0];
  const [sheet, setSheet] = useState<null | 'long' | 'short'>(null);

  const loading = review.state === 'loading' || (!markets.data && !markets.isError);
  const stale = review.state === 'error' || markets.isError;
  const open = homeOpen(m.session, now);
  const risk = view.data?.risk;

  // Chart levels for the user's position in this market: entry, each guard line as a price, liquidation.
  const lines: ChartLine[] = [];
  let mine: { pool: NonNullable<typeof risk>['pools'][number]; row: NonNullable<typeof risk>['pools'][number]['positions'][number] } | null = null;
  for (const pool of risk?.pools ?? []) for (const row of pool.positions) if (row.position.coin === m.coin) mine = { pool, row };
  if (ctx) lines.push({ px: ctx.mark, kind: 'mark', label: 'Mark' });
  if (mine && !loading) {
    lines.push({ px: mine.row.position.entryPx, kind: 'entry', label: `Entry · ${mine.row.position.size > 0 ? 'Long' : 'Short'} ${Math.abs(mine.row.position.size)}` });
    // Orders the guard has resting on Hyperliquid come from the API and are drawn as they are; each line
    // the engine acts on by itself is priced by the solver, unless a resting order already sits there.
    const resting = guardOrders.forCoin(m.coin);
    for (const o of resting) lines.push({ px: o.triggerPx, kind: 'guard', label: `${orderKindLabel(o.kind)} · resting on Hyperliquid` });
    for (const line of g.lines) {
      const lvl = priceAtLine(mine.pool, mine.row, line);
      if (!lvl || resting.some((o) => Math.abs(o.triggerPx - lvl.price) / lvl.price < 0.001)) continue;
      const rule = g.rules.find((r) => r.when.kind === 'buffer' && r.when.below === line);
      lines.push({ px: lvl.price, kind: 'guard', label: `Guard · ${rule ? rule.then.map(describeAction).join(', ') : 'acts'} at ${line}×` });
    }
    if (mine.row.liquidationPx) lines.push({ px: mine.row.liquidationPx, kind: 'liq', label: 'Liquidation without the guard' });
  }

  // Arrived from "Close" on another screen: fill the ticket once the position is known (never send).
  const closeAsked = useRef(false);
  useEffect(() => {
    if (closeAsked.current || !mine || loading) return;
    if (new URLSearchParams(window.location.search).get('close') !== '1') return;
    closeAsked.current = true;
    const i = closeIntent(mine.row.position.coin, mine.row.position.size);
    // Phones have the ticket in a sheet: open it on the closing side first.
    if (window.matchMedia('(max-width: 760px)').matches) setSheet(i.side);
    setTimeout(() => ticketIntent.emit(i), 60);
  }, [mine, loading]);

  const header = (
    <div className="panel mhead">
      <MarketPicker m={m} maxLev={ctx?.maxLeverage} />
      {loading ? (
        <>
          <span className="sk" style={{ width: 90, height: 18 }} />
          {['Oracle', '24h volume', 'Open interest', 'Funding / 1h · next'].map((l) => (
            <div key={l} className="stat hide-sm">
              <span className="lbl">{l}</span>
              <span className="sk" style={{ width: 60 }} />
            </div>
          ))}
        </>
      ) : ctx ? (
        <>
          <div className="col" style={{ gap: 0 }} title={lastTrade ? 'Last trade' : 'Mark price'}>
            <span className="num" style={{ fontSize: 20, fontWeight: 600 }}>
              {fmtPx(lastTrade?.px ?? ctx.mark)}
            </span>
            <span className={`num tiny ${upDown(ctx.change)}`}>{fmtPct(ctx.change * 100)}</span>
          </div>
          <div className="stat">
            <span className="lbl">Mark</span>
            <span className="num">{fmtPx(ctx.mark)}</span>
          </div>
          <div className="stat hide-sm wide-only">
            <span className="lbl">Oracle</span>
            <span className="num">{fmtPx(ctx.oracle)}</span>
          </div>
          <div className="stat hide-sm">
            <span className="lbl">24h volume</span>
            <span className="num">
              {fmtUsd(ctx.dayVolumeUsd)} <Testnet />
            </span>
          </div>
          <div className="stat hide-sm">
            <span className="lbl">Open interest</span>
            <span className="num">
              {fmtUsd(ctx.openInterestUsd)} <Testnet />
            </span>
          </div>
          <div className="stat hide-sm">
            <span className="lbl">Funding / 1h · next</span>
            <Funding ctx={ctx} />
          </div>
        </>
      ) : (
        <span className="small t2">No market data for {m.ticker}.</span>
      )}
      <span className="sp" />
      {open ? (
        <span className="chip" title={`${HOME[m.session]} session`}>{sessionLabel(m.session, now, utc)}</span>
      ) : (
        <>
          <span className="chip" title={`${HOME[m.session]} session`}>
            {Icon.moon(12)}
            {sessionLabel(m.session, now, utc)}
          </span>
          {m.bound ? <span className="chip hide-sm">Off-hours price · ±{m.bound.pct}%</span> : null}
        </>
      )}
    </div>
  );

  const banner = stale ? (
    <div style={{ padding: '6px 6px 0' }}>
      <div className="banner b-crit">
        {Icon.alert()}
        <span>
          <b>Can’t reach Hyperliquid’s market data.</b> Prices and the book below are not updating. The guard acts only on fresh data and holds off until it returns. Orders are disabled until then.
        </span>
        <span className="sp" />
        <button type="button" className="btn btn-sm" onClick={() => markets.refetch()}>
          Retry now
        </button>
      </div>
    </div>
  ) : ctx?.delisted ? (
    <div style={{ padding: '6px 6px 0' }}>
      <div className="banner b-net">
        <span>
          <b>{m.ticker} is delisted{NETWORK === 'testnet' ? ' on testnet' : ''}.</b> {NETWORK === 'testnet' ? 'It trades on mainnet; testnet has no live market for it.' : ''}
        </span>
      </div>
    </div>
  ) : null;

  const chart = (
    <>
      <div className="tabs" style={{ minHeight: 36 }}>
        <span className="hide-sm row nw" role="tablist" aria-label="Chart" style={{ gap: 0 }}>
          {(
            [
              ['chart', 'Chart'],
              ['depth', 'Depth'],
              ['funding', 'Funding'],
              ['info', 'Market info'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={chartTab === id} className={chartTab === id ? 'on' : ''} onClick={() => setChartTab(id)}>
              {label}
            </button>
          ))}
        </span>
        <span className="sp" />
        {chartTab === 'chart'
          ? TF.map((t) => (
              <button key={t.id} type="button" className={`num ${tf.id === t.id ? 'on' : ''}`} onClick={() => setTf(t)}>
                {t.id}
              </button>
            ))
          : null}
      </div>
      {chartTab === 'depth' ? (
        <DepthChart coin={m.coin} ticker={m.ticker} />
      ) : chartTab === 'funding' ? (
        <FundingChart coin={m.coin} />
      ) : chartTab === 'info' ? (
        <MarketInfo m={m} ctx={ctx} />
      ) : loading || (!candles.data && !candles.isError) ? (
        <div className="pb" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="skb" style={{ flex: 1, minHeight: 220 }} />
          <span className="small t3">Loading candles from Hyperliquid…</span>
        </div>
      ) : candles.data?.length ? (
        <CandleChart candles={candles.data} lines={lines} stale={stale ? 'Stale: not updating' : undefined} />
      ) : (
        <div className="empty">No candles for {m.ticker} yet{NETWORK === 'testnet' ? ' on testnet' : ''}.</div>
      )}
    </>
  );

  return (
    <>
      {banner}
      <div className="tgrid">
        {header}
        {!open && !loading ? (
          <div className="mobile-only" style={{ padding: '8px 12px 0' }}>
            <div className="banner">
              {Icon.moon()}
              <span>
                {m.ticker}’s home market is closed ({sessionLabel(m.session, now, utc).replace(/^Closed · /, '')}). It trades on trade.xyz’s off-hours price{m.bound ? `, held within ±${m.bound.pct}%` : ''}. The guard keeps watching.
              </span>
            </div>
          </div>
        ) : null}
        {/* Phone: one column with tabs. */}
        <div className="mobile-only" style={{ padding: '8px 12px 0' }}>
          <div className="seg">
            {(['chart', 'book', 'trades', 'info'] as const).map((t) => (
              <button key={t} type="button" className={phoneTab === t ? 'on' : ''} onClick={() => setPhoneTab(t)}>
                {t === 'chart' ? 'Chart' : t === 'book' ? 'Book' : t === 'trades' ? 'Trades' : 'Info'}
              </button>
            ))}
          </div>
        </div>
        <div className={`panel tchart ${phoneTab === 'chart' ? '' : 'hide-sm'}`}>{chart}</div>
        <div className="panel tbook hide-sm">
          <OrderBook coin={m.coin} ticker={m.ticker} forceLoading={loading} stale={stale} />
        </div>
        {phoneTab === 'book' || phoneTab === 'trades' ? (
          <div className="panel mobile-only">
            <OrderBook coin={m.coin} ticker={m.ticker} forceLoading={loading} stale={stale} only={phoneTab} />
          </div>
        ) : null}
        {phoneTab === 'info' ? (
          <div className="panel mobile-only">
            <div className="pb col" style={{ gap: 0, paddingBottom: 0 }}>
              {ctx ? (
                <>
                  <div className="kv line"><span className="small">24h volume</span><span className="num small">{fmtUsd(ctx.dayVolumeUsd)} <Testnet /></span></div>
                  <div className="kv line"><span className="small">Open interest</span><span className="num small">{fmtUsd(ctx.openInterestUsd)} <Testnet /></span></div>
                  <div className="kv line"><span className="small">Funding / 1h · next</span><Funding ctx={ctx} /></div>
                </>
              ) : null}
            </div>
            <MarketInfo m={m} ctx={ctx} />
          </div>
        ) : null}
        <aside className="panel tticket desk" aria-label="Order ticket">
          <Ticket m={m} ctx={ctx} g={g} open={open} stale={stale} loading={loading} />
        </aside>
        {/* Phone: this market's position, with its guard state. */}
        {connected && mine && !loading ? (
          <div className="mobile-only" style={{ padding: '10px 12px 0' }}>
            <Link className="panel pb col" href="/app/positions" style={{ gap: 8 }}>
              <div className="row nw">
                <b>Your {m.ticker} position</b>
                <span className={`chip chip-sm ${mine.row.position.size > 0 ? 'chip-long' : 'chip-short'}`}>{mine.row.position.size > 0 ? 'Long' : 'Short'}</span>
                <span className="num small">{Math.abs(mine.row.position.size)}</span>
                <span className="sp" />
                <span className={`num small ${upDown(mine.row.unrealizedPnl)}`}>{fmtUsd(mine.row.unrealizedPnl)}</span>
              </div>
              <div className="row nw" style={{ justifyContent: 'space-between' }}>
                <GuardCell g={g} pool={mine.pool} row={mine.row} />
                <span className="tiny">
                  Liq. <span className="num ct">{mine.row.liquidationPx ? fmtPx(mine.row.liquidationPx) : '—'}</span>
                </span>
              </div>
            </Link>
          </div>
        ) : null}
        <div className="panel tbottom hide-sm">
          <BottomPanel g={g} risk={risk} address={address} connected={connected} now={now} coin={m.coin} loading={loading || (connected && !risk && !view.isError)} />
        </div>
        <div className="mcta">
          <button type="button" className="btn btn-lg btn-long" disabled={stale || loading || ctx?.delisted} onClick={() => setSheet('long')}>
            Long
          </button>
          <button type="button" className="btn btn-lg btn-short" disabled={stale || loading || ctx?.delisted} onClick={() => setSheet('short')}>
            Short
          </button>
        </div>
      </div>
      {sheet ? (
        <>
          <div className="sheet-scrim" onClick={() => setSheet(null)} />
          <section className="sheet bw" aria-label="Order ticket" role="dialog">
            <div className="grab" />
            <div className="row nw" style={{ padding: '0 12px' }}>
              <b className="h2">{m.ticker}</b>
              <GuardChip state={g.state} sm />
              <span className="sp" />
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSheet(null)}>
                Close
              </button>
            </div>
            <Ticket key={sheet} m={m} ctx={ctx} g={g} open={open} stale={stale} initialSide={sheet} compact />
          </section>
        </>
      ) : null}
    </>
  );
}
