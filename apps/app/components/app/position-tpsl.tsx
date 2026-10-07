'use client';

import { cancelAction, type ExchangeResult } from '@bulwarkxyz/hyperliquid';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { NETWORK, TPSL_BUILD } from '@/lib/env';
import { useGuardOrders } from '@/lib/guard';
import { useAssets, useOpenOrders, useXyzMarkets, type OpenOrder } from '@/lib/hl';
import { useReview, useViewer } from '@/lib/review';
import { sendWithTradingKey, tradingKey } from '@/lib/signing';
import { buildPositionTpsl, tpslAction } from '@/lib/tpsl';
import { walletErrorText } from '@/lib/wallet-errors';
import { fmtPx } from './format';
import { Popover } from './popover';

const noop = () => () => {};
/** TP/SL is on for this browser: the build switch, or the testnet opt-in (lib/env.ts TPSL_BUILD). */
export function useTpslOn(): boolean {
  return useSyncExternalStore(
    noop,
    () => {
      if (TPSL_BUILD) return true;
      try {
        return NETWORK === 'testnet' && localStorage.getItem('bw.tpsl') === '1';
      } catch {
        return false;
      }
    },
    () => false,
  );
}

/**
 * The user's own TP/SL triggers on a market: reduce-only triggers that aren't the guard's. The guard's
 * backstops are the same kind of order on Hyperliquid, so this is only known once the guard's own list has
 * been read (signed in). Until then nothing is listed as the user's, and nothing can be cancelled here.
 */
function useOwnTriggers(coin: string) {
  const { address } = useViewer();
  const orders = useOpenOrders(address);
  const guard = useGuardOrders(address);
  const mine = new Set(guard.orders.map((o) => o.oid));
  const list = ownTriggers(orders.data ?? [], mine, coin, guard.known);
  return { q: orders, known: guard.known, list };
}

/** Pure: the user's own reduce-only triggers on `coin`, or none while the guard's orders are unknown. */
export function ownTriggers(orders: readonly OpenOrder[], guardOids: ReadonlySet<number>, coin: string, known: boolean): OpenOrder[] {
  return known ? orders.filter((o) => o.coin === coin && o.isTrigger && o.reduceOnly && !guardOids.has(o.oid)) : [];
}

const kindOf = (o: OpenOrder) => (/take profit/i.test(o.orderType) ? 'Take profit' : /stop/i.test(o.orderType) ? 'Stop loss' : o.orderType);

/** The TP/SL button on a position row: shows what's set, opens the panel. */
export function PositionTpslButton({ coin, size, liquidationPx }: { coin: string; size: number; liquidationPx: number | null }) {
  const on = useTpslOn();
  const { list } = useOwnTriggers(coin);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (!on) return null;
  const tp = list.find((o) => kindOf(o) === 'Take profit');
  const sl = list.find((o) => kindOf(o) === 'Stop loss');
  const label = tp || sl ? [tp ? `TP ${fmtPx(Number(tp.triggerPx))}` : null, sl ? `SL ${fmtPx(Number(sl.triggerPx))}` : null].filter(Boolean).join(' · ') : 'TP/SL';
  return (
    <>
      <button ref={btn} type="button" className="btn btn-sm" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={tp || sl ? 'num' : ''}>{label}</span>
      </button>
      <Popover anchor={btn} open={open} onClose={close} label={`Take profit and stop loss, ${coin.replace(/^xyz:/, '')}`} width={380}>
        <TpslPanel coin={coin} size={size} liquidationPx={liquidationPx} />
      </Popover>
    </>
  );
}

