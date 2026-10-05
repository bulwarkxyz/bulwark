/**
 * Crash-day replays: the same guard code (`simulate` → `evaluate`) on recorded Hyperliquid prices.
 *
 *   pnpm --filter @bulwarkxyz/ops backtest                  replay from the inputs stored in data/backtests/
 *   pnpm --filter @bulwarkxyz/ops backtest -- --refresh     re-fetch trade candles from Hyperliquid first
 *   pnpm --filter @bulwarkxyz/ops backtest -- --mark-dir D  use mark prices: D/<case>.csv with block_minute,mark_price
 *   HYDROMANCER_API_KEY=… pnpm --filter @bulwarkxyz/ops backtest -- --hydromancer
 *                                                           mark prices from Hydromancer (cached, not committed)
 *
 * Writes evidence/backtest-<source>-<date>.{json,md}. Every assumption is written next to the numbers.
 *
 * Price kinds:
 *   trade-candles  Hyperliquid candleSnapshot TRADE prices, the finest the public API still keeps for
 *                  these days (1 h; 4 h for January). Coarse, and liquidation runs on MARK price.
 *   mark           mark prices: Hydromancer `perpPriceHistoryByTime` (the accepted mark the exchange used,
 *                  one row per oracle round, about every 3 s; HIP-3 rounds exist from 2026-02-24). For
 *                  earlier days Hydromancer has only the deployer's submitted mark input
 *                  (`oraclePriceHistoryByTime` markPx), which is used and labelled as such.
 *
 * Scenario (example settings chosen for the test, not product defaults): a cross long on the xyz dex,
 * opened at the first price of the window with 10,000 USDC of equity, at several leverages, with and
 * without the guard, and with the guard's orders delayed by 0, 1 and 5 minutes (congestion). Each
 * guarded run is made twice: with the guard as it is (an order that did not fill is retried while its
 * stage holds) and without retries (the guard before that fix), so the difference is visible.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAssetIndex, dexCollateral, simulate, type Marks, type RawPerpDexs, type RawPerpMeta } from '@bulwarkxyz/guard-core';
import { CASES, DATA, DELAYS_MIN, EQUITY, FEE_RATE, HYDRO_CACHE, LEVERAGES, POLICY, ROOT, SLIPPAGE_PCT, STAGE_TEXT, SUBSTEPS, type Series, account, args, deviation, hydro, hydroRounds, hydroSeries, hydromancer, info, largestHourDrop, markDir, markSeries, refresh, submittedPoints, tradeSeries } from './replay-data.js';

async function main() {
  const perpDexs = (await info.perpDexs()) as RawPerpDexs;
  const metas = (await info.allPerpMetas()) as RawPerpMeta[];
  const assets = buildAssetIndex(perpDexs, metas);
  const collateral = dexCollateral(perpDexs, metas);
  const kind = markDir || hydromancer ? 'mark' : 'trade-candles';
  const out: Array<Record<string, unknown>> = [];

  for (const c of CASES) {
    const series = hydromancer ? await hydroSeries(c) : markDir ? markSeries(c, markDir) : await tradeSeries(c);
    const asset = assets.get(c.coin);
    if (!series || !asset || series.points.length < 2) {
      out.push({ case: c.id, title: c.title, error: 'no price data for this case' });
      continue;
    }
    const path: Marks[] = series.points.map((p) => ({ [c.coin]: p.px }));
    const p0 = series.points[0]!.px;
    const low = Math.min(...series.points.map((p) => p.px));
    const conclusive = series.kind === 'mark' || c.conclusiveOnTrades;
    const at = (i: number | null) => (i === null ? null : new Date(series.points[i]!.t).toISOString());
    const rows: Array<Record<string, unknown>> = [];
    for (const lev of LEVERAGES.filter((l) => l <= asset.maxLeverage)) {
      const { size, snapshot } = account(assets, collateral, c.coin, p0, lev);
      const sim = (m: number, retry: boolean) =>
        simulate({ policy: POLICY, snapshot, path, now: series.points[0]!.t, feeRate: FEE_RATE, delaySteps: Math.ceil(m / series.stepMinutes), retry, stepMs: series.stepMinutes * 60_000 });
      const outcome = (r: ReturnType<typeof simulate>) => ({
        liquidated: r.liquidatedAt !== null,
        liquidatedAt: at(r.liquidatedAt),
        equityAtEnd: r.liquidatedAt !== null ? null : +r.final.accountValue.toFixed(2),
        equityKeptPct: r.liquidatedAt !== null ? null : +((r.final.accountValue / EQUITY) * 100).toFixed(1),
        guardOrders: r.steps.flatMap((s) => s.actions.filter((a) => a.type === 'order')).length,
        missedOrders: r.missedOrders,
        feesPaid: +r.feesPaid.toFixed(2),
      });
      const runs = DELAYS_MIN.map((m) => {
        const r = sim(m, true);
        const before = m === 0 ? null : outcome(sim(m, false)); // with no delay fills are assumed, so retries never run
        return {
          delayMinutes: m,
          ...outcome(r),
          retryOrders: r.retryOrders,
          cannotFillAlertAt: at(r.retryAlertAt),
          rateCapped: r.rateCapped,
          withoutRetry: before,
          unguardedLiquidatedAt: at(r.unguardedLiquidatedAt),
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
    let submittedVsAccepted: ReturnType<typeof deviation> | null = null;
    if (hydromancer && series.resolution.startsWith('accepted')) submittedVsAccepted = deviation(series.points, await submittedPoints(c));
    out.push({
      case: c.id, title: c.title, coin: c.coin, priceKind: series.kind, resolution: series.resolution, window: `${c.start} → ${c.end}`,
      points: series.points.length, entryPrice: p0, lowestPrice: low, dropToLowPct: +((low / p0 - 1) * 100).toFixed(2), largestHourDrop: largestHourDrop(series.points),
      ...(submittedVsAccepted ? { submittedVsAccepted } : {}),
      conclusive, ...(conclusive ? {} : { inconclusiveBecause: (c as { why?: string }).why }), rows,
    });
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
    retry: 'An order that did not fill, or filled partly, is retried once its result is known (one delay later) while its stage still holds, re-priced from the mark at that time within the same slippage; at most 20 guard actions a minute (I6). "Before the fix" runs the same path without retries',
    margin: 'Current xyz maintenance tiers (historical tiers may have differed)',
    notModelled: 'Funding, order-book depth and queue position, partial fills, Hyperliquid outages, other traders reacting',
  };
  const report = { ranAt, priceKind: kind, assumptions, cases: out };
  const evidence = join(ROOT, 'evidence');
  mkdirSync(evidence, { recursive: true });
  const stem = `backtest-${kind}-${ranAt.slice(0, 10)}`;
  writeFileSync(join(evidence, `${stem}.json`), JSON.stringify(report, null, 1));

  type Outcome = { liquidated: boolean; equityKeptPct: number | null; missedOrders: number; guardOrders: number; feesPaid: number };
  const fmtGuard = (r: Outcome) => (r.liquidated ? 'liquidated' : `${r.equityKeptPct}% kept`) + (r.missedOrders ? ` (${r.missedOrders} missed)` : '');
  const md = [
    `# Crash-day replays: ${kind === 'mark' ? 'mark prices' : 'hourly trade prices (coarse)'}`,
    '',
    `Run ${ranAt.slice(0, 16)}Z. ${kind === 'mark' ? '' : '**Trade prices, not mark prices, at hourly (January: 4-hour) resolution. Liquidation and the guard run on mark price.**'}`,
    '',
    ...Object.entries(assumptions).map(([k, v]) => `- **${k}:** ${v}`),
    '',
    ...out.flatMap((c) => {
      if (c.error) return [`## ${c.title}`, '', String(c.error), ''];
      const rows = c.rows as Array<{ leverage: number; noGuard: { liquidated: boolean; at?: string; equityKeptPct?: number }; withGuard: Array<Outcome & { delayMinutes: number; retryOrders: number; cannotFillAlertAt: string | null; withoutRetry: Outcome | null }> }>;
      const hour = c.largestHourDrop as { pct: number; from: string; to: string };
      const sva = c.submittedVsAccepted as { matched: number; medianPct: number; p99Pct: number; maxPct: number } | undefined;
      return [
        `## ${c.title}`,
        '',
        `${c.coin}, ${c.window}, ${c.resolution}. Entry ${c.entryPrice}, lowest ${c.lowestPrice} (${c.dropToLowPct}%). Largest fall within an hour: ${hour.pct}% (${hour.from.slice(0, 16)}Z → ${hour.to.slice(11, 16)}Z).${c.conclusive ? '' : ` **Inconclusive:** ${c.inconclusiveBecause}`}`,
        ...(sva ? ['', `Deployer-submitted mark input vs accepted mark on this window (${sva.matched.toLocaleString('en-US')} rounds matched): median ${sva.medianPct}%, 99th percentile ${sva.p99Pct}%, largest ${sva.maxPct}%.`] : []),
        '',
        '| Leverage | No guard | Guard, no delay | Guard, 1 min late | Guard, 5 min late | Guard orders (no delay) | Fees (no delay) |',
        '|---|---|---|---|---|---|---|',
        ...rows.map((r) => `| ${r.leverage}× | ${r.noGuard.liquidated ? 'liquidated' : `${r.noGuard.equityKeptPct}% kept`} | ${r.withGuard.map(fmtGuard).join(' | ')} | ${r.withGuard[0]!.guardOrders} | ${r.withGuard[0]!.feesPaid} USDC |`),
        '',
        'Late orders, before and after the retry fix:',
        '',
        '| Leverage | Delay | Before the fix | With retries | Retry orders | "Cannot fill" alert |',
        '|---|---|---|---|---|---|',
        ...rows.flatMap((r) => r.withGuard.filter((g) => g.withoutRetry).map((g) => `| ${r.leverage}× | ${g.delayMinutes} min | ${fmtGuard(g.withoutRetry!)} | ${fmtGuard(g)} | ${g.retryOrders} | ${g.cannotFillAlertAt ? g.cannotFillAlertAt.slice(11, 16) + 'Z' : '—'} |`)),
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
