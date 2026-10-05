'use client';

import Link from 'next/link';
import { DisconnectButton } from '@/components/app/connect';
import { fmtBuffer, fmtSignedUsd, fmtUsd, shortAddr, upDown } from '@/components/app/format';
import { BufferMeter, GuardChip } from '@/components/app/guard-ui';
import { Icon } from '@/components/app/icons';
import { KEY_TEXT } from '@/components/app/keys';
import { poolState } from '@/components/app/positions-table';
import { NETWORK } from '@/lib/env';
import { tickerOf, useGuardView, useNow } from '@/lib/guard';
import { useAccountView, useFills } from '@/lib/hl';
import { homeOpen, marketByCoin } from '@/lib/markets';
import { useMe } from '@/lib/me';
import { useReview, useViewer } from '@/lib/review';

const MODE: Record<string, string> = {
  standard: 'Standard',
  unified: 'Unified',
  portfolio: 'Portfolio margin (read-only)',
  unsupported: 'Not supported (read-only)',
};
const poolLabel = (kind: string, dex: string | null, token: number | null, coin?: string) =>
  kind === 'isolated' ? `Isolated · ${coin ? tickerOf(coin) : ''}` : kind === 'token' ? `Unified · token ${token}` : `Cross · ${dex === '' ? 'main dex' : dex}`;