function TpslPanel({ coin, size, liquidationPx }: { coin: string; size: number; liquidationPx: number | null }) {
  const review = useReview();
  const { address } = useViewer();
  const markets = useXyzMarkets();
  const assets = useAssets();
  const qc = useQueryClient();
  const { q, known, list } = useOwnTriggers(coin);
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [slip, setSlip] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ctx = markets.data?.get(coin);
  const asset = assets.data?.assets.get(coin);
  const ticker = coin.replace(/^xyz:/, '');
  const long = size > 0;
  const r = ctx && asset ? buildPositionTpsl({ asset: asset.assetId, szDecimals: asset.szDecimals, size, mark: ctx.mark, oracle: ctx.oracle, tp, sl, slippage: slip, liquidationPx }) : null;
  const key = address ? tradingKey(address) : null;
  // A watched account (review builds) or no trading key: show what's set, sign nothing.
  const blocked = review.on && review.watch ? 'This is a watched account: nothing can be signed for it.' : !key ? 'Your trading key signs these orders. Set it up first.' : null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['open-orders'] });

  async function place() {
    if (!r?.ok || !address) return;
    setBusy('place');
    setMsg(null);
    try {
      const res: ExchangeResult = await sendWithTradingKey(address, tpslAction(r.legs));
      // A whole-request refusal has no statuses; otherwise each order answers for itself, so one can rest
      // while the other is refused.
      if (!res.statuses.length) throw new Error(res.error ?? 'Hyperliquid did not answer.');
      const name = (i: number) => (r.legs[i]!.kind === 'tp' ? 'Take profit' : 'Stop loss');
      const parts = res.statuses.map((st, i) => (st.kind === 'error' ? `${name(i)} refused: ${st.error}` : st.kind === 'resting' ? `${name(i)} resting` : `${name(i)}: ${st.kind}`));
      const allRest = res.statuses.every((st) => st.kind === 'resting');
      setMsg({ ok: allRest, text: `${parts.join(' · ')}.` });
      if (allRest) {
        setTp('');
        setSl('');
      }
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: walletErrorText(e) });
    } finally {
      setBusy(null);
    }
  }
  async function cancel(o: OpenOrder) {
    if (!address || !asset) return;
    setBusy(`cancel-${o.oid}`);
    setMsg(null);
    try {
      const res = await sendWithTradingKey(address, cancelAction([{ asset: asset.assetId, oid: o.oid }]));
      if (!res.ok) throw new Error(res.error ?? 'Hyperliquid did not cancel it.');
      setMsg({ ok: true, text: `${kindOf(o)} at ${fmtPx(Number(o.triggerPx))} cancelled.` });
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: walletErrorText(e) });
    } finally {
      setBusy(null);
    }
  }

  const move = (px: number) => (ctx ? `${px >= ctx.mark ? '+' : '−'}${Math.abs((px / ctx.mark - 1) * 100).toFixed(1)}%` : '');
  return (
    <div className="wm col">
      <div className="col" style={{ gap: 0 }}>
        <b className="small">Take profit and stop loss</b>
        <span className="tiny t2">
          {ticker} {long ? 'long' : 'short'} <span className="num">{Math.abs(size)}</span>
          {ctx ? (
            <>
              {' '}
              · price now <span className="num">{fmtPx(ctx.mark)}</span>
            </>
          ) : null}{' '}
          <span className="tag tag-net">testnet</span>
        </span>
      </div>

      {!known ? (
        <span className="small t2">Sign in to see the stops already on this position: the guard’s own backstops rest on Hyperliquid too, and the app only lists yours once it knows which are the guard’s.</span>
      ) : q.isLoading ? (
        <span className="sk" style={{ width: '70%' }} />
      ) : list.length ? (
        <ul className="tpsl-list">
          {list.map((o) => (
            <li key={o.oid} className="row nw">
              <span className="col" style={{ gap: 0, flex: 1, minWidth: 0 }}>
                <span className="small">
                  {kindOf(o)} at <span className="num">{fmtPx(Number(o.triggerPx))}</span>
                </span>
                <span className="tiny t3">
                  {o.triggerCondition ?? o.orderType} · fills down to <span className="num">{fmtPx(Number(o.limitPx))}</span> · reduce-only
                </span>
              </span>
              <button type="button" className="btn btn-sm" disabled={busy !== null || Boolean(blocked)} onClick={() => void cancel(o)}>
                {busy === `cancel-${o.oid}` ? 'Cancelling…' : 'Cancel'}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <span className="small t2">None set on this position.</span>
      )}

      <div className="row nw" style={{ gap: 8 }}>
        <div className="field" style={{ flex: 1, minWidth: 0 }}>
          <label htmlFor="tpsl-tp">Take profit at</label>
          <div className="input">
            <input id="tpsl-tp" inputMode="decimal" placeholder="Your price" value={tp} onChange={(e) => setTp(e.target.value)} />
          </div>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 0 }}>
          <label htmlFor="tpsl-sl">Stop loss at</label>
          <div className="input">
            <input id="tpsl-sl" inputMode="decimal" placeholder="Your price" value={sl} onChange={(e) => setSl(e.target.value)} />
          </div>
        </div>
      </div>
      <div className="field">
        <label htmlFor="tpsl-slip">Max slippage when they fill</label>
        <div className="input">
          <input id="tpsl-slip" inputMode="decimal" placeholder="Your number" value={slip} onChange={(e) => setSlip(e.target.value)} />
          <span className="unit">%</span>
        </div>
      </div>

      {r?.ok ? (
        <span className="tiny t2">
          {r.legs.map((l) => `${l.kind === 'tp' ? 'Take profit' : 'Stop loss'} ${fmtPx(l.triggerPx)} (${move(l.triggerPx)}), fills ${long ? 'down' : 'up'} to ${fmtPx(l.limitPx)}`).join(' · ')}. For the whole position, <span className="num">{r.size}</span>
          {` ${ticker}`}.
        </span>
      ) : tp || sl ? (
        <span className="tiny wt">{r?.ok === false ? r.problem : 'Loading the market…'}</span>
      ) : null}
      {r?.ok ? r.warnings.map((w) => <span key={w} className="tiny wt">{w}</span>) : null}
      {blocked ? (
        <span className="tiny t2">
          {blocked}{' '}
          {!review.on ? (
            <Link href="/app/settings" style={{ textDecoration: 'underline' }}>
              Settings › Keys
            </Link>
          ) : null}
        </span>
      ) : null}
      <button type="button" className="btn btn-sm btn-ink btn-block" disabled={!r?.ok || busy !== null || Boolean(blocked)} onClick={() => void place()}>
        {busy === 'place' ? 'Sending…' : r?.ok && r.legs.length === 2 ? 'Place both' : r?.ok ? `Place ${r.legs[0]!.kind === 'tp' ? 'take profit' : 'stop loss'}` : 'Place'}
      </button>
      {msg ? (
        <span role={msg.ok ? 'status' : 'alert'} className={`small ${msg.ok ? '' : 'ct'}`}>
          {msg.text}
        </span>
      ) : null}
      <span className="tiny t3">
        Yours, not the guard’s: they rest on Hyperliquid as your own reduce-only orders, signed by your trading key, and the guard never moves or cancels them (not even the kill switch or a wipe). Its own backstop stays at your lowest buffer line. Whichever the price reaches first fires; all are reduce-only, so together they never close more than your position.
      </span>
    </div>
  );
}

