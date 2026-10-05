import { maintenanceMargin, tiersForPosition } from '../src/margin.js';
import type { Policy, Rule } from '../src/policy.js';
import { buildSnapshot, type AccountSnapshot } from '../src/snapshot.js';
import type { RawClearinghouseState, RawSpotState } from '../src/types.js';
import type { GuardContext } from '../src/evaluate.js';
import type { ExecutionContext } from '../src/invariants.js';
import { policyHash } from '../src/policy.js';
import { assets, collateral } from './fixtures.js';

export const ACCOUNT = '0x9959260f1aa229f8a70e0c495ca9b251106c1a86';

export interface PosSpec {
  coin: string;
  size: number;
  mark: number;
  entry?: number;
  leverage?: number;
  /** Isolated margin (marginUsed) at `mark`; omit for cross. */
  isolatedMargin?: number;
}

function dexOf(coin: string): string {
  return coin.includes(':') ? (coin.split(':')[0] as string) : '';
}

/** A clearinghouseState consistent with the API's own identities (checked by the golden tests). */
export function rawState(positions: PosSpec[], crossEquity: number, withdrawable = 0): RawClearinghouseState {
  const cross = positions.filter((p) => p.isolatedMargin === undefined);
  const crossNotional = cross.reduce((s, p) => s + p.size * p.mark, 0);
  const crossMM = cross.reduce((s, p) => {
    const a = assets.get(p.coin);
    if (!a) throw new Error(p.coin);
    return s + maintenanceMargin(tiersForPosition(a.tiers, a.maxLeverage), Math.abs(p.size) * p.mark);
  }, 0);
  const iso = positions.filter((p) => p.isolatedMargin !== undefined);
  const isoMargin = iso.reduce((s, p) => s + (p.isolatedMargin as number), 0);
  const summary = (av: number, raw: number) => ({ accountValue: String(av), totalNtlPos: '0', totalRawUsd: String(raw), totalMarginUsed: '0' });
  return {
    marginSummary: summary(crossEquity + isoMargin, crossEquity - crossNotional),
    crossMarginSummary: summary(crossEquity, crossEquity - crossNotional),
    crossMaintenanceMarginUsed: String(crossMM),
    withdrawable: String(withdrawable),
    assetPositions: positions.map((p) => {
      const a = assets.get(p.coin);
      if (!a) throw new Error(p.coin);
      const isolated = p.isolatedMargin !== undefined;
      return {
        type: 'oneWay',
        position: {
          coin: p.coin,
          szi: String(p.size),
          leverage: isolated ? { type: 'isolated' as const, value: p.leverage ?? 5, rawUsd: String((p.isolatedMargin as number) - p.size * p.mark) } : { type: 'cross' as const, value: p.leverage ?? 5 },
          entryPx: String(p.entry ?? p.mark),
          positionValue: String(Math.abs(p.size) * p.mark),
          unrealizedPnl: String(p.size * (p.mark - (p.entry ?? p.mark))),
          liquidationPx: null,
          marginUsed: isolated ? String(p.isolatedMargin) : String((Math.abs(p.size) * p.mark) / (p.leverage ?? 5)),
          maxLeverage: a.maxLeverage,
        },
      };
    }),
    time: 1_791_150_000_000,
  };
}

export function standardAccount(dexes: Record<string, { positions: PosSpec[]; crossEquity: number; withdrawable?: number }>, spotUsdc = 0): AccountSnapshot {
  const dexStates = Object.fromEntries(Object.entries(dexes).map(([d, v]) => [d, rawState(v.positions, v.crossEquity, v.withdrawable ?? 0)]));
  const spot: RawSpotState = { balances: [{ coin: 'USDC', token: 0, total: String(spotUsdc), hold: '0', entryNtl: '0' }] };
  return buildSnapshot({ abstraction: 'default', dexStates, spot, assets, dexCollateral: collateral });
}

/** Unified: one USDC balance; `usdcTotal` includes isolated margin, as the API reports it. */
export function unifiedAccount(positions: PosSpec[], usdcTotal: number): AccountSnapshot {
  const byDex = new Map<string, PosSpec[]>();
  for (const p of positions) byDex.set(dexOf(p.coin), [...(byDex.get(dexOf(p.coin)) ?? []), p]);
  const dexStates = Object.fromEntries([...byDex].map(([d, ps]) => [d, rawState(ps, 0)]));
  const crossMM = positions
    .filter((p) => p.isolatedMargin === undefined)
    .reduce((s, p) => {
      const a = assets.get(p.coin)!;
      return s + maintenanceMargin(tiersForPosition(a.tiers, a.maxLeverage), Math.abs(p.size) * p.mark);
    }, 0);
  const iso = positions.reduce((s, p) => s + (p.isolatedMargin ?? 0), 0);
  const spot: RawSpotState = {
    balances: [{ coin: 'USDC', token: 0, total: String(usdcTotal), hold: '0', entryNtl: '0' }],
    tokenToAvailableAfterMaintenance: [[0, String(usdcTotal - iso - crossMM)]],
  };
  return buildSnapshot({ abstraction: 'unifiedAccount', dexStates, spot, assets, dexCollateral: collateral });
}

export function policy(rules: Rule[], maxSlippagePct = 1): Policy {
  return { version: 1, account: ACCOUNT, rules, execution: { maxSlippagePct } };
}

export function ctx(over: Partial<GuardContext> = {}): GuardContext {
  return { now: Date.UTC(2026, 9, 7, 15, 0), baselines: {}, openOrders: [], latched: new Set(), automationAllowed: true, ...over };
}

export function execCtx(p: Policy, over: Partial<ExecutionContext> = {}): ExecutionContext {
  return { ...ctx(), confirmation: { policyHash: policyHash(p), signatureVerified: true }, killSwitch: false, recentActions: [], builder: null, ...over };
}
