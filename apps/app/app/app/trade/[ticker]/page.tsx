'use client';

import { BUILDER_ADDRESS, BUILDER_FEE_TENTHS_BPS } from '@bulwarkxyz/config';
import { roundPrice, toWire } from '@bulwarkxyz/guard-core';
import { orderAction, orderWire, updateLeverageAction, type ExchangeResult } from '@bulwarkxyz/hyperliquid';
import Link from 'next/link';
import { use, useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { LineChart } from '@/components/app/chart';
import { fmtBuffer, fmtPct, fmtPx, fmtSignedUsd, upDown } from '@/components/app/format';
import { TopBar } from '@/components/app/shell';
import { BUILDER_ON } from '@/lib/env';
import { realisedFeeBps, useAccountView, useAssets, useCandles, useFills, useXyzMarkets } from '@/lib/hl';
import { MARKETS, homeOpen, sessionLabel } from '@/lib/markets';
import { useMe } from '@/lib/me';
import { previewOrder } from '@/lib/preview';
import { sendWithTradingKey, tradingKey } from '@/lib/signing';

export default function TradePage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = use(params);
  const m = MARKETS.find((x) => x.ticker === ticker.toUpperCase()) ?? MARKETS[0]!;
  const { address } = useAccount();
  const markets = useXyzMarkets();
  const ctx = markets.data?.get(m.coin);
  const candles = useCandles(m.coin, '1h', 24 * 5);
  const view = useAccountView(address);
  const assets = useAssets();
  const me = useMe();
  const fills = useFills(address);

  const [side, setSide] = useState<'long' | 'short'>('long');
  const [type, setType] = useState<'market' | 'limit'>('market');
  const [size, setSize] = useState('');
  const [lev, setLev] = useState('');
  const [limitPx, setLimitPx] = useState('');
  const [slip, setSlip] = useState(me.data?.policy ? String(me.data.policy.policy.execution.maxSlippagePct) : '');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExchangeResult | { error: string } | null>(null);

  const now = Date.now();
  const lines = me.data?.policy?.policy.rules.filter((r) => r.when.kind === 'buffer').map((r) => (r.when as { below: number }).below) ?? [];
  const sizeN = Number(size);
  const levN = Math.floor(Number(lev));
  const notional = ctx && sizeN > 0 ? sizeN * ctx.mark : 0;
  const preview = useMemo(
    () =>
      view.data && assets.data && ctx && sizeN > 0 && levN > 0 && !reduceOnly
        ? previewOrder({ snapshot: view.data.snapshot, assets: assets.data.assets, coin: m.coin, delta: side === 'long' ? sizeN : -sizeN, mark: ctx.mark, leverage: levN, highestLine: lines.length ? Math.max(...lines) : null })
        : null,
    [view.data, assets.data, ctx, sizeN, levN, side, reduceOnly, m.coin, lines],
  );
  const positions = view.data?.snapshot.positions.filter((p) => p.dex === 'xyz') ?? [];
  const builderApproved = (me.data?.builder.approvedMaxTenthsBps ?? 0) >= BUILDER_FEE_TENTHS_BPS;
  const attachBuilder = BUILDER_ON && builderApproved;
  const ourFee = attachBuilder ? notional * (BUILDER_FEE_TENTHS_BPS / 1e5) : 0;
  const paidBps = realisedFeeBps(fills.data, m.coin);
  const hasKey = Boolean(address && tradingKey(address));

  const problem = !address
    ? 'Connect a wallet to trade.'
    : !hasKey
      ? 'Approve a trading key in Settings first.'
      : !(sizeN > 0)
        ? 'Type a size.'
        : !(levN >= 1 && ctx && levN <= ctx.maxLeverage)
          ? `Type a leverage from 1 to ${ctx?.maxLeverage ?? '—'}.`
          : type === 'limit' && !(Number(limitPx) > 0)
            ? 'Type a limit price.'
            : type === 'market' && !(Number(slip) > 0 && Number(slip) <= 10)
              ? 'Type your max slippage (up to 10%).'
              : notional < 10 && !reduceOnly
                ? 'Orders must be at least $10.'
                : null;

  async function submit() {
    if (problem || !address || !ctx || !assets.data) return;
    const asset = assets.data.assets.get(m.coin)!;
    setBusy(true);
    setResult(null);
    try {
      const existing = positions.find((p) => p.coin === m.coin);
      if (!reduceOnly && (!existing || existing.leverage !== levN)) {
        const res = await sendWithTradingKey(address, updateLeverageAction(asset.assetId, !asset.onlyIsolated, levN));
        if (!res.ok) throw new Error(`leverage: ${res.error}`);
      }
      const isBuy = side === 'long';
      const px = type === 'limit' ? roundPrice(Number(limitPx), asset.szDecimals, isBuy ? 'down' : 'up') : roundPrice(ctx.mark * (1 + ((isBuy ? 1 : -1) * Number(slip)) / 100), asset.szDecimals, isBuy ? 'up' : 'down');
      const wire = orderWire({ asset: asset.assetId, isBuy, limitPx: toWire(px), size: toWire(Math.floor(sizeN * 10 ** asset.szDecimals) / 10 ** asset.szDecimals), reduceOnly, orderType: { limit: { tif: type === 'market' ? 'Ioc' : 'Gtc' } } });
      setResult(await sendWithTradingKey(address, orderAction([wire], attachBuilder ? { b: BUILDER_ADDRESS, f: BUILDER_FEE_TENTHS_BPS } : null)));
    } catch (e) {
      setResult({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const open = homeOpen(m.session, now);
  return (
    <>
      <TopBar title={`${m.ticker} · ${m.name}`}>
        <span className="big num hide-sm" style={{ fontSize: 22, marginLeft: 8 }}>
          {ctx ? fmtPx(ctx.mark) : '—'}
        </span>
        {ctx ? <span className={`num hide-sm ${upDown(ctx.change)}`}>{fmtPct(ctx.change * 100)}</span> : null}
        <span className={`chip hide-sm ${open ? 'chip-guard' : ''}`}>
          <i />
          {sessionLabel(m.session, now)}
        </span>
        {ctx ? (
          <span className="chip hide-sm">
            <span className="faint">Funding</span>
            <span className="num">{fmtPct(ctx.fundingAprPct, 1, false)} APR</span>
          </span>
        ) : null}
      </TopBar>
      <div className="content" style={{ maxWidth: 'none' }}>
        <div className="row" style={{ gap: 6 }}>
          {MARKETS.map((x) => (
            <Link key={x.coin} href={`/app/trade/${x.ticker}`} className={`chip ${x.coin === m.coin ? 'chip-guard' : ''}`}>
              {x.ticker}
            </Link>
          ))}
        </div>
        <div className="split">
          <div className="stack" style={{ gap: 20 }}>
            <div className="card">
              <div className="card-h">
                <h2>Price</h2>
                <span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>
                  1h closes, 5 days
                </span>
              </div>
              <div className="card-b">
                <LineChart points={candles.data ?? []} label={m.coin} loading={candles.isLoading} />
              </div>
            </div>
            <div className="card tbl-wrap">
              <div className="card-h">
                <h2>Your positions on xyz</h2>
                <Link className="btn btn-sm btn-ghost" href="/app/positions" style={{ marginLeft: 'auto' }}>
                  Positions
                </Link>
              </div>
              {positions.length ? (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Market</th>
                      <th>Side</th>
                      <th className="r">Size</th>
                      <th className="r hide-sm">Entry</th>
                      <th className="r">uPnL</th>
                      <th className="r hide-sm">Liq. price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.data!.risk.pools.flatMap((pool) =>
                      pool.positions
                        .filter((r) => r.position.dex === 'xyz')
                        .map((r) => (
                          <tr key={r.position.key}>
                            <td>
                              <b>{r.position.coin.replace('xyz:', '')}</b>
                            </td>
                            <td className={r.position.size > 0 ? 'long' : 'short'}>
                              {r.position.size > 0 ? 'Long' : 'Short'} {r.position.leverage}×
                            </td>
                            <td className="r num">{Math.abs(r.position.size)}</td>
                            <td className="r num hide-sm">{fmtPx(r.position.entryPx)}</td>
                            <td className={`r num ${upDown(r.unrealizedPnl)}`}>{fmtSignedUsd(r.unrealizedPnl)}</td>
                            <td className="r num hide-sm">{r.liquidationPx ? fmtPx(r.liquidationPx) : '—'}</td>
                          </tr>
                        )),
                    )}
                  </tbody>
                </table>
              ) : (
                <div className="card-b faint">{address ? 'No xyz positions.' : 'Connect a wallet to see your positions.'}</div>
              )}
            </div>
          </div>

          <aside className="card" aria-label="Order ticket">
            <div className="card-b stack" style={{ gap: 16 }}>
              <div className="seg" role="radiogroup" aria-label="Side">
                <button type="button" className={side === 'long' ? 'on-long' : ''} aria-pressed={side === 'long'} onClick={() => setSide('long')}>
                  Long
                </button>
                <button type="button" className={side === 'short' ? 'on' : ''} aria-pressed={side === 'short'} onClick={() => setSide('short')} style={side === 'short' ? { background: 'var(--short)', color: '#1C0B00' } : undefined}>
                  Short
                </button>
              </div>
              <div className="seg" role="tablist" aria-label="Order type">
                <button type="button" className={type === 'market' ? 'on' : ''} onClick={() => setType('market')}>
                  Market
                </button>
                <button type="button" className={type === 'limit' ? 'on' : ''} onClick={() => setType('limit')}>
                  Limit
                </button>
              </div>
              <div className="field">
                <label htmlFor="sz">Size</label>
                <div className="input">
                  <input id="sz" inputMode="decimal" placeholder="Your size" value={size} onChange={(e) => setSize(e.target.value)} />
                  <span className="faint">{m.ticker}</span>
                </div>
                <span className="faint num" style={{ fontSize: 12 }}>
                  {notional ? `≈ $${notional.toFixed(2)} notional` : ' '}
                </span>
              </div>
              <div className="field">
                <label htmlFor="lev">Leverage · {ctx?.onlyIsolated ? 'isolated' : 'cross'}</label>
                <div className="input">
                  <input id="lev" inputMode="numeric" placeholder="Your leverage" value={lev} onChange={(e) => setLev(e.target.value)} />
                  <span className="faint">max {ctx?.maxLeverage ?? '—'}×</span>
                </div>
              </div>
              {type === 'limit' ? (
                <div className="field">
                  <label htmlFor="px">Limit price</label>
                  <div className="input">
                    <input id="px" inputMode="decimal" placeholder="Your price" value={limitPx} onChange={(e) => setLimitPx(e.target.value)} />
                  </div>
                </div>
              ) : (
                <div className="field">
                  <label htmlFor="slip">Max slippage</label>
                  <div className="input">
                    <input id="slip" inputMode="decimal" placeholder="Your number" value={slip} onChange={(e) => setSlip(e.target.value)} />
                    <span className="faint">%</span>
                  </div>
                </div>
              )}
              <label className="check">
                <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />
                Reduce only
              </label>

              <div className="callout guard" style={{ flexDirection: 'column', gap: 8 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b style={{ color: 'var(--guard-text)' }}>Guard preview</b>
                  <span className={`chip ${me.data?.policy ? 'chip-guard' : ''}`}>
                    <i />
                    {me.data?.policy ? 'Covered' : 'No rules yet'}
                  </span>
                </div>
                {preview ? (
                  <>
                    <div className="kv">
                      <span>Buffer after order</span>
                      <span className="num">
                        {preview.bufferBefore !== null ? `${fmtBuffer(preview.bufferBefore)} → ` : ''}
                        {fmtBuffer(preview.bufferAfter)}
                      </span>
                    </div>
                    {preview.firstLinePx ? (
                      <div className="kv">
                        <span>Your first line fires at</span>
                        <span className="num">
                          {fmtPx(preview.firstLinePx)} ({fmtPct(((preview.firstLinePx - (ctx?.mark ?? 0)) / (ctx?.mark ?? 1)) * 100, 1)})
                        </span>
                      </div>
                    ) : null}
                    <div className="kv">
                      <span>Liquidation without the guard</span>
                      <span className="num">{preview.liquidationPx ? `${fmtPx(preview.liquidationPx)} (${fmtPct(((preview.liquidationPx - (ctx?.mark ?? 0)) / (ctx?.mark ?? 1)) * 100, 1)})` : 'none'}</span>
                    </div>
                    <span className="faint" style={{ fontSize: 12 }}>
                      Estimate at the current mark, fees ignored.
                    </span>
                  </>
                ) : (
                  <span className="faint" style={{ fontSize: 13 }}>
                    Type a size and leverage to see what the guard will see.
                  </span>
                )}
              </div>

              <div>
                <div className="kv">
                  <span>Your fee rate paid on {m.ticker}</span>
                  <span className="num">{paidBps === null ? 'no fills yet' : `${paidBps.toFixed(2)} bps`}</span>
                </div>
                <div className="kv">
                  <span>Our fee · builder code</span>
                  <span className="num">{attachBuilder ? `3 bps · $${ourFee.toFixed(2)}` : 'none'}</span>
                </div>
              </div>
              <button type="button" className={`btn ${side === 'long' ? 'btn-long' : 'btn-short'}`} disabled={Boolean(problem) || busy} onClick={submit}>
                {busy ? 'Sending…' : `${side === 'long' ? 'Long' : 'Short'} ${size || ''} ${m.ticker} ${type === 'market' ? 'at market' : 'limit'}`}
              </button>
              {problem ? (
                <span className="faint" style={{ fontSize: 12 }}>
                  {problem}
                </span>
              ) : null}
              {result ? (
                'error' in result && !('statuses' in result) ? (
                  <span className="err" style={{ fontSize: 13 }}>{result.error}</span>
                ) : (
                  <span className={(result as ExchangeResult).ok ? 'ok-text' : 'err'} style={{ fontSize: 13 }}>
                    {(result as ExchangeResult).ok ? (result as ExchangeResult).statuses.map((s) => (s.kind === 'filled' ? `Filled ${s.totalSz} @ ${s.avgPx}` : s.kind === 'resting' ? `Resting #${s.oid}` : s.kind)).join(', ') : (result as ExchangeResult).error}
                  </span>
                )
              ) : null}
              <span className="faint" style={{ fontSize: 12 }}>
                Signed by your browser trading key. Later, the guard only ever sends reduce-only orders for this position.
              </span>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
