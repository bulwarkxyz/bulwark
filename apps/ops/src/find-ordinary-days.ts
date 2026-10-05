/**
 * Picks the "ordinary bad days" for the replays by a fixed rule, so the choice is not ours to tune:
 * for each market, every UTC day whose largest fall from an hourly high to a later hourly low is
 * between 3% and 8% and spans at least two hours, excluding the crash days (±1 day); then the two
 * most recent such days. Hourly trade candles from Hyperliquid (`candleSnapshot`) are used only to
 * choose the days; the replays themselves run on mark prices.
 *
 *   pnpm --filter @bulwarkxyz/ops find-ordinary-days
 */
import { InfoClient } from '@bulwarkxyz/hyperliquid';

const MARKETS = ['xyz:SILVER', 'xyz:CL', 'xyz:SKHX'];
const CRASH_DAYS = ['2026-01-30', '2026-03-23', '2026-07-27'];
const UNTIL = Date.parse(process.env.UNTIL ?? '2026-10-05T00:00:00Z');
const MIN_FALL = 3;
const MAX_FALL = 8;
const MIN_HOURS = 2;
const PER_MARKET = 2;

const info = new InfoClient('mainnet');
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const near = (d: string) => CRASH_DAYS.some((c) => Math.abs(Date.parse(d) - Date.parse(c)) <= 86_400_000);

async function main() {
  const out: Array<{ coin: string; day: string; fallPct: number; from: string; to: string }> = [];
  for (const coin of MARKETS) {
    const candles = await info.request<Array<{ t: number; h: string; l: string }>>({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: UNTIL - 220 * 86_400_000, endTime: UNTIL } });
    const byDay = new Map<string, typeof candles>();
    for (const c of candles) byDay.set(day(c.t), [...(byDay.get(day(c.t)) ?? []), c]);
    const found: typeof out = [];
    for (const [d, cs] of byDay) {
      if (cs.length < 20 || near(d)) continue;
      let best = { fall: 0, from: 0, to: 0 };
      for (let i = 0; i < cs.length; i++)
        for (let j = i; j < cs.length; j++) {
          const fall = (1 - Number(cs[j]!.l) / Number(cs[i]!.h)) * 100;
          if (fall > best.fall) best = { fall, from: cs[i]!.t, to: cs[j]!.t };
        }
      const hours = (best.to - best.from) / 3_600_000;
      if (best.fall >= MIN_FALL && best.fall <= MAX_FALL && hours >= MIN_HOURS) found.push({ coin, day: d, fallPct: +best.fall.toFixed(2), from: new Date(best.from).toISOString().slice(11, 16), to: new Date(best.to + 3_600_000).toISOString().slice(11, 16) });
    }
    out.push(...found.sort((a, b) => b.day.localeCompare(a.day)).slice(0, PER_MARKET));
    console.error(`${coin}: ${found.length} qualifying days`);
  }
  console.log(JSON.stringify(out, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
