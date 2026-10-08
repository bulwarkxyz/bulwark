'use client';

import type { AccountRisk } from '@bulwarkxyz/guard-core';
import type { Hex } from '@bulwarkxyz/hyperliquid';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useSignedIn } from '@/lib/api';
import { GUARD_KINDS, attemptOf, useAudit } from '@/lib/audit';
import { NETWORK } from '@/lib/env';
import { TOGETHER_NOTE, orderLabel, tickerOf, useGuardOrders, type GuardView } from '@/lib/guard';
import { info, useAccountView, useFills, useOpenOrders } from '@/lib/hl';
import { useReview } from '@/lib/review';
import { fmtPx, fmtSignedUsd, fmtUsd, upDown } from './format';
import { Icon } from './icons';
import { PositionsTable } from './positions-table';
import { useTimes } from '@/lib/time';
import { AccountUnavailable } from '@/components/app/account-unavailable';
import { NoBackstopNotes } from './guard-ui';

type Tab = 'positions' | 'orders' | 'guard' | 'fills' | 'funding' | 'history';

function useFunding(user: Hex | undefined) {
  return useQuery({
    queryKey: ['funding', NETWORK, user],
    enabled: Boolean(user),
    queryFn: () => info.request<Array<{ time: number; delta: { coin: string; usdc: string; fundingRate: string } }>>({ type: 'userFunding', user, startTime: Date.now() - 7 * 86_400_000 }),
    refetchInterval: 60_000,
  });
}
function useHistory(user: Hex | undefined) {
  return useQuery({
    queryKey: ['order-history', NETWORK, user],
    enabled: Boolean(user),
    queryFn: () => info.request<Array<{ order: { coin: string; side: 'B' | 'A'; limitPx: string; origSz: string; oid: number; timestamp: number; orderType: string; reduceOnly: boolean }; status: string; statusTimestamp: number }>>({ type: 'historicalOrders', user }),
    refetchInterval: 60_000,
  });
}

