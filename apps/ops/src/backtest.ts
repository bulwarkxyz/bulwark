/**
 * Crash-day replays: the same guard code (`simulate` → `evaluate`) on recorded Hyperliquid prices.
 *
 *   pnpm --filter @bulwarkxyz/ops backtest                  replay from the inputs stored in data/backtests/
 *   pnpm --filter @bulwarkxyz/ops backtest -- --refresh     re-fetch trade candles from Hyperliquid first
 *   pnpm --filter @bulwarkxyz/ops backtest -- --mark-dir D  use mark prices: D/<case>.csv with block_minute,mark_price
 *
 * Writes evidence/backtest-<source>-<date>.{json,md}. Every assumption is written next to the numbers.
 *
 * Price kinds:
 *   trade-candles  Hyperliquid candleSnapshot TRADE prices, the finest the public API still keeps for
 *                  these days (1 h; 4 h for January). Coarse, and liquidation runs on MARK price.
 *   mark           one-minute mark prices (for example a Dune `hyperliquid.perp_oracle_prices` export).
 *
 * Scenario (example settings chosen for the test, not product defaults): a cross long on the xyz dex,
 * opened at the first price of the window with 10,000 USDC of equity, at several leverages, with and
 * without the guard, and with the guard's orders delayed by 0, 1 and 5 minutes (congestion).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildAssetIndex,
  buildSnapshot,
  dexCollateral,
  maintenanceMargin,
  simulate,
  tiersForPosition,
  type AssetIndex,
  type Marks,
  type Policy,
  type RawClearinghouseState,
  type RawPerpDexs,
  type RawPerpMeta,
} from '@bulwarkxyz/guard-core';
import { InfoClient } from '@bulwarkxyz/hyperliquid';

const ROOT = join(import.meta.dirname, '../../..');
const DATA = join(ROOT, 'data/backtests');
const args = process.argv.slice(2);
const refresh = args.includes('--refresh');
const markDir = args.includes('--mark-dir') ? args[args.indexOf('--mark-dir') + 1] : undefined;

const CASES = [
  { id: 'silver-2026-01-30', title: 'Silver −35% in a day', coin: 'xyz:SILVER', interval: '4h', start: '2026-01-29T00:00:00Z', end: '2026-02-01T00:00:00Z', conclusiveOnTrades: true },
  { id: 'oil-2026-03-23', title: 'Oil −16.5% in one hour', coin: 'xyz:CL', interval: '1h', start: '2026-03-22T00:00:00Z', end: '2026-03-25T00:00:00Z', conclusiveOnTrades: true },
  {
    id: 'skhx-2026-07-27',
    title: 'SK hynix bad-print wick',
    coin: 'xyz:SKHX',
    interval: '1h',
    start: '2026-07-26T00:00:00Z',
    end: '2026-07-29T00:00:00Z',
    conclusiveOnTrades: false,
    why: 'The wick was a bad print in trades. Liquidations and the guard follow the mark price, which may not have moved; only mark-price data can show whether either would have triggered.',
  },
] as const;

const EQUITY = 10_000;
const LEVERAGES = [3, 5, 10, 20];
const DELAYS_MIN = [0, 1, 5];
const FEE_RATE = Number(process.env.FEE_BPS ?? 4.5) / 1e4; // assumed per fill
const SLIPPAGE_PCT = 1;

/** Example settings chosen for the test. */
const POLICY: Policy = {
  version: 1,
  account: '0x000000000000000000000000000000000000beef',
  rules: [
    { id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'reduceToBuffer', buffer: 3 }] },
    { id: 'stage-2', when: { kind: 'buffer', below: 1.5 }, then: [{ kind: 'reduceToBuffer', buffer: 2.5 }] },
    { id: 'stage-3', when: { kind: 'buffer', below: 1.2 }, then: [{ kind: 'close', target: { kind: 'all' } }] },
  ],
  execution: { maxSlippagePct: SLIPPAGE_PCT },
};
const STAGE_TEXT = [
  'Stage 1: buffer below 2× → trim until the buffer is back at 3×',
  'Stage 2: buffer below 1.5× → trim until the buffer is back at 2.5×',
  'Stage 3: buffer below 1.2× → close the position',
];

