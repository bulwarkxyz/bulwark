'use client';

import { useAccount } from 'wagmi';
import { fmtBuffer, fmtUsd, shortAddr } from '@/components/app/format';
import { TopBar } from '@/components/app/shell';
import { NETWORK } from '@/lib/env';
import { useAccountView } from '@/lib/hl';
import { useMe } from '@/lib/me';

const MODE: Record<string, string> = {
  standard: 'Standard: one cross pool per dex',
  unified: 'Unified: one pool per collateral token, shared across dexes',
  portfolio: 'Portfolio margin: shown read-only, the guard does not act',
};

const poolLabel = (kind: string, dex: string | null, token: number | null, coin?: string) =>
  kind === 'isolated' ? `Isolated ${coin?.replace('xyz:', '') ?? ''}` : kind === 'token' ? `Token ${token} pool` : `${dex === '' ? 'Main dex' : dex} cross`;

export default function AccountPage() {
  const { address } = useAccount();
  const view = useAccountView(address);
  const me = useMe();
  const risk = view.data?.risk;

  return (
    <>
      <TopBar title="Account" />
      <div className="content">
        {!address ? <div className="callout">Connect a wallet to see your account.</div> : !risk ? <div className="skeleton" style={{ height: 120 }} /> : null}
        {risk ? (
          <>
            <div className="grid-auto">
              <div className="card card-b">
                <div className="eyebrow">Account value</div>
                <div className="big num">{fmtUsd(risk.accountValue)}</div>
                <div className="faint" style={{ fontSize: 12 }}>
                  Perps and spot, at current marks
                </div>
              </div>
              <div className="card card-b">
                <div className="eyebrow">Lowest buffer</div>
                <div className="big num" style={{ color: 'var(--guard-text)' }}>{risk.worst ? fmtBuffer(risk.worst.buffer) : '—'}</div>
                <div className="faint" style={{ fontSize: 12 }}>
                  Equity ÷ maintenance; liquidation at 1×
                </div>
              </div>
              <div className="card card-b">
                <div className="eyebrow">Account mode</div>
                <div style={{ fontWeight: 600, marginTop: 6 }}>{MODE[risk.mode] ?? risk.mode}</div>
                <div className="faint num" style={{ fontSize: 12 }}>
                  Hyperliquid: {view.data?.abstraction}
                </div>
              </div>
            </div>

            <section className="card tbl-wrap">
              <div className="card-h">
                <h2>Margin pools</h2>
                <span className="faint" style={{ fontSize: 12 }}>
                  Each pool is liquidated on its own; the guard watches every one
                </span>
              </div>
              {risk.pools.length ? (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Pool</th>
                      <th className="r">Equity</th>
                      <th className="r">Maintenance</th>
                      <th className="r">Buffer</th>
                      <th className="r hide-sm">Positions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...risk.pools].sort((a, b) => a.buffer - b.buffer).map((p) => (
                      <tr key={p.pool.id}>
                        <td>{poolLabel(p.pool.kind, p.pool.dex, p.pool.token, p.positions[0]?.position.coin)}</td>
                        <td className="r num">{fmtUsd(p.equity)}</td>
                        <td className="r num">{fmtUsd(p.maintenance)}</td>
                        <td className="r num">{fmtBuffer(p.buffer)}</td>
                        <td className="r num hide-sm">{p.positions.length}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="card-b faint">No open positions.</div>
              )}
            </section>

            <section className="card tbl-wrap">
              <div className="card-h">
                <h2>Idle balances</h2>
                <span className="faint" style={{ fontSize: 12 }}>
                  What a top-up rule can move in; it never takes a pool below your highest line
                </span>
              </div>
              {risk.idle.length ? (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th className="r">Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    {risk.idle.map((s) => (
                      <tr key={s.id}>
                        <td>{s.kind === 'spot' ? 'Spot USDC' : s.kind === 'dex' ? `${s.dex === '' ? 'Main dex' : s.dex} withdrawable` : `Token ${s.token} free balance`}</td>
                        <td className="r num">{fmtUsd(s.available)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="card-b faint">No idle balances.</div>
              )}
            </section>
          </>
        ) : null}

        {address ? (
          <section className="card">
            <div className="card-h">
              <h2>Addresses</h2>
            </div>
            <div className="card-b">
              <div className="kv">
                <span>Your account</span>
                <span className="num">{shortAddr(address)}</span>
              </div>
              <div className="kv">
                <span>Guard key</span>
                <span className="num">{me.data?.agent ? `${shortAddr(me.data.agent.address)} · ${me.data.agent.approved ? 'approved' : 'not approved'}` : '—'}</span>
              </div>
              <div className="kv">
                <span>Network</span>
                <span>{NETWORK === 'mainnet' ? 'Hyperliquid mainnet' : 'Hyperliquid testnet'}</span>
              </div>
              <div className="kv">
                <span>Explorer</span>
                <a className="link" href={`https://app.hyperliquid${NETWORK === 'testnet' ? '-testnet' : ''}.xyz/explorer/address/${address}`} target="_blank" rel="noreferrer">
                  View on Hyperliquid
                </a>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
