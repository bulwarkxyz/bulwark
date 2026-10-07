/**
 * Take profit and stop loss on an open position: one reduce-only market trigger per price the user typed,
 * on the closing side, for the whole position, each sent as its own order (grouping `na`). This is the
 * shape proven with real signed orders on testnet on 6 Oct 2026 (a resting stop and a take profit,
 * Hyperliquid's "Stop Market" and "Take Profit Market"). Attaching them to an entry order (`normalTpsl`)
 * and Hyperliquid's position-wide TP/SL (`positionTpsl`) are not proven, so the app doesn't use them.
 * Nothing has a default: no price, no percentage, no slippage.
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint#place-an-order
 */
import { roundPrice, toWire } from '@bulwarkxyz/guard-core';
import { orderAction, orderWire, type OrderAction, type OrderWire } from '@bulwarkxyz/hyperliquid';

/**
 * How far from Hyperliquid's oracle a trigger's worst fill may be. A plain buy 8% above the oracle was
 * refused on testnet; stop triggers with limits 6%, 8% and 10% below were accepted at placement (7 Oct).
 * Whether a fill that far out goes through when one triggers isn't tested, so the app stays inside this.
 */
export const ORACLE_BAND = 0.06;

export interface PositionTpslInput {
  asset: number;
  szDecimals: number;
  /** The position: signed size, positive for a long. */
  size: number;
  mark: number;
  oracle: number;
  /** Typed by the user; '' for none. */
  tp: string;
  sl: string;
  /** Typed by the user, in percent: each trigger fills no worse than this from its trigger price. */
  slippage: string;
  /** Hyperliquid's liquidation price for the position, if any (for the stop's warning). */
  liquidationPx?: number | null;
}

export interface TpslLeg {
  kind: 'tp' | 'sl';
  /** What the user typed, and the valid price it was rounded to. */
  typed: number;
  triggerPx: number;
  /** The worst fill: the trigger moved by the user's slippage, against them. */
  limitPx: number;
  wire: OrderWire;
}

export type TpslResult = { ok: true; legs: TpslLeg[]; size: number; warnings: string[] } | { ok: false; problem: string };

const parse = (s: string): number | null => {
  const t = s.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
};

/** The valid price nearest to `px` (5 significant figures and the market's decimals). */
export function nearestValidPrice(px: number, szDecimals: number): number {
  const down = roundPrice(px, szDecimals, 'down');
  const up = roundPrice(px, szDecimals, 'up');
  return px - down <= up - px ? down : up;
}

/**
 * The trigger prices whose worst fill stays inside the oracle band right now, for this closing side and
 * slippage: a sell fills down to trigger × (1 − s), a buy up to trigger × (1 + s).
 */
export function allowedTriggers(closeIsBuy: boolean, oracle: number, slipPct: number): { lo: number; hi: number } {
  const f = closeIsBuy ? 1 + slipPct / 100 : 1 - slipPct / 100;
  return { lo: (oracle * (1 - ORACLE_BAND)) / f, hi: (oracle * (1 + ORACLE_BAND)) / f };
}

const label = { tp: 'take profit', sl: 'stop loss' } as const;

export function buildPositionTpsl(i: PositionTpslInput): TpslResult {
  if (!i.size) return { ok: false, problem: 'There is no open position in this market.' };
  const tp = parse(i.tp);
  const sl = parse(i.sl);
  const slip = parse(i.slippage);
  if (tp === null && sl === null) return { ok: false, problem: 'Type a take-profit price, a stop-loss price, or both.' };
  if (Number.isNaN(tp) || (tp !== null && !(tp > 0))) return { ok: false, problem: 'The take-profit price must be a number above 0.' };
  if (Number.isNaN(sl) || (sl !== null && !(sl > 0))) return { ok: false, problem: 'The stop-loss price must be a number above 0.' };
  if (slip === null || Number.isNaN(slip) || !(slip > 0 && slip <= 10)) return { ok: false, problem: 'Type your max slippage (above 0, up to 10%).' };
  const long = i.size > 0;
  if (tp !== null && (long ? !(tp > i.mark) : !(tp < i.mark))) return { ok: false, problem: long ? 'A take profit on a long must be above the price now.' : 'A take profit on a short must be below the price now.' };
  if (sl !== null && (long ? !(sl < i.mark) : !(sl > i.mark))) return { ok: false, problem: long ? 'A stop loss on a long must be below the price now.' : 'A stop loss on a short must be above the price now.' };

  // The triggers close the position: the opposite side, reduce-only, the whole size.
  const closeIsBuy = !long;
  const size = Math.floor(Math.abs(i.size) * 10 ** i.szDecimals + 1e-9) / 10 ** i.szDecimals;
  const band = allowedTriggers(closeIsBuy, i.oracle, slip);
  const legs: TpslLeg[] = [];
  for (const [kind, typed] of [
    ['tp', tp],
    ['sl', sl],
  ] as const) {
    if (typed === null) continue;
    const triggerPx = nearestValidPrice(typed, i.szDecimals);
    const limitPx = roundPrice(triggerPx * (closeIsBuy ? 1 + slip / 100 : 1 - slip / 100), i.szDecimals, closeIsBuy ? 'up' : 'down');
    // Inside the tested band. Moving the limit instead would make a stop that triggers and then can't fill,
    // so the user picks a nearer price.
    if (limitPx < i.oracle * (1 - ORACLE_BAND) || limitPx > i.oracle * (1 + ORACLE_BAND))
      return { ok: false, problem: `Your ${label[kind]} is too far from the price for now. With ${slip}% slippage, Hyperliquid accepts trigger prices from ${nearestValidPrice(band.lo, i.szDecimals)} to ${nearestValidPrice(band.hi, i.szDecimals)}. Hyperliquid accepts wider ones when they're placed; whether it fills beyond about ${ORACLE_BAND * 100}% from its oracle when one triggers isn't tested yet.` };
    legs.push({
      kind,
      typed,
      triggerPx,
      limitPx,
      wire: orderWire({ asset: i.asset, isBuy: closeIsBuy, limitPx: toWire(limitPx), size: toWire(size), reduceOnly: true, orderType: { trigger: { isMarket: true, triggerPx: toWire(triggerPx), tpsl: kind } } }),
    });
  }
  const warnings: string[] = [];
  const stop = legs.find((l) => l.kind === 'sl');
  if (stop && i.liquidationPx && (long ? stop.triggerPx <= i.liquidationPx : stop.triggerPx >= i.liquidationPx))
    warnings.push(`Your stop loss is past the liquidation price (${+i.liquidationPx.toPrecision(6)}). Hyperliquid would liquidate the position before the stop triggers.`);
  for (const l of legs) if (l.triggerPx !== l.typed) warnings.push(`${l.kind === 'tp' ? 'Take profit' : 'Stop loss'} rounded to ${l.triggerPx}, the nearest price Hyperliquid accepts.`);
  return { ok: true, legs, size, warnings };
}

/** The action to sign: the triggers as plain orders (grouping `na`, as proven), no builder fee. */
export const tpslAction = (legs: readonly TpslLeg[]): OrderAction => orderAction(legs.map((l) => l.wire), null, 'na');
