/**
 * The wider replay study (investigation): the same simulator and mark prices as backtest.ts, with
 *  - three set-ups: the server alone (as first published), the current guard (server + its resting
 *    backstop at the lowest line), and a proposal where every stage rests on Hyperliquid as a
 *    reduce-only trigger and the server is the second line;
 *  - the server on time, 1 and 5 minutes late;
 *  - a settings sweep (earlier/later lines, lighter/heavier trims), every setting an example for the test;
 *  - ordinary bad days picked by a fixed rule (find-ordinary-days.ts), not only the worst days.
 *
 *   HYDROMANCER_API_KEY=… pnpm --filter @bulwarkxyz/ops replays
 *
 * Writes evidence/replays-<date>.{json,md}.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAssetIndex, buildSnapshot, dexCollateral, maintenanceMargin, simulate, tiersForPosition, type AssetIndex, type Marks, type Policy, type RawClearinghouseState, type RawPerpDexs, type RawPerpMeta, type SimInput } from '@bulwarkxyz/guard-core';
import { CASES, EQUITY, FEE_RATE, LEVERAGES, POLICY, ROOT, SLIPPAGE_PCT, STAGE_TEXT, account, hydroSeries, info, largestHourDrop } from './replay-data.js';

const DELAYS = [0, 1, 5];

/** Two cross longs on the xyz dex, each half of `lev` × equity in notional. */
function account2(assets: AssetIndex, collateral: Map<string, number>, a: string, pa: number, b: string, pb: number, lev: number) {
  const legs = [[a, pa], [b, pb]] as const;
  const positions = legs.map(([coin, px]) => {
    const asset = assets.get(coin)!;
    const size = Math.floor(((EQUITY * lev) / 2 / px) * 10 ** asset.szDecimals) / 10 ** asset.szDecimals;
    return { coin, px, size, asset };
  });
  const ntl = positions.reduce((s, p) => s + p.size * p.px, 0);
  const mm = positions.reduce((s, p) => s + maintenanceMargin(tiersForPosition(p.asset.tiers, p.asset.maxLeverage), p.size * p.px), 0);
  const sum = { accountValue: String(EQUITY), totalNtlPos: '0', totalRawUsd: String(EQUITY - ntl), totalMarginUsed: '0' };
  const state: RawClearinghouseState = {
    marginSummary: sum,
    crossMarginSummary: sum,
    crossMaintenanceMarginUsed: String(mm),
    withdrawable: '0',
    assetPositions: positions.map((p) => ({ type: 'oneWay', position: { coin: p.coin, szi: String(p.size), leverage: { type: 'cross', value: lev }, entryPx: String(p.px), positionValue: String(p.size * p.px), unrealizedPnl: '0', liquidationPx: null, marginUsed: String((p.size * p.px) / lev), maxLeverage: p.asset.maxLeverage } })),
    time: 0,
  };
  return buildSnapshot({ abstraction: 'default', dexStates: { xyz: state }, spot: { balances: [] }, assets, dexCollateral: collateral });
}

/** Days picked by find-ordinary-days.ts (rule in that file), replayed over the whole UTC day. */
const ORDINARY = [
  { coin: 'xyz:SILVER', day: '2026-10-02', fall: '3.8% (13:00–16:00)' },
  { coin: 'xyz:SILVER', day: '2026-09-28', fall: '5.5% (00:00–08:00)' },
  { coin: 'xyz:CL', day: '2026-10-02', fall: '5.3% (00:00–14:00)' },
  { coin: 'xyz:CL', day: '2026-09-29', fall: '6.5% (05:00–23:00)' },
  { coin: 'xyz:SKHX', day: '2026-10-01', fall: '3.3% (06:00–15:00)' },
  { coin: 'xyz:SKHX', day: '2026-09-30', fall: '3.6% (00:00–22:00)' },
].map((d) => ({
  id: `ordinary-${d.coin.split(':')[1]!.toLowerCase()}-${d.day}`,
  title: `${{ 'xyz:SILVER': 'Silver', 'xyz:CL': 'Oil', 'xyz:SKHX': 'SK hynix' }[d.coin]}, ${d.day}`,
  coin: d.coin,
  start: `${d.day}T00:00:00Z`,
  end: new Date(Date.parse(`${d.day}T00:00:00Z`) + 86_400_000).toISOString().replace('.000', ''),
  fall: d.fall,
}));

