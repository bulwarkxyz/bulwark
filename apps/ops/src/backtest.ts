/**
 * Crash-day replays: the same guard code (`simulate` → `evaluate`) on recorded Hyperliquid prices.
 *
 *   pnpm --filter @bulwarkxyz/ops backtest            writes evidence/backtest-<date>.{json,md}
 *
 * Data source today: Hyperliquid `candleSnapshot` TRADE-price candles, the finest the public API still
 * keeps for these days (1 h; 4 h for January). Liquidation and the guard run on MARK price, so results
 * here are estimates; a mark-price source (Hydromancer) plugs in through `PriceSource` without changing
 * anything else. Every assumption is written into the output next to the numbers.
 *
 * Scenario (disclosed, not a product default): a cross long on the xyz dex, opened at the first price
 * of the window with 10,000 USDC of equity, at several leverages; stages are an example policy.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assessRisk,
  buildAssetIndex,
  buildSnapshot,
  dexCollateral,
  maintenanceMargin,
  simulate,
  tiersForPosition,
  type Marks,
  type Policy,
  type RawClearinghouseState,
  type RawPerpDexs,
  type RawPerpMeta,
} from '@bulwarkxyz/guard-core';
import { InfoClient } from '@bulwarkxyz/hyperliquid';

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Where prices come from. Today: trade candles. Later: Hydromancer mark history. */
export interface PriceSource {
  readonly name: string;
  readonly kind: 'trade-candles' | 'mark';
  candles(coin: string, interval: string, start: number, end: number): Promise<Candle[]>;
}

const info = new InfoClient('mainnet');
const tradeCandles: PriceSource = {
  name: 'Hyperliquid candleSnapshot (trade prices)',
  kind: 'trade-candles',
  async candles(coin, interval, start, end) {
    const rows = await info.request<Array<{ t: number; o: string; h: string; l: string; c: string }>>({ type: 'candleSnapshot', req: { coin, interval, startTime: start, endTime: end } });
    return rows.map((r) => ({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) }));
  },
};

const CASES = [
  { id: 'silver-2026-01-30', title: 'Silver −35% in a day', coin: 'xyz:SILVER', interval: '4h', start: '2026-01-29T00:00:00Z', end: '2026-02-01T00:00:00Z', meaningfulOnTrades: true },
  { id: 'oil-2026-03-23', title: 'Oil −16.5% in one hour', coin: 'xyz:CL', interval: '1h', start: '2026-03-22T00:00:00Z', end: '2026-03-25T00:00:00Z', meaningfulOnTrades: true },
  { id: 'skhx-2026-07-27', title: 'SK hynix bad-print wick', coin: 'xyz:SKHX', interval: '1h', start: '2026-07-26T00:00:00Z', end: '2026-07-29T00:00:00Z', meaningfulOnTrades: false },
];

const EQUITY = 10_000;
const LEVERAGES = [3, 5, 10, 20];
const FEE_RATE = Number(process.env.FEE_BPS ?? 4.5) / 1e4; // assumed taker fee
const SUBSTEPS = 12; // guard looks per price segment (continuous path assumed inside a candle)
const ACCOUNT = '0x000000000000000000000000000000000000beef';

const POLICY: Policy = {
  version: 1,
  account: ACCOUNT,
  rules: [
    { id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'reduceToBuffer', buffer: 3 }] },
    { id: 'stage-2', when: { kind: 'buffer', below: 1.5 }, then: [{ kind: 'reduceToBuffer', buffer: 2.5 }] },
    { id: 'stage-3', when: { kind: 'buffer', below: 1.2 }, then: [{ kind: 'close', target: { kind: 'all' } }] },
  ],
  execution: { maxSlippagePct: 1 },
};

/** Long position: assume the adverse extreme comes first inside each candle (O → L → H → C). */
function pathFrom(candles: Candle[], coin: string): { marks: Marks[]; times: number[] } {
  const pts: Array<[number, number]> = [];
  for (const k of candles) pts.push([k.t, k.o], [k.t, k.l], [k.t, k.h], [k.t, k.c]);
  const marks: Marks[] = [];
  const times: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [t, a] = pts[i]!;
    const [, b] = pts[i + 1]!;
    for (let s = 0; s < SUBSTEPS; s++) {
      marks.push({ [coin]: a + ((b - a) * s) / SUBSTEPS });
      times.push(t);
    }
  }
  marks.push({ [coin]: pts[pts.length - 1]![1] });
  times.push(pts[pts.length - 1]![0]);
  return { marks, times };
}

