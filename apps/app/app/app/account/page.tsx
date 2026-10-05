'use client';

import Link from 'next/link';
import { DisconnectButton } from '@/components/app/connect';
import { fmtBuffer, fmtSignedUsd, fmtUsd, shortAddr, upDown } from '@/components/app/format';
import { BufferMeter, GuardChip } from '@/components/app/guard-ui';
import { Icon } from '@/components/app/icons';
import { KEY_STORAGE, guardKeyStatus, shownCustody } from '@/components/app/keys';
import { poolState } from '@/components/app/positions-table';
import { BUILDER_FEE_TENTHS_BPS } from '@bulwarkxyz/config';
import { BUILDER_ON, NETWORK } from '@/lib/env';
import { tradingKey } from '@/lib/signing';
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
  // Fee rate over the last 30 days of fills (what Hyperliquid actually charged, builder fee included).
  const recent = (fills.data ?? []).filter((f) => f.time >= Date.now() - 30 * 86_400_000);
  const notional = recent.reduce((s, f) => s + Number(f.px) * Number(f.sz), 0);
  const feeAll = notional ? (recent.reduce((s, f) => s + Number(f.fee), 0) / notional) * 100 : null;
  const marginUsed = risk ? risk.pools.reduce((s, p) => s + p.positions.reduce((t, r) => t + r.position.api.marginUsed, 0), 0) : 0;
  const custody = shownCustody(me.data);
  const tk = address && !review.on ? tradingKey(address) : null;
  const approvedMax = me.data?.builder.approvedMaxTenthsBps ?? 0;
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
            {['Account value', 'Unrealised PnL', 'Margin used', 'Idle USDC', 'Lowest buffer', 'Your fee rate, 30 days'].map((l) => (
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
              <span className="lbl">Margin used</span>
              <span className="num">{fmtUsd(marginUsed)}</span>
            </div>
            <div className="tile">
              <span className="lbl">Idle USDC</span>
              <span className="num">{fmtUsd(available)}</span>
            </div>
            <div className="tile">
              <span className="lbl">Lowest buffer</span>
              <span className="num">
                {risk.worst ? fmtBuffer(risk.worst.buffer) : '—'} <span className="small t2">{risk.worst?.positions.length === 1 ? tickerOf(risk.worst.positions[0]!.position.coin) : ''}</span>
              </span>
            </div>
            <div className="tile">
              <span className="lbl">Your fee rate, 30 days</span>
              <span className="num">{feeAll === null ? 'no fills' : `${feeAll.toFixed(3)}%`}</span>
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
              <>
              <ul className="mobile-only plist" aria-label="Margin pools">
                {[...risk.pools]
                  .sort((a, b) => a.buffer - b.buffer)
                  .map((p) => (
                    <li key={p.pool.id}>
                      <div className="row nw" style={{ justifyContent: 'space-between' }}>
                        <b>{poolLabel(p.pool.kind, p.pool.dex, p.pool.token, p.positions[0]?.position.coin)}</b>
                        <GuardChip state={poolState(g, p)} sm />
                      </div>
                      <span className="small">
                        {p.positions.map((r) => (
                          <span key={r.position.key} style={{ marginRight: 8 }}>
                            <span className={r.position.size > 0 ? 'long' : 'short'}>{r.position.size > 0 ? 'Long' : 'Short'}</span> <span className="num">{Math.abs(r.position.size)}</span> {tickerOf(r.position.coin)}
                          </span>
                        ))}
                      </span>
                      <div className="row nw" style={{ gap: 10 }}>
                        <span className="num small" style={{ width: 52 }}>{fmtBuffer(p.buffer)}</span>
                        <BufferMeter size="row" buffer={p.buffer} lines={g.lines} state={poolState(g, p)} />
                      </div>
                      <span className="tiny t2 num">
                        equity {fmtUsd(p.equity)} · maintenance {fmtUsd(p.maintenance)}
                      </span>
                    </li>
                  ))}
              </ul>
              <div className="tblw hide-sm">
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
              </>
            ) : (
              <div className="pb small t2">No open positions, so no margin pools.</div>
            )}
          </section>

          <div className="grid2 even">
            <section className="panel" aria-labelledby="acct-keys-h">
              <div className="ph">
                <h2 id="acct-keys-h">Keys</h2>
                <span className="sp" />
                <Link className="tiny" href="/app/settings" style={{ textDecoration: 'underline' }}>
                  Manage in Settings
                </Link>
              </div>
              <div className="pb col" style={{ gap: 0 }}>
                <div className="kv line">
                  <span className="small">Guard key</span>
                  <span className="small">{me.data?.agent ? `${custody ? `${KEY_STORAGE[custody]} · ` : ''}${me.data.agent.approved ? 'approved as your agent' : 'not approved yet'}` : guardKeyStatus(me.data).toLowerCase()}</span>
                </div>
                <div className="kv line">
                  <span className="small">It can</span>
                  <span className="small" style={{ textAlign: 'right' }}>reduce-only orders, your top-ups, cancel its own orders</span>
                </div>
                <div className="kv line">
                  <span className="small">It cannot</span>
                  <span className="small" style={{ textAlign: 'right' }}>withdraw, open or add to positions</span>
                </div>
                <div className="kv line">
                  <span className="small">Trading key</span>
                  <span className="small">{review.on ? 'this browser · signs your own orders (example)' : tk ? 'this browser · signs your own orders' : 'none in this browser'}</span>
                </div>
                <div className="kv">
                  <span className="small">Your account</span>
                  <a className="small num" href={`https://app.hyperliquid${NETWORK === 'testnet' ? '-testnet' : ''}.xyz/explorer/address/${address}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
                    {address ? shortAddr(address) : '—'} on Hyperliquid
                  </a>
                </div>
                <div className="disclose" style={{ marginTop: 10 }}>
                  {Icon.shield(14)}
                  <span>
                    Hyperliquid lets an agent key sign any order. <b>Reduce-only is enforced by our engine, not by Hyperliquid.</b> The guard key cannot withdraw.
                  </span>
                </div>
              </div>
            </section>
            <section className="panel" aria-labelledby="acct-bal-h">
              <div className="ph">
                <h2 id="acct-bal-h">Balances and fees</h2>
              </div>
              <div className="pb col" style={{ gap: 0 }}>
                <div className="kv line">
                  <span className="small">USDC, idle</span>
                  <span className="num small">{fmtUsd(available)}</span>
                </div>
                {risk.idle.length > 1
                  ? risk.idle.map((x) => (
                      <div key={x.id} className="kv line">
                        <span className="small t2">{x.kind === 'spot' ? 'Spot USDC' : x.kind === 'dex' ? `${x.dex === '' ? 'Main dex' : x.dex} withdrawable` : `Token ${x.token} free balance`}</span>
                        <span className="num small t2">{fmtUsd(x.available)}</span>
                      </div>
                    ))
                  : null}
                <div className="kv line">
                  <span className="small">Top-ups may use</span>
                  <span className="small">only the amount you typed in a rule</span>
                </div>
                <div className="kv line">
                  <span className="small">Hyperliquid fee, your rate</span>
                  <span className="num small">{feeAll === null ? 'no fills in 30 days' : `${feeAll.toFixed(3)}%`}</span>
                </div>
                {BUILDER_ON ? (
                  <>
                    <div className="kv line">
                      <span className="small">Bulwark fee</span>
                      <span className="num small">
                        {(BUILDER_FEE_TENTHS_BPS / 1000).toFixed(2)}% · {BUILDER_FEE_TENTHS_BPS / 10} bps
                      </span>
                    </div>
                    <div className="kv">
                      <span className="small">Fee approval</span>
                      <span className="small">
                        {approvedMax ? `up to ${(approvedMax / 1000).toFixed(2)}%` : 'not approved'}
                        {NETWORK === 'testnet' ? <span className="nt"> · testnet path</span> : null}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="kv">
                    <span className="small">Bulwark fee</span>
                    <span className="small">none on {NETWORK}</span>
                  </div>
                )}
              </div>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