/** A read that failed is not an empty list: say so, with a retry. */
function LoadFailed({ what, q }: { what: string; q: { refetch: () => unknown; isFetching: boolean } }) {
  return (
    <span className="col" style={{ gap: 8, alignItems: 'center' }}>
      <span>Can’t load {what} from Hyperliquid right now.</span>
      <button type="button" className="btn btn-sm" disabled={q.isFetching} onClick={() => void q.refetch()}>
        {q.isFetching ? 'Trying…' : 'Try again'}
      </button>
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty small">{children}</div>;
}

export function BottomPanel({ g, risk, address, connected, now, coin, loading }: { g: GuardView; risk: AccountRisk | undefined; address: Hex | undefined; connected: boolean; now: number; coin: string; loading: boolean }) {
  const [tab, setTab] = useState<Tab>('positions');
  const review = useReview();
  const times = useTimes();
  const ts = (t: number) => times.fmt(t, 'short');
  const signedIn = useSignedIn() || review.on;
  const orders = useOpenOrders(address);
  // Shared with the trade screen (same query): only read here to tell "can't load" from "no positions".
  const view = useAccountView(address);
  const fills = useFills(address);
  // Only the open tab's history is fetched.
  const funding = useFunding(tab === 'funding' ? address : undefined);
  const history = useHistory(tab === 'history' ? address : undefined);
  const guardOrders = useGuardOrders(address);
  const audit = useAudit({ enabled: tab === 'guard' });
  const acted = (audit.data ?? []).filter((e) => GUARD_KINDS.includes(e.kind)).sort((a, b) => b.seq - a.seq).slice(0, 20);
  const nPos = risk ? risk.pools.reduce((s, p) => s + p.positions.length, 0) : null;
  const tabs: Array<{ id: Tab; label: string; n?: number | null }> = [
    { id: 'positions', label: 'Positions', n: nPos },
    { id: 'orders', label: 'Open orders', n: orders.data?.length ?? null },
    { id: 'guard', label: 'Guard actions' },
    { id: 'fills', label: 'Trade history' },
    { id: 'funding', label: 'Funding' },
    { id: 'history', label: 'Order history' },
  ];

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="pb col" style={{ gap: 14 }}>
        <span className="sk" style={{ width: '96%' }} />
        <span className="sk" style={{ width: '92%' }} />
        <span className="sk" style={{ width: '94%' }} />
      </div>
    );
  } else if (!connected) {
    body = (
      <div className="empty">
        <div className="ico">{Icon.shield(18)}</div>
        <span>Connect a wallet to see your positions, each with its guard state.</span>
        <Link className="btn btn-sm btn-ink" href="/app/onboarding">
          Connect wallet
        </Link>
      </div>
    );
  } else if (tab === 'positions') {
    body = !risk ? (view.isError ? <AccountUnavailable view={view} compact /> : null) : nPos ? <PositionsTable g={g} risk={risk} now={now} highlight={coin} compact /> : <Empty>No open positions.</Empty>;
  } else if (tab === 'orders') {
    body = orders.data?.length ? (
      <div className="tblw">
        <table className="tbl">
          <thead>
            <tr><th>Time ({times.label})</th><th>Market</th><th>Type</th><th>Side</th><th className="r">Price</th><th className="r">Size</th><th>Reduce only</th></tr>
          </thead>
          <tbody>
            {orders.data.map((o) => (
              <tr key={o.oid}>
                <td className="num">{ts(o.timestamp)}</td>
                <td><b>{tickerOf(o.coin)}</b></td>
                <td>{o.orderType}</td>
                <td className={o.side === 'B' ? 'long' : 'short'}>{o.side === 'B' ? 'Buy' : 'Sell'}</td>
                <td className="r num">{fmtPx(Number(o.triggerPx && Number(o.triggerPx) > 0 ? o.triggerPx : o.limitPx))}</td>
                <td className="r num">{o.sz}</td>
                <td>{o.reduceOnly ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty>{orders.isError ? <LoadFailed what="your open orders" q={orders} /> : 'No open orders.'}</Empty>
    );
  } else if (tab === 'guard') {
    body = !signedIn ? (
      <Empty>Sign in to see what the guard has resting on Hyperliquid and what it has done.</Empty>
    ) : (
      <div className="col" style={{ gap: 0 }}>
        <div className="ph sub">
          <b className="small">Resting on Hyperliquid</b>
          <span className="tiny t3">{guardOrders.example ? 'example, from the example rules' : 'the guard’s own orders · they fill even if our engine is offline'}</span>
        </div>
        {guardOrders.orders.length ? (
          <div className="tblw">
            <table className="tbl">
              <thead>
                <tr><th>Market</th><th>Order</th><th className="r">Trigger</th><th className="r">Size</th><th className="r">Placed ({times.label})</th></tr>
              </thead>
              <tbody>
                {guardOrders.orders.map((o) => (
                  <tr key={o.oid}>
                    <td><b>{tickerOf(o.coin)}</b></td>
                    <td style={{ whiteSpace: 'normal' }}>{orderLabel(o)} · reduce-only{o.pricing === 'together' ? <span className="tiny t3" style={{ display: 'block' }}>{TOGETHER_NOTE}</span> : null}</td>
                    <td className="r num">{fmtPx(o.triggerPx)}</td>
                    <td className="r num">{Math.abs(o.size)}</td>
                    <td className="r num">{ts(o.placedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="pb small t2">{guardOrders.error ? `Can’t load the guard’s orders: ${guardOrders.error.message}` : g.lines.length ? 'Nothing resting right now.' : 'No rules yet, so the guard has placed nothing.'}</div>
        )}
        <NoBackstopNotes g={g} restingCoins={new Set(guardOrders.orders.map((o) => o.coin))} />
        <div className="ph sub">
          <b className="small">Recent guard actions</b>
          <span className="tiny t3">{review.on ? 'example entries' : 'from your audit log'} · a retry is its own row</span>
          <span className="sp" />
          <Link className="tiny" href="/app/audit" style={{ textDecoration: 'underline' }}>Audit log</Link>
        </div>
        {acted.length ? (
          <div className="tblw">
            <table className="tbl">
              <thead>
                <tr><th>Time ({times.label})</th><th>What happened</th><th className="r">Attempt</th><th className="r">Filled</th><th className="hide-sm">Why</th></tr>
              </thead>
              <tbody>
                {acted.map((e) => {
                  const at = attemptOf(e);
                  return (
                    <tr key={e.seq}>
                      <td className="num">{ts(e.at)}</td>
                      <td style={{ whiteSpace: 'normal', minWidth: 220 }}>{e.what}</td>
                      <td className={`r num ${at && at.n > 1 ? 'wt' : ''}`}>{at ? at.n : <span className="t3">—</span>}</td>
                      <td className="r num">{at?.filled ?? <span className="t3">—</span>}</td>
                      <td className="hide-sm t2" style={{ whiteSpace: 'normal' }}>{e.why}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="pb small t2">{audit.error ? `Can’t load the audit log: ${(audit.error as Error).message}` : audit.isLoading ? 'Loading the guard’s actions…' : 'The guard hasn’t acted yet.'}</div>
        )}
      </div>
    );
  } else if (tab === 'fills') {
    body = fills.data?.length ? (
      <div className="tblw">
        <table className="tbl">
          <thead>
            <tr><th>Time ({times.label})</th><th>Market</th><th>Direction</th><th className="r">Price</th><th className="r">Size</th><th className="r">Fee</th><th className="r">Closed PnL</th></tr>
          </thead>
          <tbody>
            {fills.data.slice(0, 50).map((f, i) => (
              <tr key={`${f.time}-${i}`}>
                <td className="num">{ts(f.time)}</td>
                <td><b>{tickerOf(f.coin)}</b></td>
                <td>{f.dir}</td>
                <td className="r num">{fmtPx(Number(f.px))}</td>
                <td className="r num">{f.sz}</td>
                <td className="r num">{fmtUsd(Number(f.fee), 4)}</td>
                <td className={`r num ${upDown(Number(f.closedPnl))}`}>{fmtSignedUsd(Number(f.closedPnl))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty>{fills.isError ? <LoadFailed what="your trades" q={fills} /> : 'No trades yet.'}</Empty>
    );
  } else if (tab === 'funding') {
    body = funding.data?.length ? (
      <div className="tblw">
        <table className="tbl">
          <thead>
            <tr><th>Time ({times.label})</th><th>Market</th><th className="r">Rate / 1h</th><th className="r">Paid or received</th></tr>
          </thead>
          <tbody>
            {[...funding.data].reverse().slice(0, 50).map((f, i) => (
              <tr key={`${f.time}-${i}`}>
                <td className="num">{ts(f.time)}</td>
                <td><b>{tickerOf(f.delta.coin)}</b></td>
                <td className="r num">{(Number(f.delta.fundingRate) * 100).toFixed(4)}%</td>
                <td className={`r num ${upDown(Number(f.delta.usdc))}`}>{fmtSignedUsd(Number(f.delta.usdc))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty>{funding.isError ? <LoadFailed what="your funding payments" q={funding} /> : `No funding in the last 7 days${NETWORK === 'testnet' ? ' (testnet funding is often zero)' : ''}.`}</Empty>
    );
  } else {
    body = history.data?.length ? (
      <div className="tblw">
        <table className="tbl">
          <thead>
            <tr><th>Time ({times.label})</th><th>Market</th><th>Type</th><th>Side</th><th className="r">Price</th><th className="r">Size</th><th>Status</th></tr>
          </thead>
          <tbody>
            {history.data.slice(0, 50).map((h) => (
              <tr key={`${h.order.oid}-${h.statusTimestamp}`}>
                <td className="num">{ts(h.statusTimestamp)}</td>
                <td><b>{tickerOf(h.order.coin)}</b></td>
                <td>{h.order.orderType}{h.order.reduceOnly ? ' · reduce-only' : ''}</td>
                <td className={h.order.side === 'B' ? 'long' : 'short'}>{h.order.side === 'B' ? 'Buy' : 'Sell'}</td>
                <td className="r num">{fmtPx(Number(h.order.limitPx))}</td>
                <td className="r num">{h.order.origSz}</td>
                <td>{h.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty>{history.isError ? <LoadFailed what="your order history" q={history} /> : 'No orders yet.'}</Empty>
    );
  }

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Account">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
            {t.n !== undefined && t.n !== null && connected ? <span className="count">{t.n}</span> : null}
          </button>
        ))}
        <span className="sp" />
        {g.exampleRules ? (
          <span className="tag" style={{ alignSelf: 'center' }}>
            Example rules
          </span>
        ) : null}
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>{body}</div>
    </>
  );
}
