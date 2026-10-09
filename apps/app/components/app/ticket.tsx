'use client';

import { BUILDER_ADDRESS, BUILDER_FEE_TENTHS_BPS } from '@bulwarkxyz/config';
import { roundPrice, toWire } from '@bulwarkxyz/guard-core';
import { orderAction, orderWire, updateLeverageAction, type ExchangeResult } from '@bulwarkxyz/hyperliquid';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BUILDER_ON, NETWORK } from '@/lib/env';
import { describeAction, type GuardView } from '@/lib/guard';
import { realisedFeeBps, useAccountView, useAssets, useFills, type MarketCtx } from '@/lib/hl';
import type { Market } from '@/lib/markets';
import { useMe } from '@/lib/me';
import { previewOrder } from '@/lib/preview';
import { regionHold, regionNote, useTicketRegion } from '@/lib/region';
import { useViewer } from '@/lib/review';
import { sendWithTradingKey, tradingKey } from '@/lib/signing';
import { ticketIntent } from '@/lib/ticket-intent';
import { fmtBuffer, fmtPct, fmtPx, fmtUsd } from './format';
import { Icon } from './icons';
import { walletErrorText } from '@/lib/wallet-errors';

/**
 * The order ticket. Every number field starts empty ("Your …"); the guard preview shows what the
 * guard will see after this order, from the user's own lines. Orders are signed by the browser
 * trading key; the guard key only ever reduces (enforced by our engine, not Hyperliquid).
 */
