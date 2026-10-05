/** Shared inputs for the crash-day replays (backtest.ts) and the wider study (replays.ts). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSnapshot,
  maintenanceMargin,
  tiersForPosition,
  type AssetIndex,
  type Policy,
  type RawClearinghouseState,
} from '@bulwarkxyz/guard-core';
import { InfoClient } from '@bulwarkxyz/hyperliquid';

export const ROOT = join(import.meta.dirname, '../../..');
export const DATA = join(ROOT, 'data/backtests');
export const args = process.argv.slice(2);
export const refresh = args.includes('--refresh');
export const markDir = args.includes('--mark-dir') ? args[args.indexOf('--mark-dir') + 1] : undefined;
export const hydromancer = args.includes('--hydromancer');
// Hydromancer data is not redistributed: it is cached locally (gitignored) and fetched with your own key.
export const HYDRO_CACHE = join(DATA, '.hydromancer-cache');

export const CASES = [
  { id: 'silver-2026-01-30', title: 'Silver, 30 January 2026', coin: 'xyz:SILVER', interval: '4h', start: '2026-01-29T00:00:00Z', end: '2026-02-01T00:00:00Z', conclusiveOnTrades: true },
  { id: 'oil-2026-03-23', title: 'Oil, 23 March 2026', coin: 'xyz:CL', interval: '1h', start: '2026-03-22T00:00:00Z', end: '2026-03-25T00:00:00Z', conclusiveOnTrades: true },
  {
    id: 'skhx-2026-07-27',
    title: 'SK hynix, 27 July 2026',
    coin: 'xyz:SKHX',
    interval: '1h',
    start: '2026-07-26T00:00:00Z',
    end: '2026-07-29T00:00:00Z',
    conclusiveOnTrades: false,
    why: 'The wick was a bad print in trades. Liquidations and the guard follow the mark price, which may not have moved; only mark-price data can show whether either would have triggered.',
  },
] as const;

export const EQUITY = 10_000;
export const LEVERAGES = [3, 5, 10, 20];
export const DELAYS_MIN = [0, 1, 5];
export const FEE_RATE = Number(process.env.FEE_BPS ?? 4.5) / 1e4; // assumed per fill
export const SLIPPAGE_PCT = 1;

/** Example settings chosen for the test. */
export const POLICY: Policy = {
  version: 1,
  account: '0x000000000000000000000000000000000000beef',
  rules: [
    { id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'reduceToBuffer', buffer: 3 }] },
    { id: 'stage-2', when: { kind: 'buffer', below: 1.5 }, then: [{ kind: 'reduceToBuffer', buffer: 2.5 }] },
    { id: 'stage-3', when: { kind: 'buffer', below: 1.2 }, then: [{ kind: 'close', target: { kind: 'all' } }] },
  ],
  execution: { maxSlippagePct: SLIPPAGE_PCT },
};
export const STAGE_TEXT = [
  'Stage 1: buffer below 2× → trim until the buffer is back at 3×',
  'Stage 2: buffer below 1.5× → trim until the buffer is back at 2.5×',
  'Stage 3: buffer below 1.2× → close the position',
];

export interface Series {
  kind: 'trade-candles' | 'mark';
  /** Price points in time order with the guard's look at each. */
  points: Array<{ t: number; px: number }>;
  /** Minutes between consecutive points (for converting delays). */
  stepMinutes: number;
  resolution: string;
}

export const info = new InfoClient('mainnet');
export const SUBSTEPS = 12;

