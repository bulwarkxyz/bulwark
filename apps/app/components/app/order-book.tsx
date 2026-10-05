'use client';

import { useState } from 'react';
import { NETWORK } from '@/lib/env';
import { useBook, useTrades, type BookLevel } from '@/lib/hl';
import { fmtPx } from './format';
import { useTimes } from '@/lib/time';
import { Select } from './select';
import { groupLevels, tickOptions } from '@/lib/book-group';

const fmtSz = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });

function Side({ levels, kind, max }: { levels: BookLevel[]; kind: 'ask' | 'bid'; max: number }) {
  let total = 0;
  const rows = levels.map((l) => {
    total += l.sz;
    return { ...l, total };
  });
  const shown = kind === 'ask' ? [...rows].reverse() : rows;
  return (
    <>
      {shown.map((l) => (
        <div key={l.px} className={`lv ${kind}`}>
          <div className="depth" style={{ width: `${(l.total / max) * 100}%` }} />
          <span className={kind === 'ask' ? 'short' : 'long'}>{fmtPx(l.px)}</span>
          <span>{fmtSz(l.sz)}</span>
          <span>{fmtSz(l.total)}</span>
        </div>
      ))}
    </>
  );
}

/** Order book and recent trades as tabs (Hyperliquid's arrangement). Depth bars show cumulative size. */
export function OrderBook({ coin, ticker, depth = 9, forceLoading, stale, only }: { coin: string; ticker: string; depth?: number; forceLoading?: boolean; stale?: boolean; only?: 'book' | 'trades' }) {
  const times = useTimes();
  const [picked, setTab] = useState<'book' | 'trades'>('book');
  const tab = only ?? picked;
  const [group, setGroup] = useState(0);
  const book = useBook(coin);
  const trades = useTrades(coin);
  const ticks = tickOptions(book.data?.asks[0]?.px ?? book.data?.bids[0]?.px);
  const tick = group > 0 ? (ticks[group] ?? null) : null;
  const asks = groupLevels(book.data?.asks ?? [], tick, 'ask').slice(0, depth);
  const bids = groupLevels(book.data?.bids ?? [], tick, 'bid').slice(0, depth);
  const max = Math.max(1e-12, asks.reduce((s, l) => s + l.sz, 0), bids.reduce((s, l) => s + l.sz, 0));
  const bestAsk = asks[0]?.px;
  const bestBid = bids[0]?.px;
  const mid = bestAsk && bestBid ? (bestAsk + bestBid) / 2 : null;
  const spread = bestAsk && bestBid ? bestAsk - bestBid : null;
  const loading = forceLoading || (!book.data && !book.isError);

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Book and trades">
        {only ? null : (
          <>
            <button type="button" role="tab" aria-selected={tab === 'book'} className={tab === 'book' ? 'on' : ''} onClick={() => setTab('book')}>
              Order book
            </button>
            <button type="button" role="tab" aria-selected={tab === 'trades'} className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>
              Trades
            </button>
          </>
        )}
        <span className="sp" />
        {tab === 'book' && ticks.length ? (
          <span className="tick">
            <Select compact label="Group prices by" value={String(group)} options={ticks.map((t, i) => ({ value: String(i), label: i === 0 ? 'As sent' : String(t), description: i === 0 ? 'Each price level as Hyperliquid sends it' : `Levels grouped to ${t}` }))} onChange={(v) => setGroup(Number(v))} />
          </span>
        ) : null}
      </div>
      {loading ? (
        <div className="pb col" style={{ gap: 10 }}>
          {Array.from({ length: 10 }, (_, i) => (
            <span key={i} className="sk" style={{ width: `${70 + ((i * 7) % 25)}%` }} />
          ))}
        </div>
      ) : tab === 'book' ? (
        <div className="ob" aria-live="off">
          <div className="hd">
            <span>Price</span>
            <span style={{ textAlign: 'right' }}>Size ({ticker})</span>
            <span style={{ textAlign: 'right' }}>Total</span>
          </div>
          {asks.length || bids.length ? (
            <>
              <Side levels={asks} kind="ask" max={max} />
              <div className="mid">
                <span className="num b" style={{ fontSize: 14 }}>
                  {mid ? fmtPx(mid) : '—'}
                </span>
                <span className="tiny t3">
                  Spread <span className="num">{spread !== null && mid ? `${fmtPx(spread)} · ${((spread / mid) * 100).toFixed(3)}%` : '—'}</span>
                </span>
              </div>
              <Side levels={bids} kind="bid" max={max} />
            </>
          ) : (
            <div className="empty small">No resting orders on this book{NETWORK === 'testnet' ? ' on testnet' : ''}.</div>
          )}
          {stale || book.isError ? <div className="tiny ct" style={{ padding: '6px 10px' }}>Stale: not updating</div> : null}
          {NETWORK === 'testnet' && (asks.length || bids.length) ? (
            <div className="tiny t3" style={{ padding: '8px 10px', fontFamily: 'var(--font-geist)' }}>
              Thin book: <span className="nt">testnet</span>.
            </div>
          ) : null}
        </div>
      ) : (
        <div className="ob">
          <div className="hd">
            <span>Price</span>
            <span style={{ textAlign: 'right' }}>Size ({ticker})</span>
            <span style={{ textAlign: 'right' }}>Time ({times.label})</span>
          </div>
          {(trades.data ?? []).slice(0, 22).map((t, i) => (
            <div key={`${t.time}-${i}`} className="lv">
              <span className={t.side === 'B' ? 'long' : 'short'}>
                {t.side === 'B' ? '↑' : '↓'} {fmtPx(t.px)}
              </span>
              <span>{fmtSz(t.sz)}</span>
              <span className="t3">{times.fmt(t.time, 'clock')}</span>
            </div>
          ))}
          {trades.data && !trades.data.length ? <div className="empty small">No trades yet{NETWORK === 'testnet' ? ' on testnet' : ''}.</div> : null}
        </div>
      )}
    </>
  );
}