type ModeId = 'server' | 'current' | 'resting' | 'restingSafe' | 'resting3';
const MODES: Record<ModeId, { label: string; opts: Partial<SimInput> }> = {
  server: { label: 'Server only (as first published)', opts: {} },
  current: { label: 'Current guard: server + resting backstop', opts: { backstops: true } },
  resting: { label: 'Proposed: stages resting on the exchange, fills 1% worse than the mark', opts: { stageTriggers: { gapPct: 1 } } },
  restingSafe: { label: 'Proposed, lower stages priced as if earlier ones fill 5% worse; fills 1% worse', opts: { stageTriggers: { gapPct: 1, planGapPct: 5 } } },
  resting3: { label: 'Proposed, fills 3% worse than the mark', opts: { stageTriggers: { gapPct: 3 } } },
};

/** Settings sweep: lines × trim size. Every setting is an example chosen for the test. */
const LINE_SETS = { earlier: [3, 2, 1.5], example: [2, 1.5, 1.2], later: [1.5, 1.25, 1.1] } as const;
const TRIMS = { light: 1.25, medium: 1.5, heavy: 2 } as const;
const sweepPolicy = (lines: readonly number[], f: number): Policy => ({
  version: 1,
  account: POLICY.account,
  rules: [
    { id: 'stage-1', when: { kind: 'buffer', below: lines[0]! }, then: [{ kind: 'reduceToBuffer', buffer: +(lines[0]! * f).toFixed(3) }] },
    { id: 'stage-2', when: { kind: 'buffer', below: lines[1]! }, then: [{ kind: 'reduceToBuffer', buffer: +(lines[1]! * f).toFixed(3) }] },
    { id: 'stage-3', when: { kind: 'buffer', below: lines[2]! }, then: [{ kind: 'close', target: { kind: 'all' } }] },
  ],
  execution: { maxSlippagePct: SLIPPAGE_PCT },
});
/** The example settings with each repeat choice on every stage. */
const withRepeat = (mode: 'oncePerBreach' | 'everyCrossing'): Policy => ({ ...POLICY, rules: POLICY.rules.map((r) => ({ ...r, repeat: { mode } })) });
const sweepText = (lines: readonly number[], f: number) => `below ${lines[0]}× → back to ${+(lines[0]! * f).toFixed(2)}×; below ${lines[1]}× → back to ${+(lines[1]! * f).toFixed(2)}×; below ${lines[2]}× → close`;

type Outcome = { liquidated: boolean; liquidatedAt: string | null; allLost: boolean; equityAtEnd: number | null; keptPct: number | null; orders: number; triggerFills: number; triggerMisses: number; missed: number; fees: number };
const cell = (o: Outcome) => (o.liquidated ? 'L' : o.allLost ? '0 (all lost)' : `${o.keptPct}%`);

/** Two-position accounts for the backstop-pricing comparison: the crash day's market and a related one. */
const PAIRS = [
  { id: 'pair-oil-brent', title: 'Oil and Brent, 23 March 2026', a: 'xyz:CL', b: 'xyz:BRENTOIL', start: '2026-03-22T00:00:00Z', end: '2026-03-25T00:00:00Z' },
  { id: 'pair-silver-gold', title: 'Silver and gold, 30 January 2026', a: 'xyz:SILVER', b: 'xyz:GOLD', start: '2026-01-29T00:00:00Z', end: '2026-02-01T00:00:00Z' },
  { id: 'pair-skhx-smsn', title: 'SK hynix and Samsung, 27 July 2026', a: 'xyz:SKHX', b: 'xyz:SMSN', start: '2026-07-26T00:00:00Z', end: '2026-07-29T00:00:00Z' },
];