export async function tradeSeries(c: (typeof CASES)[number]): Promise<Series> {
  const file = join(DATA, `${c.id}.candles.json`);
  if (refresh || !existsSync(file)) {
    const rows = await info.request<Array<{ t: number; o: string; h: string; l: string; c: string }>>({ type: 'candleSnapshot', req: { coin: c.coin, interval: c.interval, startTime: Date.parse(c.start), endTime: Date.parse(c.end) } });
    mkdirSync(DATA, { recursive: true });
    writeFileSync(file, JSON.stringify({ source: 'Hyperliquid info candleSnapshot (trade prices)', coin: c.coin, interval: c.interval, fetchedAt: new Date().toISOString(), candles: rows }, null, 1));
  }
  const { candles } = JSON.parse(readFileSync(file, 'utf8')) as { candles: Array<{ t: number; o: string; h: string; l: string; c: string }> };
  // Long position: assume the adverse extreme comes first inside each candle (open → low → high → close),
  // and a continuous path between those points (real moves can gap).
  const anchors = candles.flatMap((k) => [Number(k.o), Number(k.l), Number(k.h), Number(k.c)].map((px) => ({ t: k.t, px })));
  const points: Series['points'] = [];
  for (let i = 0; i + 1 < anchors.length; i++) {
    for (let s = 0; s < SUBSTEPS; s++) points.push({ t: anchors[i]!.t, px: anchors[i]!.px + ((anchors[i + 1]!.px - anchors[i]!.px) * s) / SUBSTEPS });
  }
  points.push(anchors[anchors.length - 1]!);
  const intervalMin = c.interval === '4h' ? 240 : 60;
  return { kind: 'trade-candles', points, stepMinutes: intervalMin / 4 / SUBSTEPS, resolution: `${c.interval} trade candles (open → low → high → close, ${SUBSTEPS} looks per segment)` };
}