export function Ticket({ m, ctx, g, open, stale, loading, initialSide = 'long', compact }: { m: Market; ctx: MarketCtx | undefined; g: GuardView; open: boolean; stale: boolean; loading?: boolean; initialSide?: 'long' | 'short'; compact?: boolean }) {
  const { address, connected } = useViewer();
  const view = useAccountView(address);
  const assets = useAssets();
  const me = useMe();
  const fills = useFills(address);
  const [side, setSide] = useState<'long' | 'short'>(initialSide);
  const [type, setType] = useState<'market' | 'limit'>('market');
  const [size, setSize] = useState('');
  const [lev, setLev] = useState('');
  const [limitPx, setLimitPx] = useState('');
  const [slip, setSlip] = useState(me.data?.policy ? String(me.data.policy.policy.execution.maxSlippagePct) : '');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExchangeResult | { error: string } | null>(null);
  const [closing, setClosing] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // "Close" on a position row: fill the ticket, never send.
  useEffect(
    () =>
      ticketIntent.on((i) => {
        if (i.coin !== m.coin) return;
        setSide(i.side);
        setType('market');
        setSize(i.size);
        setReduceOnly(true);
        setResult(null);
        setClosing(true);
        root.current?.scrollIntoView({ block: 'nearest' });
        root.current?.querySelector<HTMLInputElement>('[id^="slip-"]')?.focus();
      }),
    [m.coin],
  );

  const sizeN = Number(size);
  const levN = Math.floor(Number(lev));
  const notional = ctx && sizeN > 0 ? sizeN * ctx.mark : 0;
  const preview = useMemo(
    () =>
      view.data && assets.data && ctx && sizeN > 0 && levN > 0 && !reduceOnly
        ? previewOrder({ snapshot: view.data.snapshot, assets: assets.data.assets, coin: m.coin, delta: side === 'long' ? sizeN : -sizeN, mark: ctx.mark, leverage: levN, lines: g.lines })
        : null,
    [view.data, assets.data, ctx, sizeN, levN, side, reduceOnly, m.coin, g.lines],
  );
  const existing = view.data?.snapshot.positions.find((p) => p.coin === m.coin);
  const available = view.data?.risk.idle.reduce((s, i) => s + i.available, 0);
  const builderApproved = (me.data?.builder.approvedMaxTenthsBps ?? 0) >= BUILDER_FEE_TENTHS_BPS;
  const attachBuilder = BUILDER_ON && builderApproved;
  const paidBps = realisedFeeBps(fills.data, m.coin);
  const hasKey = Boolean(address && tradingKey(address));
  // Asked when the ticket opens and again before each new order (submit).
  const { region, refresh: refreshRegion, checking: regionChecking } = useTicketRegion(connected);
  const held = connected ? regionHold(region, reduceOnly) : null;
  const note = connected ? regionNote(region) : null;
  const ruleAt = (line: number) => g.rules.find((r) => r.when.kind === 'buffer' && r.when.below === line);

  const problem = stale
    ? 'Paused: market data is not updating.'
    : ctx?.delisted
      ? `${m.ticker} is delisted${NETWORK === 'testnet' ? ' on testnet' : ''}.`
      : !connected
        ? null
        : held
          ? held
          : !hasKey
          ? 'Approve a trading key first (Settings or setup).'
          : !(sizeN > 0)
            ? 'Type a size.'
            : !reduceOnly && !(levN >= 1 && ctx && levN <= ctx.maxLeverage)
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
      // The region again, right before a new order: where the user is now, not when the ticket opened.
      const hold = regionHold(await refreshRegion(), reduceOnly);
      if (hold) {
        setResult({ error: hold });
        return;
      }
      if (!reduceOnly && (!existing || existing.leverage !== levN)) {
        const res = await sendWithTradingKey(address, updateLeverageAction(asset.assetId, !asset.onlyIsolated, levN));
        if (!res.ok) throw new Error(`leverage: ${res.error}`);
      }
      const isBuy = side === 'long';
      const px = type === 'limit' ? roundPrice(Number(limitPx), asset.szDecimals, isBuy ? 'down' : 'up') : roundPrice(ctx.mark * (1 + ((isBuy ? 1 : -1) * Number(slip)) / 100), asset.szDecimals, isBuy ? 'up' : 'down');
      const wire = orderWire({ asset: asset.assetId, isBuy, limitPx: toWire(px), size: toWire(Math.floor(sizeN * 10 ** asset.szDecimals) / 10 ** asset.szDecimals), reduceOnly, orderType: { limit: { tif: type === 'market' ? 'Ioc' : 'Gtc' } } });
      setResult(await sendWithTradingKey(address, orderAction([wire], attachBuilder ? { b: BUILDER_ADDRESS, f: BUILDER_FEE_TENTHS_BPS } : null)));
    } catch (e) {
      setResult({ error: walletErrorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const move = (px: number) => (ctx ? fmtPct(((px - ctx.mark) / ctx.mark) * 100, 1) : '');
  return (
    <div className="pb col" style={{ gap: 10 }} ref={root}>
      {closing && reduceOnly ? (
        <div className="banner" role="status">
          <span>
            <b>Closing your {m.ticker} position.</b> The ticket is set to {side === 'long' ? 'buy' : 'sell'} {size} {m.ticker} at market, reduce-only. Check it and send.
          </span>
          <span className="sp" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setClosing(false); setReduceOnly(false); setSize(''); }}>
            Clear
          </button>
        </div>
      ) : null}
      <div className="row nw">
        <span className="chip chip-sm">{ctx ? (ctx.onlyIsolated ? 'Isolated only' : 'Cross or isolated') : '—'}</span>
        <span className="sp" />
        <span className="tiny t3">
          Max <span className="num">{ctx ? `${ctx.maxLeverage}×` : '—'}</span>
        </span>
      </div>
      <div className="seg" role="radiogroup" aria-label="Side">
        <button type="button" className={side === 'long' ? 'on-long' : ''} aria-pressed={side === 'long'} onClick={() => setSide('long')}>
          Long
        </button>
        <button type="button" className={side === 'short' ? 'on-short' : ''} aria-pressed={side === 'short'} onClick={() => setSide('short')}>
          Short
        </button>
      </div>
      <div className="tabs" style={{ padding: 0, minHeight: 32 }} role="tablist" aria-label="Order type">
        <button type="button" role="tab" aria-selected={type === 'market'} className={type === 'market' ? 'on' : ''} onClick={() => setType('market')}>
          Market
        </button>
        <button type="button" role="tab" aria-selected={type === 'limit'} className={type === 'limit' ? 'on' : ''} onClick={() => setType('limit')}>
          Limit
        </button>
      </div>
      {connected && view.data ? (
        <>
          <div className="kv" style={{ padding: 0 }}>
            <span className="small">Available</span>
            <span className="num small">{available !== undefined ? fmtUsd(available) : '—'}</span>
          </div>
          <div className="kv" style={{ padding: 0 }}>
            <span className="small">Current position</span>
            <span className="small">
              {existing ? (
                <>
                  <span className={existing.size > 0 ? 'long b' : 'short b'}>{existing.size > 0 ? 'Long' : 'Short'}</span> <span className="num">{Math.abs(existing.size)}</span>
                </>
              ) : (
                'None'
              )}
            </span>
          </div>
        </>
      ) : null}
      <div className="field">
        <label htmlFor={`sz-${compact ? 'm' : 'd'}`}>Size</label>
        <div className="input">
          <input id={`sz-${compact ? 'm' : 'd'}`} inputMode="decimal" placeholder="Your size" value={size} onChange={(e) => setSize(e.target.value)} />
          <span className="unit">{m.ticker}</span>
        </div>
      </div>
      <div className={compact ? 'row nw' : 'col'} style={{ gap: compact ? 8 : 10, alignItems: 'stretch' }}>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor={`lev-${compact ? 'm' : 'd'}`}>Leverage</label>
          <div className="input">
            <input id={`lev-${compact ? 'm' : 'd'}`} inputMode="numeric" placeholder={reduceOnly ? 'Not used: reduce-only' : 'Your leverage'} disabled={reduceOnly} value={reduceOnly ? '' : lev} onChange={(e) => setLev(e.target.value)} />
            <span className="unit">× · max {ctx?.maxLeverage ?? '—'}</span>
          </div>
        </div>
        {type === 'limit' ? (
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor={`px-${compact ? 'm' : 'd'}`}>Limit price</label>
            <div className="input">
              <input id={`px-${compact ? 'm' : 'd'}`} inputMode="decimal" placeholder="Your price" value={limitPx} onChange={(e) => setLimitPx(e.target.value)} />
            </div>
          </div>
        ) : (
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor={`slip-${compact ? 'm' : 'd'}`}>Max slippage</label>
            <div className="input">
              <input id={`slip-${compact ? 'm' : 'd'}`} inputMode="decimal" placeholder="Your slippage" value={slip} onChange={(e) => setSlip(e.target.value)} />
              <span className="unit">%</span>
            </div>
          </div>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />
        Reduce only
      </label>

      {!open ? (
        <div className="banner">
          {Icon.moon()}
          <span>
            {m.ticker}’s home market is closed. It still trades on trade.xyz’s off-hours price{m.bound ? `, held within ±${m.bound.pct}% (${m.bound.resets} resets)` : ''}. Books are thinner. The guard keeps watching and acts on the same mark.
          </span>
        </div>
      ) : null}

      <div className="banner b-guard" style={{ flexDirection: 'column', gap: 6, alignItems: 'stretch' }}>
        <div className="row nw">
          <b className="small">What the guard will do</b>
          <span className="sp" />
          <span className="tiny t3">{g.exampleRules ? 'example rules' : 'your rules, this order'}</span>
        </div>
        {loading ? (
          <span className="sk" style={{ width: '80%' }} />
        ) : !connected ? (
          <span className="small t2">Connect a wallet to see where the guard would act on this order.</span>
        ) : !g.lines.length ? (
          <span className="small t2">No buffer lines yet, so the guard would not act. <Link href="/app/rules" style={{ textDecoration: 'underline' }}>Write a rule</Link>.</span>
        ) : preview ? (
          <>
            <div className="kv" style={{ padding: 0 }}>
              <span className="small">Buffer{existing ? `, ${m.ticker} pool` : ''}</span>
              <span className="num small">
                {preview.bufferBefore !== null ? `${fmtBuffer(preview.bufferBefore)} → ` : ''}
                <b>{fmtBuffer(preview.bufferAfter)}</b>
              </span>
            </div>
            {preview.guardAt ? (
              <div className="kv" style={{ padding: 0 }}>
                <span className="small">First guard action</span>
                <span className="num small">
                  {(ruleAt(preview.guardAt.line)?.then.map(describeAction).join(', ') ?? 'acts')} at {fmtPx(preview.guardAt.price)} <span className="t3">{move(preview.guardAt.price)}</span>
                </span>
              </div>
            ) : (
              <div className="kv" style={{ padding: 0 }}>
                <span className="small">First guard action</span>
                <span className="small t2">{preview.bufferAfter <= Math.max(...g.lines) ? 'a line is already crossed' : 'no line within reach'}</span>
              </div>
            )}
            <div className="kv" style={{ padding: 0 }}>
              <span className="small">Liquidation without the guard</span>
              <span className="num small ct">{preview.liquidationPx ? `${fmtPx(preview.liquidationPx)} ` : 'none '}<span className="t3">{preview.liquidationPx ? move(preview.liquidationPx) : ''}</span></span>
            </div>
          </>
        ) : (
          <span className="small t2">Type a size and leverage to see where the guard would act and where Hyperliquid would liquidate.</span>
        )}
      </div>

      {!connected ? (
        <Link className="btn btn-ink btn-lg btn-block" href="/app/onboarding">
          Connect wallet to trade
        </Link>
      ) : loading ? (
        <button type="button" className="btn btn-lg btn-block" disabled>
          Loading market…
        </button>
      ) : (
        <button type="button" className={`btn btn-lg btn-block ${problem ? '' : side === 'long' ? 'btn-long' : 'btn-short'}`} disabled={Boolean(problem) || busy} onClick={submit}>
          {busy ? 'Sending…' : stale ? 'Paused: market data is stale' : `${side === 'long' ? 'Long' : 'Short'} ${size || ''} ${m.ticker} ${type === 'market' ? 'at market' : 'limit'}`}
        </button>
      )}
      {problem && connected && !stale ? <span className={held && held === problem && region.kind === 'answer' ? 'small ct' : 'tiny t3'}>{problem}</span> : null}
      {held && region.kind === 'unknown' ? (
        <button type="button" className="btn btn-sm" disabled={regionChecking} onClick={() => void refreshRegion()}>
          {regionChecking ? 'Checking…' : 'Check again'}
        </button>
      ) : null}
      {note ? <span className="tiny t2">{note}</span> : null}
      {result ? (
        'error' in result && !('statuses' in result) ? (
          <span className="small ct">{result.error}</span>
        ) : (
          <span className={`small ${(result as ExchangeResult).ok ? '' : 'ct'}`}>
            {(result as ExchangeResult).ok ? (result as ExchangeResult).statuses.map((s) => (s.kind === 'filled' ? `Filled ${s.totalSz} @ ${s.avgPx}` : s.kind === 'resting' ? `Resting #${s.oid}` : s.kind)).join(', ') : (result as ExchangeResult).error}
          </span>
        )
      ) : null}

      <div className="col" style={{ gap: 0 }}>
        <div className="kv" style={{ padding: '2px 0' }}>
          <span className="small">Order value</span>
          <span className="num small">{notional ? fmtUsd(notional) : '—'}</span>
        </div>
        <div className="kv" style={{ padding: '2px 0' }}>
          <span className="small">Margin required</span>
          <span className="num small">{notional && levN > 0 ? fmtUsd(notional / levN) : '—'}</span>
        </div>
        <div className="kv" style={{ padding: '2px 0' }}>
          <span className="small">Hyperliquid fee · your rate on {m.ticker}</span>
          <span className="num small">{paidBps === null ? 'no fills yet' : `${(paidBps / 100).toFixed(4)}%`}</span>
        </div>
        <div className="kv" style={{ padding: '2px 0' }}>
          <span className="small">Bulwark fee</span>
          <span className="num small">{attachBuilder ? '0.03% · 3 bps' : NETWORK === 'testnet' ? 'none on testnet' : 'none'}</span>
        </div>
      </div>
      <div className="disclose">
        {Icon.shield(14)}
        <span>
          You sign this order with your browser trading key. Afterwards the guard key may only send reduce-only orders for it: <b>our engine enforces that, not Hyperliquid</b>. The guard key cannot withdraw.
        </span>
      </div>
    </div>
  );
}
