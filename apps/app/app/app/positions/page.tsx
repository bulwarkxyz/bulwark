'use client';

import type { GuardOrder } from '@bulwarkxyz/store';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useAccount } from 'wagmi';
import { fmtBuffer, fmtPx, fmtSignedUsd, fmtUsd, upDown } from '@/components/app/format';
import { TopBar } from '@/components/app/shell';
import { api, useSignedIn } from '@/lib/api';
import { useCommand } from '@/lib/commands';
import { useAccountView } from '@/lib/hl';
import { useMe } from '@/lib/me';

const poolName = (kind: string, dex: string | null, token: number | null, coin?: string) =>
  kind === 'isolated' ? `Isolated · ${coin?.replace('xyz:', '') ?? ''}` : kind === 'token' ? `Unified · token ${token}` : `Cross · ${dex === '' ? 'main dex' : dex}`;

export default function PositionsPage() {
  const { address } = useAccount();
  const signedIn = useSignedIn();
  const view = useAccountView(address);
  const me = useMe();
  const orders = useQuery({
    queryKey: ['guard-orders', address],
    enabled: Boolean(address && signedIn),
    queryFn: () => api<GuardOrder[]>('/v1/guard-orders'),
    refetchInterval: 15_000,
  });
  const command = useCommand();
  const [minutes, setMinutes] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const lines = me.data?.policy?.policy.rules.filter((r) => r.when.kind === 'buffer').map((r) => (r.when as { below: number }).below) ?? [];
  const risk = view.data?.risk;
  const minutesN = Number(minutes);

  async function unwind() {
    setBusy(true);
    setMsg(null);
    try {
      await command('unwind', minutesN);
      setMsg({ ok: true, text: `Unwind sent. The guard will close every position in slices over ${minutesN} minutes.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar title="Positions" />
      <div className="content">
        {!address ? (
          <div className="callout">Connect a wallet to see your positions.</div>
        ) : !risk ? (
          <div className="skeleton" style={{ height: 160 }} />
        ) : !risk.supported ? (
          <div className="callout warn">This account uses portfolio margin. Bulwark shows it read-only and the guard does not act on it.</div>
        ) : null}

        <div className="split">
          <section className="card tbl-wrap">
            <div className="card-h">
              <h2>Guard backstops</h2>
              <span className="faint" style={{ fontSize: 12 }}>
                Reduce-only stops resting on Hyperliquid at the price where a pool reaches your lowest line.
              </span>
            </div>
            {!signedIn ? (
              <div className="card-b faint">Sign in to see the guard's orders.</div>
            ) : orders.data?.length ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th className="r">Trigger</th>
                    <th className="r">Size</th>
                    <th className="r hide-sm">Order id</th>
                    <th className="r hide-sm">Placed</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.data.map((o) => (
                    <tr key={o.oid}>
                      <td>
                        <b>{o.coin.replace('xyz:', '')}</b>
                      </td>
                      <td className="r num">{fmtPx(o.triggerPx)}</td>
                      <td className="r num">{Math.abs(o.size)}</td>
                      <td className="r num hide-sm">{o.oid}</td>
                      <td className="r num hide-sm">{new Date(o.placedAt).toISOString().slice(5, 16).replace('T', ' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="card-b faint">{me.data?.policy ? 'None resting right now.' : 'No rules yet, so no backstops.'}</div>
            )}
          </section>

          <section className="card" aria-labelledby="unwind-h">
            <div className="card-h">
              <h2 id="unwind-h">Panic unwind</h2>
            </div>
            <div className="card-b stack">
              <span className="muted" style={{ fontSize: 13 }}>
                The guard closes every position with reduce-only orders in equal slices over the time you choose. You sign the command in your wallet.
              </span>
              <div className="field">
                <label htmlFor="unwind-min">Over how many minutes (5 to 10080)</label>
                <div className="input">
                  <input id="unwind-min" inputMode="numeric" placeholder="Your number" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
                  <span className="faint">min</span>
                </div>
              </div>
              <button type="button" className="btn btn-danger" disabled={busy || !signedIn || !me.data?.user || !(minutesN >= 5 && minutesN <= 10080)} onClick={unwind}>
                {busy ? 'Waiting for signature…' : 'Sign and unwind'}
              </button>
              {!me.data?.user ? <span className="faint" style={{ fontSize: 12 }}>Finish onboarding to use the unwind.</span> : null}
              {msg ? <span className={msg.ok ? 'ok-text' : 'err'} style={{ fontSize: 13 }}>{msg.text}</span> : null}
            </div>
          </section>
        </div>
        {[...(risk?.pools ?? [])].sort((a, b) => a.buffer - b.buffer).map((pool) => (
          <section key={pool.pool.id} className="card tbl-wrap">
            <div className="card-h">
              <h2>{poolName(pool.pool.kind, pool.pool.dex, pool.pool.token, pool.positions[0]?.position.coin)}</h2>
              <span className="chip">
                <span className="faint">Equity</span>
                <span className="num">{fmtUsd(pool.equity)}</span>
              </span>
              <span className="chip">
                <span className="faint">Maintenance</span>
                <span className="num">{fmtUsd(pool.maintenance)}</span>
              </span>
              <span className={`chip ${lines.length && pool.buffer < Math.min(...lines) ? 'chip-crit' : lines.length && pool.buffer < Math.max(...lines) ? 'chip-warn' : 'chip-guard'}`} style={{ marginLeft: 'auto' }}>
                <i />
                Buffer <span className="num">{fmtBuffer(pool.buffer)}</span>
              </span>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th className="r">Size</th>
                  <th className="r hide-sm">Notional</th>
                  <th className="r hide-sm">Entry</th>
                  <th className="r hide-sm">Mark</th>
                  <th className="r">uPnL</th>
                  <th className="r">Liq. price</th>
                </tr>
              </thead>
              <tbody>
                {pool.positions.map((r) => (
                  <tr key={r.position.key}>
                    <td>
                      <Link href={r.position.dex === 'xyz' ? `/app/trade/${r.position.coin.replace('xyz:', '')}` : '#'}>
                        <b>{r.position.coin.replace('xyz:', '')}</b>
                      </Link>
                    </td>
                    <td className={r.position.size > 0 ? 'long' : 'short'}>
                      {r.position.size > 0 ? 'Long' : 'Short'} {r.position.leverage}×
                    </td>
                    <td className="r num">{Math.abs(r.position.size)}</td>
                    <td className="r num hide-sm">{fmtUsd(r.notional)}</td>
                    <td className="r num hide-sm">{fmtPx(r.position.entryPx)}</td>
                    <td className="r num hide-sm">{fmtPx(r.mark)}</td>
                    <td className={`r num ${upDown(r.unrealizedPnl)}`}>{fmtSignedUsd(r.unrealizedPnl)}</td>
                    <td className="r num">{r.liquidationPx ? fmtPx(r.liquidationPx) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
        {risk && !risk.pools.length ? <div className="callout">No open positions.</div> : null}

      </div>
    </>
  );
}
