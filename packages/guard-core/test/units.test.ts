import { describe, expect, it } from 'vitest';
import { liquidationPrice, maintenanceMargin } from '../src/margin.js';
import { Policy, canonicalJson, policyHash, ruleJsonSchema } from '../src/policy.js';
import { ceilSize, floorSize, roundPrice, toWire } from '../src/rounding.js';
import { windowContains, windowStart } from '../src/windows.js';
import { policy } from './helpers.js';

describe('maintenance margin tiers', () => {
  // BTC: 40× to 150M, then 20× — https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margin-tiers
  const btc = [{ lowerBound: 0, maxLeverage: 40 }, { lowerBound: 150_000_000, maxLeverage: 20 }];
  it('is continuous at the tier boundary', () => {
    expect(maintenanceMargin(btc, 150_000_000 - 1e-6)).toBeCloseTo(maintenanceMargin(btc, 150_000_000), 4);
  });
  it('uses the higher rate above the boundary', () => {
    expect(maintenanceMargin(btc, 200_000_000) - maintenanceMargin(btc, 150_000_000)).toBeCloseTo(50_000_000 * 0.025, 4);
  });
  it('matches the docs’ single-tier liquidation formula', () => {
    const tiers = [{ lowerBound: 0, maxLeverage: 20 }];
    const mark = 100, size = 10, equity = 40, l = 0.025;
    const docs = mark - (1 * (equity - size * mark * l)) / size / (1 - l);
    expect(liquidationPrice({ mark, size, equity, otherMaintenance: 0, tiers })).toBeCloseTo(docs, 9);
  });
});

describe('tick and lot rounding', () => {
  it('rounds sizes to szDecimals', () => {
    expect(floorSize(0.23999, 3)).toBe(0.239);
    expect(ceilSize(0.2301, 3)).toBe(0.231);
  });
  it('keeps at most 5 significant figures and 6 − szDecimals decimals', () => {
    expect(roundPrice(91.70239, 3, 'down')).toBe(91.702);
    expect(roundPrice(7731.85, 3, 'down')).toBe(7731.8);
    expect(roundPrice(7731.81, 3, 'up')).toBe(7731.9);
    expect(roundPrice(85123.7, 5, 'down')).toBe(85123);
    expect(roundPrice(0.0044531, 0, 'down')).toBe(0.004453);
  });
  it('writes numbers without exponents or trailing zeros', () => {
    expect(toWire(0.5)).toBe('0.5');
    expect(toWire(100)).toBe('100');
    expect(toWire(1e-7, 8)).toBe('0.0000001');
  });
});

describe('fixed windows follow New York time, including daylight saving', () => {
  it('weekend starts at the Friday close in EDT', () => {
    expect(windowContains('weekend', Date.UTC(2026, 9, 2, 19, 59))).toBe(false); // Fri 15:59 EDT
    expect(windowContains('weekend', Date.UTC(2026, 9, 2, 20, 0))).toBe(true); // Fri 16:00 EDT
    expect(windowStart('weekend', Date.UTC(2026, 9, 3, 12, 0))).toBe(Date.UTC(2026, 9, 2, 20, 0));
  });
  it('weekend ends at the Monday open', () => {
    expect(windowContains('weekend', Date.UTC(2026, 9, 5, 13, 29))).toBe(true); // Mon 09:29 EDT
    expect(windowContains('weekend', Date.UTC(2026, 9, 5, 13, 30))).toBe(false);
  });
  it('shifts by an hour in winter (EST)', () => {
    expect(windowContains('weekend', Date.UTC(2026, 11, 4, 20, 30))).toBe(false); // Fri 15:30 EST
    expect(windowContains('weekend', Date.UTC(2026, 11, 4, 21, 0))).toBe(true); // Fri 16:00 EST
  });
  it('overnight covers weeknights and the weekend; us_session the rest', () => {
    const tueNoonNY = Date.UTC(2026, 9, 6, 16, 0);
    expect(windowContains('us_session', tueNoonNY)).toBe(true);
    expect(windowContains('overnight', tueNoonNY)).toBe(false);
    expect(windowContains('overnight', Date.UTC(2026, 9, 7, 3, 0))).toBe(true);
  });
});

describe('policy hashing', () => {
  const p = policy([{ id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }] }]);
  it('does not depend on key order', () => {
    const reordered = { execution: p.execution, rules: p.rules, account: p.account, version: p.version };
    expect(policyHash(reordered as Policy)).toBe(policyHash(p));
    expect(policyHash(p)).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('changes when any number changes', () => {
    const q = { ...p, rules: [{ ...p.rules[0]!, when: { kind: 'buffer' as const, below: 2.01 } }] };
    expect(policyHash(q)).not.toBe(policyHash(p));
  });
  it('canonical JSON sorts keys', () => expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}'));
  it('exports a JSON Schema for one rule', () => expect(JSON.stringify(ruleJsonSchema())).toContain('reduceToBuffer'));
});