export default function AccountPage() {
  const review = useReview();
  const { address, connected } = useViewer();
  const view = useAccountView(address);
  const me = useMe();
  const g = useGuardView();
  const now = useNow();
  const fills = useFills(address);
  const risk = view.data?.risk;
  const loading = review.state === 'loading' || (connected && !risk && !view.isError);
  const error = review.state === 'error' || view.isError;
  const upnl = risk ? risk.pools.reduce((s, p) => s + p.positions.reduce((t, r) => t + r.unrealizedPnl, 0), 0) : 0;
  const available = risk ? risk.idle.reduce((s, i) => s + i.available, 0) : 0;
  const notional = (fills.data ?? []).reduce((s, f) => s + Number(f.px) * Number(f.sz), 0);
  const feeAll = notional ? ((fills.data ?? []).reduce((s, f) => s + Number(f.fee), 0) / notional) * 100 : null;
  const closed = (risk?.pools ?? []).flatMap((p) => p.positions).some((r) => {
    const m = marketByCoin(r.position.coin);
    return m ? !homeOpen(m.session, now) : false;
  });

  return (
    <div className="pg">
      <div className="ptitle">
        <h1 className="h1">Account</h1>
        {risk ? <span className="chip chip-sm">{MODE[risk.mode] ?? risk.mode}</span> : null}
        {address ? <span className="small t2 num">{shortAddr(address)}</span> : null}
        <span className="sp" />
        <DisconnectButton />
      </div>

      {error ? (
        <div className="banner b-crit">
          {Icon.alert()}
          <span>
            <b>Can’t read your account from Hyperliquid.</b> Figures below are the last ones received, if any. The guard holds off on stale data; its resting backstops still stand.
          </span>
          <span className="sp" />
          <button type="button" className="btn btn-sm" onClick={() => view.refetch()}>
            Retry now
          </button>
        </div>
      ) : null}
      {closed ? (
        <div className="banner">
          {Icon.moon()}
          <span>
            <b>A home market is closed.</b> Account value and buffers use trade.xyz’s off-hours prices for those positions until the market reopens.
          </span>
        </div>
      ) : null}

      {!connected ? (
        <div className="panel">
          <div className="empty" style={{ padding: '90px 16px' }}>
            <div className="ico">{Icon.account(18)}</div>
            <b>No wallet connected.</b>
            <span className="small" style={{ maxWidth: 420 }}>
              Connect to see your Hyperliquid account, every margin pool with its buffer, and the keys the guard uses.
            </span>
            <Link className="btn btn-sm btn-ink" href="/app/onboarding">
              Connect wallet
            </Link>
          </div>
        </div>
      ) : loading ? (
        <>
          <div className="grid4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            {['Account value', 'Unrealised PnL', 'Available', 'Lowest buffer', 'Your fee rate'].map((l) => (
              <div key={l} className="tile">
                <span className="lbl">{l}</span>
                <span className="sk" style={{ width: '70%', height: 18 }} />
              </div>
            ))}
          </div>
          <div className="panel pb col" style={{ gap: 18 }}>
            <span className="sk" style={{ width: '96%' }} />
            <span className="sk" style={{ width: '90%' }} />
          </div>
        </>
      ) : risk ? (
        <>
          <div className="grid4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <div className="tile">
              <span className="lbl">Account value</span>
              <span className="num">{fmtUsd(risk.accountValue)}</span>
            </div>
            <div className="tile">
              <span className="lbl">Unrealised PnL</span>
              <span className={`num ${upDown(upnl)}`}>{fmtSignedUsd(upnl)}</span>
            </div>
            <div className="tile">
              <span className="lbl">Available (idle)</span>
              <span className="num">{fmtUsd(available)}</span>
            </div>
            <div className="tile">
              <span className="lbl">Lowest buffer</span>
              <span className="num">
                {risk.worst ? fmtBuffer(risk.worst.buffer) : '—'} <span className="small t2">{risk.worst?.positions.length === 1 ? tickerOf(risk.worst.positions[0]!.position.coin) : ''}</span>
              </span>
            </div>
            <div className="tile">
              <span className="lbl">Your fee rate (fills)</span>
              <span className="num">{feeAll === null ? 'no fills yet' : `${feeAll.toFixed(4)}%`}</span>
            </div>
          </div>

          <section className="panel" aria-label="Margin pools">
            <div className="ph">
              <h2>Margin pools</h2>
              <span className="tiny t3">each pool is liquidated on its own; the guard watches every one; the lowest buffer is the account’s</span>
              <span className="sp" />
              {g.exampleRules ? <span className="tag">Example rules</span> : null}
            </div>
            {risk.pools.length ? (
              <div className="tblw">
                <table className="tbl" style={{ fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th>Pool</th>
                      <th>Positions</th>
                      <th className="r">Equity</th>
                      <th className="r">Maintenance</th>
                      <th className="r">Buffer</th>
                      <th style={{ minWidth: 160 }}>Against your lines</th>
                      <th>Guard</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...risk.pools]
                      .sort((a, b) => a.buffer - b.buffer)
                      .map((p) => (
                        <tr key={p.pool.id}>
                          <td>
                            <b>{poolLabel(p.pool.kind, p.pool.dex, p.pool.token, p.positions[0]?.position.coin)}</b>
                          </td>
                          <td className="small">
                            {p.positions.map((r) => (
                              <span key={r.position.key} style={{ marginRight: 8 }}>
                                <span className={r.position.size > 0 ? 'long' : 'short'}>{r.position.size > 0 ? 'Long' : 'Short'}</span> <span className="num">{Math.abs(r.position.size)}</span> {tickerOf(r.position.coin)}
                              </span>
                            ))}
                          </td>
                          <td className="r num">{fmtUsd(p.equity)}</td>
                          <td className="r num">{fmtUsd(p.maintenance)}</td>
                          <td className="r num">{fmtBuffer(p.buffer)}</td>
                          <td>
                            <BufferMeter size="row" buffer={p.buffer} lines={g.lines} state={poolState(g, p)} />
                          </td>
                          <td>
                            <GuardChip state={poolState(g, p)} sm />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="pb small t2">No open positions, so no margin pools.</div>
            )}
          </section>

          <div className="grid2 even">
            <section className="panel" aria-label="Idle balances">
              <div className="ph">
                <h2>Idle balances</h2>
                <span className="tiny t3">what a top-up rule can move in, up to the amount you typed</span>
              </div>
              {risk.idle.length ? (
                <div className="pb col" style={{ gap: 0 }}>
                  {risk.idle.map((s) => (
                    <div key={s.id} className="kv line">
                      <span className="small">{s.kind === 'spot' ? 'Spot USDC' : s.kind === 'dex' ? `${s.dex === '' ? 'Main dex' : s.dex} withdrawable` : `Token ${s.token} free balance`}</span>
                      <span className="num small">{fmtUsd(s.available)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="pb small t2">No idle balances.</div>
              )}
            </section>
            <section className="panel" aria-label="Keys and addresses">
              <div className="ph">
                <h2>Keys and addresses</h2>
              </div>
              <div className="pb col" style={{ gap: 0 }}>
                <div className="kv line">
                  <span className="small">Your account</span>
                  <span className="num small">{address ? shortAddr(address) : '—'}</span>
                </div>
                <div className="kv line">
                  <span className="small">Guard key</span>
                  <span className="small">{me.data?.agent ? `${me.data.agent.approved ? 'approved' : 'not approved'}` : 'not created'}</span>
                </div>
                <div className="kv line">
                  <span className="small">Key storage</span>
                  <span className="small">{me.data?.keyCustody === 'kms' ? 'AWS KMS' : 'Encrypted on Bulwark’s server'}</span>
                </div>
                <div className="kv">
                  <span className="small">Explorer</span>
                  <a className="small" href={`https://app.hyperliquid${NETWORK === 'testnet' ? '-testnet' : ''}.xyz/explorer/address/${address}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
                    View on Hyperliquid
                  </a>
                </div>
                <span className="small t2" style={{ marginTop: 10 }}>
                  {KEY_TEXT[me.data?.keyCustody ?? 'sealed']}
                </span>
                <div className="disclose" style={{ marginTop: 10 }}>
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