async function main() {
  const perpDexs = (await info.perpDexs()) as RawPerpDexs;
  const metas = (await info.allPerpMetas()) as RawPerpMeta[];
  const assets = buildAssetIndex(perpDexs, metas);
  const collateral = dexCollateral(perpDexs, metas);
  const source = tradeCandles;
  const results: Array<Record<string, unknown>> = [];

  for (const cs of CASES) {
    const candles = await source.candles(cs.coin, cs.interval, Date.parse(cs.start), Date.parse(cs.end));
    const asset = assets.get(cs.coin);
    if (!candles.length || !asset) {
      results.push({ case: cs.id, error: 'no data' });
      continue;
    }
    const { marks, times } = pathFrom(candles, cs.coin);
    const p0 = candles[0]!.o;
    const lowest = Math.min(...candles.map((k) => k.l));
    for (const lev of LEVERAGES.filter((l) => l <= asset.maxLeverage)) {
      const size = Math.floor(((EQUITY * lev) / p0) * 10 ** asset.szDecimals) / 10 ** asset.szDecimals;
      const tiers = tiersForPosition(asset.tiers, asset.maxLeverage);
      const state: RawClearinghouseState = {
        marginSummary: { accountValue: String(EQUITY), totalNtlPos: '0', totalRawUsd: String(EQUITY - size * p0), totalMarginUsed: '0' },
        crossMarginSummary: { accountValue: String(EQUITY), totalNtlPos: '0', totalRawUsd: String(EQUITY - size * p0), totalMarginUsed: '0' },
        crossMaintenanceMarginUsed: String(maintenanceMargin(tiers, size * p0)),
        withdrawable: '0',
        assetPositions: [
          {
            type: 'oneWay',
            position: { coin: cs.coin, szi: String(size), leverage: { type: 'cross', value: lev }, entryPx: String(p0), positionValue: String(size * p0), unrealizedPnl: '0', liquidationPx: null, marginUsed: String((size * p0) / lev), maxLeverage: asset.maxLeverage },
          },
        ],
        time: candles[0]!.t,
      };
      const snapshot = buildSnapshot({ abstraction: 'default', dexStates: { xyz: state }, spot: { balances: [] }, assets, dexCollateral: collateral });
      const sim = simulate({ policy: POLICY, snapshot, path: marks, now: candles[0]!.t, feeRate: FEE_RATE });
      const lastMark = marks[Math.min(marks.length - 1, sim.steps.length - 1)]!;
      const unguardedEnd = sim.unguardedLiquidatedAt === null ? assessRisk(snapshot, marks[marks.length - 1]).accountValue : null;
      const orders = sim.steps.flatMap((s) => s.actions.filter((a) => a.type === 'order'));
      results.push({
        case: cs.id,
        title: cs.title,
        coin: cs.coin,
        leverage: lev,
        entry: p0,
        lowest,
        dropToLowPct: +((lowest / p0 - 1) * 100).toFixed(2),
        unguarded: sim.unguardedLiquidatedAt === null ? { liquidated: false, endEquity: +unguardedEnd!.toFixed(2) } : { liquidated: true, at: new Date(times[sim.unguardedLiquidatedAt]!).toISOString(), markAtLiquidation: marks[sim.unguardedLiquidatedAt]![cs.coin] },
        guarded: {
          liquidated: sim.liquidatedAt !== null,
          endEquity: +sim.final.accountValue.toFixed(2),
          equityKeptPct: +((sim.final.accountValue / EQUITY) * 100).toFixed(1),
          guardOrders: orders.length,
          firstActionAt: sim.steps.find((s) => s.actions.length) ? new Date(times[sim.steps.find((s) => s.actions.length)!.step]!).toISOString() : null,
          feesPaid: +sim.feesPaid.toFixed(2),
          finalPositionSize: sim.final.positions.find((p) => p.coin === cs.coin)?.size ?? 0,
          markAtEnd: lastMark[cs.coin],
        },
        meaningfulOnTrades: cs.meaningfulOnTrades,
      });
    }
  }

  const ranAt = new Date().toISOString();
  const report = {
    ranAt,
    source: source.name,
    priceKind: source.kind,
    assumptions: {
      account: `cross long on the xyz dex, ${EQUITY} USDC equity, opened at the first price of each window`,
      leverages: LEVERAGES,
      policy: POLICY.rules.map((r) => `${r.id}: ${JSON.stringify(r.when)} → ${JSON.stringify(r.then)}`),
      slippage: 'guard orders fill at the worst price the 1% slippage limit allows',
      feeRate: `${FEE_RATE * 1e4} bps per fill (assumed)`,
      intraCandle: `O → low → high → close, ${SUBSTEPS} guard looks per segment (continuous path assumed; real moves can gap)`,
      margin: 'current xyz maintenance tiers from allPerpMetas (historical tiers may have differed)',
      notModelled: 'funding, order-book depth, exchange outages, mark vs trade divergence',
    },
    results,
  };
  const dir = join(import.meta.dirname, '../../../evidence');
  mkdirSync(dir, { recursive: true });
  const stem = `backtest-${ranAt.slice(0, 10)}`;
  writeFileSync(join(dir, `${stem}.json`), JSON.stringify(report, null, 1));
  const md = [
    `# Crash-day replays (${ranAt.slice(0, 16)}Z)`,
    '',
    `Source: ${source.name}. **Trade prices, not mark prices**: estimates until a mark-price source is connected.`,
    '',
    ...Object.entries(report.assumptions).map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join('; ') : v}`),
    '',
    '| Case | Lev | Drop to low | Unguarded | Guarded | Equity kept | Guard orders | Fees |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const u = r.unguarded as { liquidated: boolean; endEquity?: number; at?: string };
      const g = r.guarded as { liquidated: boolean; endEquity: number; equityKeptPct: number; guardOrders: number; feesPaid: number };
      return `| ${r.title}${r.meaningfulOnTrades ? '' : ' (trade wick: not meaningful without mark prices)'} | ${r.leverage}× | ${r.dropToLowPct}% | ${u.liquidated ? `liquidated ${u.at?.slice(5, 16)}` : `kept ${u.endEquity}`} | ${g.liquidated ? 'liquidated' : 'survived'} | ${g.equityKeptPct}% | ${g.guardOrders} | ${g.feesPaid} |`;
    }),
  ].join('\n');
  writeFileSync(join(dir, `${stem}.md`), md + '\n');
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
