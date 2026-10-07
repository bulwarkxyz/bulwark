import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAssetIndex, dexCollateral } from '../src/assets.js';
import { planBackstops } from '../src/backstop.js';
import { buildSnapshot } from '../src/snapshot.js';
import type { Policy } from '../src/policy.js';
import type { RawPerpDexs, RawPerpMeta } from '../src/types.js';

// Recorded on testnet, 7 Oct 2026: BTC + ETH in the main pool, GOLD in the xyz pool, one line at 15×.
const fx = JSON.parse(readFileSync(new URL('./fixtures/multi-position-testnet-2026-10-07.json', import.meta.url), 'utf8'));
const assets = buildAssetIndex(fx.perpDexs as RawPerpDexs, fx.metas as RawPerpMeta[]);
const collateral = dexCollateral(fx.perpDexs as RawPerpDexs, fx.metas as RawPerpMeta[]);
const policy = { version: 1, account: '0x0000000000000000000000000000000000000001', rules: [{ id: 'line', when: { kind: 'buffer', below: fx.line }, then: [{ kind: 'alert' }], repeat: { mode: 'everyCrossing' } }], execution: { maxSlippagePct: 1 } } as Policy;
const snap = (s: { dexStates: Record<string, unknown>; spot: unknown }, mainEquity?: number) => {
  const dexStates = JSON.parse(JSON.stringify(s.dexStates));
  if (mainEquity !== undefined) dexStates[''].marginSummary.accountValue = dexStates[''].crossMarginSummary.accountValue = String(mainEquity);
  return buildSnapshot({ abstraction: 'disabled', dexStates, spot: s.spot as never, assets, dexCollateral: collateral });
};
const triggers = (plan: ReturnType<typeof planBackstops>) => Object.fromEntries(plan.place.map((t) => [t.coin, t.triggerPx]));

describe('several positions in one pool, from recorded testnet state', () => {
  it('the planner gives what the live guard placed, before and after the deposit', () => {
    for (const [label, live] of Object.entries(fx.live as Record<string, Record<string, number>>)) {
      const t = triggers(planBackstops(policy, snap(fx.states[label]), undefined, [], 'together'));
      for (const [coin, px] of Object.entries(live)) expect(Math.abs(t[coin]! - px) / px, `${label} ${coin}`).toBeLessThan(0.005);
    }
  });

  it('with ample margin, ETH (which alone cannot take the pool to the line) still gets the joint backstop', () => {
    // The state of the first, interrupted run: $20 in the main pool. Before the fix ETH got none.
    const plan = planBackstops(policy, snap(fx.states.marginsSet, 19.997), undefined, [], 'together');
    expect(plan.place.map((t) => t.coin).sort()).toEqual(['BTC', 'ETH', 'xyz:GOLD']);
    const btc = plan.place.find((t) => t.coin === 'BTC')!;
    const eth = plan.place.find((t) => t.coin === 'ETH')!;
    const fall = (t: typeof btc, mark: number) => 1 - t.triggerPx / mark;
    const s = snap(fx.states.marginsSet, 19.997);
    const mark = (c: string) => s.positions.find((p) => p.coin === c)!.markAtSnapshot;
    expect(fall(eth, mark('ETH'))).toBeCloseTo(fall(btc, mark('BTC')), 2); // the same joint move
  });
});