interface Series {
  kind: 'trade-candles' | 'mark';
  /** Price points in time order with the guard's look at each. */
  points: Array<{ t: number; px: number }>;
  /** Minutes between consecutive points (for converting delays). */
  stepMinutes: number;
  resolution: string;
}

const info = new InfoClient('mainnet');
const SUBSTEPS = 12;

async function tradeSeries(c: (typeof CASES)[number]): Promise<Series> {
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

function markSeries(c: (typeof CASES)[number], dir: string): Series | null {
  const file = join(dir, `${c.id}.csv`);
  if (!existsSync(file)) return null;
  const rows = readFileSync(file, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
  const points = rows.map(([t, px]) => ({ t: Date.parse(t!.replace(' ', 'T') + (t!.endsWith('Z') ? '' : 'Z')), px: Number(px) })).filter((p) => Number.isFinite(p.px)).sort((a, b) => a.t - b.t);
  return { kind: 'mark', points, stepMinutes: 1, resolution: 'one-minute mark prices' };
}

function account(assets: AssetIndex, collateral: Map<string, number>, coin: string, px: number, lev: number) {
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

async function main() {
  const perpDexs = (await info.perpDexs()) as RawPerpDexs;
  const metas = (await info.allPerpMetas()) as RawPerpMeta[];
  const assets = buildAssetIndex(perpDexs, metas);
  const collateral = dexCollateral(perpDexs, metas);
  const kind = markDir ? 'mark' : 'trade-candles';
  const out: Array<Record<string, unknown>> = [];

  for (const c of CASES) {
    const series = markDir ? markSeries(c, markDir) : await tradeSeries(c);
    const asset = assets.get(c.coin);
    if (!series || !asset || series.points.length < 2) {
      out.push({ case: c.id, title: c.title, error: 'no price data for this case' });
      continue;
    }
    const path: Marks[] = series.points.map((p) => ({ [c.coin]: p.px }));
    const p0 = series.points[0]!.px;
    const low = Math.min(...series.points.map((p) => p.px));
    const conclusive = series.kind === 'mark' || c.conclusiveOnTrades;
    const rows: Array<Record<string, unknown>> = [];
    for (const lev of LEVERAGES.filter((l) => l <= asset.maxLeverage)) {
      const { size, snapshot } = account(assets, collateral, c.coin, p0, lev);
      const runs = DELAYS_MIN.map((m) => {
        const r = simulate({ policy: POLICY, snapshot, path, now: series.points[0]!.t, feeRate: FEE_RATE, delaySteps: Math.ceil(m / series.stepMinutes) });
        return {
          delayMinutes: m,
          liquidated: r.liquidatedAt !== null,
          equityAtEnd: r.liquidatedAt !== null ? null : +r.final.accountValue.toFixed(2),
          equityKeptPct: r.liquidatedAt !== null ? null : +((r.final.accountValue / EQUITY) * 100).toFixed(1),
          guardOrders: r.steps.flatMap((s) => s.actions.filter((a) => a.type === 'order')).length,
          missedOrders: r.missedOrders,
          feesPaid: +r.feesPaid.toFixed(2),
          unguardedLiquidatedAt: r.unguardedLiquidatedAt === null ? null : new Date(series.points[r.unguardedLiquidatedAt]!.t).toISOString(),
        };
      });
      const unguardedEnd = runs[0]!.unguardedLiquidatedAt ? null : +(EQUITY + size * (series.points[series.points.length - 1]!.px - p0)).toFixed(2);
      rows.push({
        leverage: lev,
        positionSize: size,
        noGuard: runs[0]!.unguardedLiquidatedAt ? { liquidated: true, at: runs[0]!.unguardedLiquidatedAt } : { liquidated: false, equityAtEnd: unguardedEnd, equityKeptPct: +((unguardedEnd! / EQUITY) * 100).toFixed(1) },
        withGuard: runs.map(({ unguardedLiquidatedAt: _u, ...r }) => r),
      });
    }
    out.push({ case: c.id, title: c.title, coin: c.coin, priceKind: series.kind, resolution: series.resolution, window: `${c.start} → ${c.end}`, entryPrice: p0, lowestPrice: low, dropToLowPct: +((low / p0 - 1) * 100).toFixed(2), conclusive, ...(conclusive ? {} : { inconclusiveBecause: (c as { why?: string }).why }), rows });
  }

  const ranAt = new Date().toISOString();
  const assumptions = {
    account: `A cross long on the xyz dex, opened at the first price of each window, with ${EQUITY.toLocaleString('en-US')} USDC of equity and nothing else in the account`,
    leverages: LEVERAGES.map((l) => `${l}×`).join(', '),
    stageSettings: `Example settings chosen for the test (not product defaults): ${STAGE_TEXT.join('; ')}`,
    noGuard: 'The same account, same prices, no guard',
    fees: `${FEE_RATE * 1e4} bps per fill, assumed`,
    slippage: `Guard orders fill at the worst price a ${SLIPPAGE_PCT}% slippage limit allows`,
    congestion: `Guard orders reach the exchange ${DELAYS_MIN.join(', ')} minutes after the decision; a late IOC fills only if the price is still within its limit`,
    margin: 'Current xyz maintenance tiers (historical tiers may have differed)',
    notModelled: 'Funding, order-book depth and queue position, partial fills, Hyperliquid outages, other traders reacting',
  };
  const report = { ranAt, priceKind: kind, assumptions, cases: out };
  const evidence = join(ROOT, 'evidence');
  mkdirSync(evidence, { recursive: true });
  const stem = `backtest-${kind}-${ranAt.slice(0, 10)}`;
  writeFileSync(join(evidence, `${stem}.json`), JSON.stringify(report, null, 1));

  const fmtGuard = (r: { liquidated: boolean; equityKeptPct: number | null; missedOrders: number }) => (r.liquidated ? 'liquidated' : `${r.equityKeptPct}% kept`) + (r.missedOrders ? ` (${r.missedOrders} missed)` : '');
  const md = [
    `# Crash-day replays: ${kind === 'mark' ? 'mark prices' : 'hourly trade prices (coarse)'}`,
    '',
    `Run ${ranAt.slice(0, 16)}Z. ${kind === 'mark' ? '' : '**Trade prices, not mark prices, at hourly (January: 4-hour) resolution. Liquidation and the guard run on mark price.**'}`,
    '',
    ...Object.entries(assumptions).map(([k, v]) => `- **${k}:** ${v}`),
    '',
    ...out.flatMap((c) => {
      if (c.error) return [`## ${c.title}`, '', String(c.error), ''];
      const rows = c.rows as Array<{ leverage: number; noGuard: { liquidated: boolean; at?: string; equityKeptPct?: number }; withGuard: Array<{ delayMinutes: number; liquidated: boolean; equityKeptPct: number | null; missedOrders: number; guardOrders: number; feesPaid: number }> }>;
      return [
        `## ${c.title}`,
        '',
        `${c.coin}, ${c.window}, ${c.resolution}. Entry ${c.entryPrice}, lowest ${c.lowestPrice} (${c.dropToLowPct}%).${c.conclusive ? '' : ` **Inconclusive:** ${c.inconclusiveBecause}`}`,
        '',
        '| Leverage | No guard | Guard, no delay | Guard, 1 min late | Guard, 5 min late | Guard orders | Fees (no delay) |',
        '|---|---|---|---|---|---|---|',
        ...rows.map((r) => `| ${r.leverage}× | ${r.noGuard.liquidated ? 'liquidated' : `${r.noGuard.equityKeptPct}% kept`} | ${r.withGuard.map(fmtGuard).join(' | ')} | ${r.withGuard[0]!.guardOrders} | ${r.withGuard[0]!.feesPaid} USDC |`),
        '',
      ];
    }),
  ].join('\n');
  writeFileSync(join(evidence, `${stem}.md`), md + '\n');
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
