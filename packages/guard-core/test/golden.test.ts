/**
 * Golden tests: our margin maths must reproduce what Hyperliquid's API reported for real accounts
 * captured from mainnet (scripts/capture-fixtures.mjs), in every account mode.
 */
import { describe, expect, it } from 'vitest';
import { maintenanceMargin } from '../src/margin.js';
import { assessRisk } from '../src/risk.js';
import { buildSnapshot } from '../src/snapshot.js';
import { accounts, assets, collateral } from './fixtures.js';

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-9, Math.abs(b));

/** The official function from the account-abstraction docs, transcribed for comparison. */
function officialUnifiedRatio(fx: (typeof accounts)[number]): number {
  const crossByToken: Record<number, number> = {};
  const isoByToken: Record<number, number> = {};
  for (const [dex, st] of Object.entries(fx.dexes)) {
    const token = collateral.get(dex) ?? 0;
    crossByToken[token] = (crossByToken[token] ?? 0) + Number(st.crossMaintenanceMarginUsed);
    for (const ap of st.assetPositions) {
      if (ap.position.leverage.type === 'isolated') isoByToken[token] = (isoByToken[token] ?? 0) + Number(ap.position.marginUsed);
    }
  }
  let max = 0;
  for (const [t, cross] of Object.entries(crossByToken)) {
    const total = Number(fx.spot.balances.find((b) => b.token === Number(t))?.total ?? 0);
    const available = total - (isoByToken[Number(t)] ?? 0);
    if (available > 0) max = Math.max(max, cross / available);
  }
  return max;
}

it('has fixtures for every supported mode', () => {
  const modes = new Set(accounts.map((a) => a.mode));
  expect(modes.has('unifiedAccount')).toBe(true);
  expect([...modes].some((m) => m === 'disabled' || m === 'default')).toBe(true);
  expect(modes.has('portfolioMargin')).toBe(true);
});

describe.each(accounts.map((a) => [a.label, a] as const))('%s', (_label, fx) => {
  const snapshot = buildSnapshot({ abstraction: fx.mode, dexStates: fx.dexes, spot: fx.spot, assets, dexCollateral: collateral });
  const risk = assessRisk(snapshot);

  it('maintenance margin per dex equals crossMaintenanceMarginUsed', () => {
    for (const [dex, st] of Object.entries(fx.dexes)) {
      const ours = snapshot.positions
        .filter((p) => p.dex === dex && p.leverageType === 'cross')
        .reduce((s, p) => s + maintenanceMargin(p.tiers, Math.abs(p.api.positionValue)), 0);
      const api = Number(st.crossMaintenanceMarginUsed);
      expect(Math.abs(ours - api)).toBeLessThanOrEqual(Math.max(1e-6, 1e-7 * api));
    }
  });

  it('isolated margin equals rawUsd + size × mark', () => {
    for (const p of snapshot.positions.filter((x) => x.leverageType === 'isolated')) {
      expect((p.isolatedRawUsd ?? 0) + p.size * p.markAtSnapshot).toBeCloseTo(p.api.marginUsed, 4);
    }
  });

  if (fx.mode === 'disabled' || fx.mode === 'default') {
    it('cross account value equals totalRawUsd + Σ size × mark', () => {
      for (const [dex, st] of Object.entries(fx.dexes)) {
        const cross = snapshot.positions.filter((p) => p.dex === dex && p.leverageType === 'cross');
        const ours = Number(st.crossMarginSummary.totalRawUsd) + cross.reduce((s, p) => s + p.size * p.markAtSnapshot, 0);
        expect(rel(ours, Number(st.crossMarginSummary.accountValue))).toBeLessThan(1e-9);
      }
    });
  }

  if (fx.mode === 'unifiedAccount') {
    it('worst pool ratio equals the official computeUnifiedAccountRatio', () => {
      const official = officialUnifiedRatio(fx);
      const ours = Math.max(0, ...risk.pools.filter((p) => p.pool.kind === 'token').map((p) => p.ratio));
      expect(ours).toBeCloseTo(official, 10);
    });

    it('token available-after-maintenance matches the API', () => {
      for (const [token, value] of fx.spot.tokenToAvailableAfterMaintenance ?? []) {
        const pool = risk.pools.find((p) => p.pool.kind === 'token' && p.pool.token === token);
        if (!pool) continue;
        expect(pool.equity - pool.maintenance).toBeCloseTo(Number(value), 4);
      }
    });
  }

  if (fx.mode !== 'portfolioMargin') {
    it('liquidation price matches the API for every position', () => {
      let checked = 0;
      for (const pool of risk.pools) {
        for (const row of pool.positions) {
          const api = row.position.api.liquidationPx;
          if (api === null) {
            expect(row.liquidationPx).toBeNull();
            continue;
          }
          expect(row.liquidationPx).not.toBeNull();
          expect(rel(row.liquidationPx as number, api)).toBeLessThan(1e-6);
          checked++;
        }
      }
      expect(checked).toBeGreaterThanOrEqual(0);
    });
  } else {
    it('portfolio margin is reported as not supported', () => {
      expect(risk.supported).toBe(false);
      expect(risk.mode).toBe('portfolio');
    });
  }
});