async function main() {
  const perpDexs = (await info.perpDexs()) as RawPerpDexs;
  const metas = (await info.allPerpMetas()) as RawPerpMeta[];
  const assets = buildAssetIndex(perpDexs, metas);
  const collateral = dexCollateral(perpDexs, metas);
  const started = Date.now();
  let sims = 0;

  async function load(c: { id: string; coin: string; start: string; end: string }) {
    const series = await hydroSeries(c);
    if (!series) return null;
    return { series, path: series.points.map((p) => ({ [c.coin]: p.px })) as Marks[], at: (i: number | null) => (i === null ? null : new Date(series.points[i]!.t).toISOString()) };
  }

  function run(c: { coin: string }, d: NonNullable<Awaited<ReturnType<typeof load>>>, lev: number, policy: Policy, mode: ModeId, delayMin: number): Outcome {
    const { snapshot } = account(assets, collateral, c.coin, d.series.points[0]!.px, lev);
    const r = simulate({ policy, snapshot, path: d.path, now: d.series.points[0]!.t, feeRate: FEE_RATE, delaySteps: Math.ceil(delayMin / d.series.stepMinutes), stepMs: d.series.stepMinutes * 60_000, ...MODES[mode].opts });
    sims++;
    if (sims % 25 === 0) console.error(`${sims} runs, ${((Date.now() - started) / 1000).toFixed(0)} s`);
    // Fills worse than the remaining equity can take the account below zero; Hyperliquid would have
    // liquidated it first. Shown as everything lost, never as a negative balance.
    const allLost = r.liquidatedAt === null && r.final.accountValue <= 0;
    return {
      liquidated: r.liquidatedAt !== null,
      liquidatedAt: d.at(r.liquidatedAt),
      allLost,
      equityAtEnd: r.liquidatedAt !== null ? null : allLost ? 0 : +r.final.accountValue.toFixed(2),
      keptPct: r.liquidatedAt !== null ? null : allLost ? 0 : +((r.final.accountValue / EQUITY) * 100).toFixed(1),
      orders: r.steps.flatMap((s) => s.actions.filter((a) => a.type === 'order')).length,
      triggerFills: r.triggerFills,
      triggerMisses: r.triggerMisses,
      missed: r.missedOrders,
      fees: +r.feesPaid.toFixed(2),
    };
  }

  function noGuard(c: { coin: string }, d: NonNullable<Awaited<ReturnType<typeof load>>>, lev: number) {
    const { size, snapshot } = account(assets, collateral, c.coin, d.series.points[0]!.px, lev);
    const r = simulate({ policy: { ...POLICY, rules: [] }, snapshot, path: d.path, now: d.series.points[0]!.t, feeRate: FEE_RATE });
    const end = EQUITY + size * (d.series.points[d.series.points.length - 1]!.px - d.series.points[0]!.px);
    return r.unguardedLiquidatedAt !== null ? { liquidated: true, at: d.at(r.unguardedLiquidatedAt) } : { liquidated: false, equityAtEnd: +end.toFixed(2), keptPct: +((end / EQUITY) * 100).toFixed(1) };
  }

  const study = async (cases: Array<{ id: string; title: string; coin: string; start: string; end: string; fall?: string }>, withSweep: boolean) => {
    const out: Array<Record<string, unknown>> = [];
    for (const c of cases) {
      const d = await load(c);
      const asset = assets.get(c.coin);
      if (!d || !asset) {
        out.push({ case: c.id, title: c.title, error: 'no mark data for this window' });
        continue;
      }
      const levs = LEVERAGES.filter((l) => l <= asset.maxLeverage);
      const rows = levs.map((lev) => ({
        leverage: lev,
        noGuard: noGuard(c, d, lev),
        modes: Object.fromEntries((Object.keys(MODES) as ModeId[]).map((m) => [m, DELAYS.map((delay) => ({ delayMinutes: delay, ...run(c, d, lev, POLICY, m, delay) }))])),
      }));
      const sweep = withSweep
        ? Object.entries(LINE_SETS).flatMap(([ln, lines]) =>
            Object.entries(TRIMS).map(([tn, f]) => ({
              lines: ln,
              trim: tn,
              settings: sweepText(lines, f),
              byLeverage: levs.map((lev) => ({ leverage: lev, currentOnTime: run(c, d, lev, sweepPolicy(lines, f), 'current', 0), currentServer5Late: run(c, d, lev, sweepPolicy(lines, f), 'current', 5), restingServer5Late: run(c, d, lev, sweepPolicy(lines, f), 'resting', 5), restingSafeServer5Late: run(c, d, lev, sweepPolicy(lines, f), 'restingSafe', 5) })),
            })),
          )
        : [];
      // Repeat choice, side by side: current guard (server + backstop), on time and 5 minutes late.
      const repeatCompare = levs.map((lev) => ({
        leverage: lev,
        every: [run(c, d, lev, withRepeat('everyCrossing'), 'current', 0), run(c, d, lev, withRepeat('everyCrossing'), 'current', 5)],
        once: [run(c, d, lev, withRepeat('oncePerBreach'), 'current', 0), run(c, d, lev, withRepeat('oncePerBreach'), 'current', 5)],
      }));
      const pts = d.series.points;
      out.push({
        case: c.id, title: c.title, coin: c.coin, window: `${c.start} → ${c.end}`, resolution: d.series.resolution, points: pts.length,
        entryPrice: pts[0]!.px, lowestPrice: Math.min(...pts.map((p) => p.px)), endPrice: pts[pts.length - 1]!.px,
        largestHourDrop: largestHourDrop(pts), ...(c.fall ? { selectedFor: `fall of ${c.fall} on hourly trade prices` } : {}),
        rows, sweep, repeatCompare,
      });
    }
    return out;
  };

  // Backstop pricing for pools with several positions: before (each position alone) and after (together).
  const pairs: Array<Record<string, unknown>> = [];
  for (const pr of PAIRS) {
    const sa = await hydroSeries({ id: pr.id.replace('pair-', 'leg-a-'), coin: pr.a, start: pr.start, end: pr.end });
    const sb = await hydroSeries({ id: pr.id.replace('pair-', 'leg-b-'), coin: pr.b, start: pr.start, end: pr.end });
    if (!sa || !sb) {
      pairs.push({ case: pr.id, title: pr.title, error: 'no mark data for one of the markets' });
      continue;
    }
    // Align on the first market's rounds, carrying the second market's last price forward.
    let j = 0;
    const path: Marks[] = sa.points.map((p) => {
      while (j + 1 < sb.points.length && sb.points[j + 1]!.t <= p.t) j++;
      return { [pr.a]: p.px, [pr.b]: sb.points[j]!.px };
    });
    const at = (i: number | null) => (i === null ? null : new Date(sa.points[i]!.t).toISOString());
    const maxLev = Math.min(assets.get(pr.a)!.maxLeverage, assets.get(pr.b)!.maxLeverage);
    const rows = LEVERAGES.filter((l) => l <= maxLev).map((lev) => {
      const snapshot = account2(assets, collateral, pr.a, path[0]![pr.a]!, pr.b, path[0]![pr.b]!, lev);
      const one = (pricing: 'single' | 'together', delayMin: number) => {
        const r = simulate({ policy: POLICY, snapshot, path, now: sa.points[0]!.t, feeRate: FEE_RATE, delaySteps: Math.ceil(delayMin / sa.stepMinutes), stepMs: sa.stepMinutes * 60_000, backstops: true, backstopPricing: pricing });
        sims++;
        const allLost = r.liquidatedAt === null && r.final.accountValue <= 0;
        return { liquidated: r.liquidatedAt !== null, liquidatedAt: at(r.liquidatedAt), allLost, keptPct: r.liquidatedAt !== null ? null : allLost ? 0 : +((r.final.accountValue / EQUITY) * 100).toFixed(1), equityAtEnd: r.liquidatedAt !== null ? null : +Math.max(0, r.final.accountValue).toFixed(2), orders: 0, triggerFills: r.triggerFills, triggerMisses: 0, missed: r.missedOrders, fees: +r.feesPaid.toFixed(2) };
      };
      const ng = simulate({ policy: { ...POLICY, rules: [] }, snapshot, path, now: sa.points[0]!.t, feeRate: FEE_RATE });
      return {
        leverage: lev,
        noGuard: ng.unguardedLiquidatedAt !== null ? { liquidated: true, at: at(ng.unguardedLiquidatedAt) } : { liquidated: false, keptPct: +((ng.final.accountValue / EQUITY) * 100).toFixed(1) },
        single: DELAYS.map((m) => one('single', m)),
        together: DELAYS.map((m) => one('together', m)),
      };
    });
    const fall = (pts: Array<{ px: number }>) => +((Math.min(...pts.map((p) => p.px)) / pts[0]!.px - 1) * 100).toFixed(2);
    pairs.push({ case: pr.id, title: pr.title, markets: [pr.a, pr.b], resolution: [sa.resolution, sb.resolution], lowVsStartPct: [fall(sa.points), fall(sb.points)], largestHourDrop: [largestHourDrop(sa.points), largestHourDrop(sb.points)], rows });
  }

  const crash = await study(CASES.map((c) => ({ id: c.id, title: c.title, coin: c.coin, start: c.start, end: c.end })), true);
  const ordinary = await study(ORDINARY, true);

  const ranAt = new Date().toISOString();
  const assumptions = {
    account: `A cross long on the xyz dex, opened at the first mark of each window, with ${EQUITY.toLocaleString('en-US')} USDC of equity and nothing else in the account`,
    exampleSettings: `Example settings chosen for the test (not product defaults): ${STAGE_TEXT.join('; ')}. Except in the repeat comparison, stages act every time the line is crossed (how policies behaved before the choice existed)`,
    repeat: 'Repeat comparison: every stage set to "every crossing" or to "once per breach" (acts again only after the market recovers to where it was when the stage acted)',
    sweep: 'Every combination of three line sets and three trim sizes; each is an example chosen for the test',
    setups: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, v.label])),
    serverLate: `The server's orders and its re-placing of resting orders reach the exchange ${DELAYS.join(', ')} minutes after the decision; resting orders already on the exchange fire on the mark regardless`,
    serverOrderFills: `IOC at the worst price a ${SLIPPAGE_PCT}% slippage limit allows; a late IOC fills only if the mark is still within its limit; retries as in the guard`,
    backstopFills: 'A stop with a limit at the user’s slippage: once the mark crosses the trigger it rests as a limit and fills at that limit only when the mark is within it',
    stageTriggerFills: 'Market triggers: fill at the mark of the first round at or past the trigger, made 1% (or 3%) worse; no fill if that is more than 10% worse than the trigger (Hyperliquid’s market-trigger tolerance)',
    stageTriggerPlacement: 'Placed from the account before the window starts; re-placed by the server (late as above) after any fill or latch change; each stage’s trigger price holds other positions still',
    fees: `${FEE_RATE * 1e4} bps per fill, assumed`,
    notModelled: 'Funding, order-book depth and queue position, partial fills, Hyperliquid outages, other traders reacting, open-order and rate limits',
  };
  const report = { ranAt, priceKind: 'mark (Hydromancer)', assumptions, crash, ordinary, pairs };
  const stem = `replays-${ranAt.slice(0, 10)}`;
  mkdirSync(join(ROOT, 'evidence'), { recursive: true });
  writeFileSync(join(ROOT, 'evidence', `${stem}.json`), JSON.stringify(report, null, 1));

  const modeTable = (c: Record<string, unknown>) => {
    const rows = c.rows as Array<{ leverage: number; noGuard: { liquidated: boolean; keptPct?: number }; modes: Record<ModeId, Array<Outcome & { delayMinutes: number }>> }>;
    return [
      '| Leverage | Set-up | No guard | On time | Server 1 min late | Server 5 min late | Resting fills / misses (on time) |',
      '|---|---|---|---|---|---|---|',
      ...rows.flatMap((r) =>
        (Object.keys(MODES) as ModeId[]).map((m) => `| ${r.leverage}× | ${m} | ${r.noGuard.liquidated ? 'L' : `${r.noGuard.keptPct}%`} | ${r.modes[m].map(cell).join(' | ')} | ${r.modes[m][0]!.triggerFills} / ${r.modes[m][0]!.triggerMisses} |`),
      ),
    ];
  };
  const head = (c: Record<string, unknown>) => {
    const h = c.largestHourDrop as { pct: number };
    return `${c.coin}, ${c.window}, ${c.resolution}. Entry ${c.entryPrice}, low ${c.lowestPrice}, end ${c.endPrice}; largest fall within an hour ${h.pct}%.${c.selectedFor ? ` Selected for a ${c.selectedFor}.` : ''}`;
  };
  const md = [
    `# Replay study: resting stage orders, settings sweep, ordinary days (mark prices)`,
    '',
    `Run ${ranAt.slice(0, 16)}Z. Cells: share of the 10,000 USDC kept at the end of the window, or L (liquidated).`,
    '',
    ...Object.entries(assumptions).map(([k, v]) => `- **${k}:** ${typeof v === 'string' ? v : Object.entries(v).map(([a, b]) => `${a} = ${b}`).join('; ')}`),
    '',
    '## Crash days, example settings',
    '',
    ...crash.flatMap((c) => (c.error ? [`### ${c.title}`, '', String(c.error), ''] : [`### ${c.title}`, '', head(c), '', ...modeTable(c), ''])),
    '## Settings sweep (crash days, then ordinary days)',
    '',
    'Cells: current guard on time / current guard, server 5 min late / proposed, server 5 min late / proposed with safer pricing, server 5 min late.',
    '',
    ...[...crash, ...ordinary].flatMap((c) => {
      const sweep = c.sweep as Array<{ lines: string; trim: string; settings: string; byLeverage: Array<{ leverage: number; currentOnTime: Outcome; currentServer5Late: Outcome; restingServer5Late: Outcome; restingSafeServer5Late: Outcome }> }>;
      if (!sweep?.length) return [];
      const levs = sweep[0]!.byLeverage.map((b) => b.leverage);
      return [
        `### ${c.title}`,
        '',
        `| Lines | Trim | Settings | ${levs.map((l) => `${l}×`).join(' | ')} |`,
        `|---|---|---|${levs.map(() => '---').join('|')}|`,
        ...sweep.map((s) => `| ${s.lines} | ${s.trim} | ${s.settings} | ${s.byLeverage.map((b) => [b.currentOnTime, b.currentServer5Late, b.restingServer5Late, b.restingSafeServer5Late].map(cell).join(' / ')).join(' | ')} |`),
        '',
      ];
    }),
    '## Repeat choice, side by side (example settings, current guard)',
    '',
    'Cells: every crossing / once per breach; on time, then server 5 min late.',
    '',
    ...[...crash, ...ordinary].flatMap((c) => {
      const rc = c.repeatCompare as Array<{ leverage: number; every: Outcome[]; once: Outcome[] }> | undefined;
      if (!rc) return [];
      return [`### ${c.title}`, '', '| Leverage | On time: every / once | Server 5 min late: every / once | Orders on time: every / once |', '|---|---|---|---|', ...rc.map((r) => `| ${r.leverage}× | ${cell(r.every[0]!)} / ${cell(r.once[0]!)} | ${cell(r.every[1]!)} / ${cell(r.once[1]!)} | ${r.every[0]!.orders} / ${r.once[0]!.orders} |`), ''];
    }),
    '## Backstop pricing with two positions in one pool: each alone (before) / together (after)',
    '',
    'Two cross longs, half the exposure each; example settings; current guard (server + backstop). Cells: before / after.',
    '',
    ...pairs.flatMap((c) => {
      if (c.error) return [`### ${c.title}`, '', String(c.error), ''];
      const rows = c.rows as Array<{ leverage: number; noGuard: { liquidated: boolean; keptPct?: number }; single: Outcome[]; together: Outcome[] }>;
      const h = c.largestHourDrop as Array<{ pct: number }>;
      return [`### ${c.title}`, '', `${(c.markets as string[]).join(' + ')}; low vs start ${(c.lowVsStartPct as number[]).join('% / ')}%; largest fall within an hour ${h.map((x) => x.pct).join('% / ')}%.`, '', '| Leverage | No guard | On time | Server 1 min late | Server 5 min late |', '|---|---|---|---|---|', ...rows.map((r) => `| ${r.leverage}× | ${r.noGuard.liquidated ? 'L' : `${r.noGuard.keptPct}%`} | ${[0, 1, 2].map((k) => `${cell(r.single[k]!)} / ${cell(r.together[k]!)}`).join(' | ')} |`), ''];
    }),
    '## Ordinary bad days, example settings',
    '',
    ...ordinary.flatMap((c) => (c.error ? [`### ${c.title}`, '', String(c.error), ''] : [`### ${c.title}`, '', head(c), '', ...modeTable(c), ''])),
  ].join('\n');
  writeFileSync(join(ROOT, 'evidence', `${stem}.md`), md + '\n');
  console.error(`${sims} runs in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