export async function hydro(body: Record<string, unknown>): Promise<unknown> {
  const key = process.env.HYDROMANCER_API_KEY;
  if (!key) throw new Error('HYDROMANCER_API_KEY is not set');
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.hydromancer.xyz/info', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': 'bulwark-backtest/1.0' },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(`Hydromancer ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Every price round in [start, end), paginated 2000 rows at a time. */
export async function hydroRounds(type: 'perpPriceHistoryByTime' | 'oraclePriceHistoryByTime', coin: string, start: number, end: number): Promise<Array<{ t: number; px: number }>> {
  const out: Array<{ t: number; px: number }> = [];
  let from = start;
  while (from < end) {
    const rows = (await hydro({ type, coin, startTime: from, endTime: end, limit: 2000, ...(type === 'oraclePriceHistoryByTime' ? { dex: coin.split(':')[0] } : {}) })) as Array<{ time: number; markPx?: string }>;
    if (!rows.length) break;
    for (const r of rows) if (r.markPx !== undefined && r.time < end) out.push({ t: r.time, px: Number(r.markPx) });
    const last = rows[rows.length - 1]!.time;
    if (rows.length < 2000 || last <= from) break;
    from = last + 1;
  }
  return out;
}

export async function hydroSeries(c: { id: string; coin: string; start: string; end: string }): Promise<Series | null> {
  mkdirSync(HYDRO_CACHE, { recursive: true });
  const file = join(HYDRO_CACHE, `${c.id}.json`);
  if (refresh || !existsSync(file)) {
    const start = Date.parse(c.start);
    const end = Date.parse(c.end);
    let points = await hydroRounds('perpPriceHistoryByTime', c.coin, start, end);
    let source = 'Hydromancer perpPriceHistoryByTime (accepted mark, one row per oracle round)';
    let accepted = true;
    if (!points.length) {
      points = await hydroRounds('oraclePriceHistoryByTime', c.coin, start, end);
      source = 'Hydromancer oraclePriceHistoryByTime (deployer-submitted mark input; accepted HIP-3 rounds start 2026-02-24)';
      accepted = false;
    }
    writeFileSync(file, JSON.stringify({ source, accepted, coin: c.coin, fetchedAt: new Date().toISOString(), points }));
  }
  const cached = JSON.parse(readFileSync(file, 'utf8')) as { source: string; accepted: boolean; points: Array<{ t: number; px: number }> };
  if (cached.points.length < 2) return null;
  const spanMin = (cached.points[cached.points.length - 1]!.t - cached.points[0]!.t) / 60_000;
  return {
    kind: 'mark',
    points: cached.points,
    stepMinutes: spanMin / (cached.points.length - 1),
    resolution: `${cached.accepted ? 'accepted mark prices' : 'deployer-submitted mark inputs (not the accepted mark)'}, ${cached.points.length.toLocaleString('en-US')} rounds, one about every ${((spanMin * 60) / (cached.points.length - 1)).toFixed(1)} s, from ${cached.source.split(' (')[0]}`,
  };
}

/** The deployer-submitted mark inputs for a case's window (cached like the accepted marks). */
export async function submittedPoints(c: { id: string; coin: string; start: string; end: string }): Promise<Array<{ t: number; px: number }>> {
  const file = join(HYDRO_CACHE, `${c.id}.submitted.json`);
  if (refresh || !existsSync(file)) writeFileSync(file, JSON.stringify(await hydroRounds('oraclePriceHistoryByTime', c.coin, Date.parse(c.start), Date.parse(c.end))));
  return JSON.parse(readFileSync(file, 'utf8')) as Array<{ t: number; px: number }>;
}

/** How far the deployer's submitted mark input sat from the accepted mark, matched to the nearest earlier round. */
export function deviation(accepted: Array<{ t: number; px: number }>, submitted: Array<{ t: number; px: number }>) {
  const devs: number[] = [];
  let j = 0;
  for (const s of submitted) {
    while (j + 1 < accepted.length && accepted[j + 1]!.t <= s.t) j++;
    const a = accepted[j]!;
    if (a.t > s.t || s.t - a.t > 10_000) continue;
    devs.push(Math.abs(s.px / a.px - 1) * 100);
  }
  devs.sort((x, y) => x - y);
  const q = (p: number) => +devs[Math.min(devs.length - 1, Math.floor(p * devs.length))]!.toFixed(3);
  return { matched: devs.length, medianPct: q(0.5), p99Pct: q(0.99), maxPct: +devs[devs.length - 1]!.toFixed(3) };
}

/** Largest fall from a high to a later low within any 60 minutes. */
export function largestHourDrop(points: Array<{ t: number; px: number }>) {
  let best = { pct: 0, from: 0, to: 0 };
  let i = 0;
  const window: number[] = []; // indices with decreasing prices (running max candidates)
  for (let k = 0; k < points.length; k++) {
    while (points[k]!.t - points[i]!.t > 3_600_000) i++;
    while (window.length && window[0]! < i) window.shift();
    while (window.length && points[window[window.length - 1]!]!.px <= points[k]!.px) window.pop();
    window.push(k);
    const hi = points[window[0]!]!;
    const pct = (points[k]!.px / hi.px - 1) * 100;
    if (pct < best.pct) best = { pct, from: hi.t, to: points[k]!.t };
  }
  return { pct: +best.pct.toFixed(2), from: new Date(best.from).toISOString(), to: new Date(best.to).toISOString() };
}

export function markSeries(c: (typeof CASES)[number], dir: string): Series | null {
  const file = join(dir, `${c.id}.csv`);
  if (!existsSync(file)) return null;
  const rows = readFileSync(file, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
  const points = rows.map(([t, px]) => ({ t: Date.parse(t!.replace(' ', 'T') + (t!.endsWith('Z') ? '' : 'Z')), px: Number(px) })).filter((p) => Number.isFinite(p.px)).sort((a, b) => a.t - b.t);
  return { kind: 'mark', points, stepMinutes: 1, resolution: 'one-minute mark prices' };
}

export function account(assets: AssetIndex, collateral: Map<string, number>, coin: string, px: number, lev: number) {
  const asset = assets.get(coin)!;
  const size = Math.floor(((EQUITY * lev) / px) * 10 ** asset.szDecimals) / 10 ** asset.szDecimals;
  const tiers = tiersForPosition(asset.tiers, asset.maxLeverage);
  const sum = { accountValue: String(EQUITY), totalNtlPos: '0', totalRawUsd: String(EQUITY - size * px), totalMarginUsed: '0' };
  const state: RawClearinghouseState = {
    marginSummary: sum,
    crossMarginSummary: sum,
    crossMaintenanceMarginUsed: String(maintenanceMargin(tiers, size * px)),
    withdrawable: '0',
    assetPositions: [{ type: 'oneWay', position: { coin, szi: String(size), leverage: { type: 'cross', value: lev }, entryPx: String(px), positionValue: String(size * px), unrealizedPnl: '0', liquidationPx: null, marginUsed: String((size * px) / lev), maxLeverage: asset.maxLeverage } }],
    time: 0,
  };
  return { size, snapshot: buildSnapshot({ abstraction: 'default', dexStates: { xyz: state }, spot: { balances: [] }, assets, dexCollateral: collateral }) };
}

