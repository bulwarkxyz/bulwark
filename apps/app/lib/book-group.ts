import type { BookLevel } from './hl';

/**
 * Price grouping for the order book, done on the levels Hyperliquid sends (no second subscription).
 * Bids round down and asks round up to the tick, so a grouped level never shows a better price than
 * the orders in it.
 */
export function tickOptions(px: number | undefined): number[] {
  if (!px || !(px > 0)) return [];
  const base = 10 ** (Math.floor(Math.log10(px)) - 4);
  return [base, base * 10, base * 100].map((t) => +t.toPrecision(1));
}

export function groupLevels(levels: readonly BookLevel[], tick: number | null, side: 'bid' | 'ask'): BookLevel[] {
  if (!tick) return [...levels];
  const out = new Map<number, number>();
  for (const l of levels) {
    const k = side === 'bid' ? Math.floor(l.px / tick + 1e-9) : Math.ceil(l.px / tick - 1e-9);
    const px = +(k * tick).toPrecision(12);
    out.set(px, (out.get(px) ?? 0) + l.sz);
  }
  return [...out.entries()].map(([px, sz]) => ({ px, sz })).sort((a, b) => (side === 'bid' ? b.px - a.px : a.px - b.px));
}
