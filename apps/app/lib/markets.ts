/**
 * Curated HIP-3 markets on trade.xyz and their home-market sessions.
 * Sessions and off-hours price bounds: trade.xyz Specification Index
 * https://docs.trade.xyz/perpetuals/specifications-and-schedules/specification-index.md and
 * discovery bounds https://docs.trade.xyz/perpetuals/mechanics/discovery-bounds.md (checked 2026-10-05).
 * Off-hours the oracle is trade.xyz's internal price: https://docs.trade.xyz/perpetuals/mechanics/oracle-price.md
 */
export type Category = 'Commodities' | 'Indices' | 'Stocks';
export type SessionKind = 'futures' | 'futuresBrent' | 'usStocks' | 'korea';

export interface Market {
  coin: string;
  ticker: string;
  name: string;
  category: Category;
  session: SessionKind;
  /** Off-hours mark bound and number of re-anchors, where trade.xyz publishes them. */
  bound?: { pct: number; resets: number };
}

export const MARKETS: Market[] = [
  { coin: 'xyz:CL', ticker: 'CL', name: 'WTI crude oil', category: 'Commodities', session: 'futures', bound: { pct: 5, resets: 2 } },
  { coin: 'xyz:BRENTOIL', ticker: 'BRENTOIL', name: 'Brent crude oil', category: 'Commodities', session: 'futuresBrent', bound: { pct: 5, resets: 2 } },
  { coin: 'xyz:GOLD', ticker: 'GOLD', name: 'Gold', category: 'Commodities', session: 'futures', bound: { pct: 4, resets: 2 } },
  { coin: 'xyz:SILVER', ticker: 'SILVER', name: 'Silver', category: 'Commodities', session: 'futures', bound: { pct: 4, resets: 2 } },
  { coin: 'xyz:SP500', ticker: 'SP500', name: 'S&P 500 index', category: 'Indices', session: 'futures', bound: { pct: 2, resets: 1 } },
  { coin: 'xyz:XYZ100', ticker: 'XYZ100', name: 'US tech 100 index', category: 'Indices', session: 'futures', bound: { pct: 3.5, resets: 1 } },
  { coin: 'xyz:NVDA', ticker: 'NVDA', name: 'NVIDIA', category: 'Stocks', session: 'usStocks', bound: { pct: 5, resets: 2 } },
  { coin: 'xyz:MU', ticker: 'MU', name: 'Micron', category: 'Stocks', session: 'usStocks', bound: { pct: 10, resets: 1 } },
  { coin: 'xyz:TSLA', ticker: 'TSLA', name: 'Tesla', category: 'Stocks', session: 'usStocks' },
  { coin: 'xyz:SKHX', ticker: 'SKHX', name: 'SK Hynix', category: 'Stocks', session: 'korea' },
];

export const marketByCoin = (coin: string) => MARKETS.find((m) => m.coin === coin);

interface ZonedParts {
  weekday: number; // 0 Sun … 6 Sat
  minutes: number;
}
function zoned(t: number, timeZone: string): ZonedParts {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = f.formatToParts(new Date(t));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? '0';
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')), minutes: Number(g('hour')) * 60 + Number(g('minute')) };
}

/** Is the home market open at time t? (Exchange holidays are not modelled.) */
export function homeOpen(kind: SessionKind, t: number): boolean {
  if (kind === 'korea') {
    // KRX regular session 09:00–15:30 KST, weekdays
    const k = zoned(t, 'Asia/Seoul');
    return k.weekday >= 1 && k.weekday <= 5 && k.minutes >= 9 * 60 && k.minutes < 15 * 60 + 30;
  }
  const n = zoned(t, 'America/New_York');
  if (kind === 'usStocks') {
    // 24/5: Sun 8 PM ET → Fri 8 PM ET
    if (n.weekday === 6) return false;
    if (n.weekday === 0) return n.minutes >= 20 * 60;
    if (n.weekday === 5) return n.minutes < 20 * 60;
    return true;
  }
  // Futures: Sun 6 PM ET → Fri 5 PM ET (Brent to 6 PM), daily maintenance 5–6 PM ET Mon–Thu
  const fridayClose = kind === 'futuresBrent' ? 18 * 60 : 17 * 60;
  if (n.weekday === 6) return false;
  if (n.weekday === 0) return n.minutes >= 18 * 60;
  if (n.weekday === 5) return n.minutes < fridayClose;
  return !(n.minutes >= 17 * 60 && n.minutes < 18 * 60);
}

/** The next time (ms) the home market changes state, found minute by minute (capped at 4 days). */
export function nextChange(kind: SessionKind, t: number): number | null {
  const now = homeOpen(kind, t);
  let cur = Math.ceil(t / 60_000) * 60_000;
  for (let i = 0; i < 4 * 24 * 60; i++, cur += 60_000) if (homeOpen(kind, cur) !== now) return cur;
  return null;
}

export function sessionLabel(kind: SessionKind, t: number, utc = true): string {
  const open = homeOpen(kind, t);
  const next = nextChange(kind, t);
  const when = next
    ? new Intl.DateTimeFormat('en-GB', { timeZone: utc ? 'UTC' : undefined, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(next)) + (utc ? ' UTC' : '')
    : '';
  return open ? `Open${when ? ` · closes ${when}` : ''}` : `Closed${when ? ` · opens ${when}` : ''}`;
}
