import { describe, expect, it } from 'vitest';
import type { GuardAction } from '../src/evaluate.js';
import { MAX_ACTIONS_PER_MINUTE, checkAction, isBuilderRejection } from '../src/invariants.js';
import { execCtx, policy, standardAccount } from './helpers.js';

const p = policy([{ id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'reduce', target: { kind: 'all' }, fraction: 0.5 }] }]);
const snap = standardAccount(
  {
    xyz: { positions: [{ coin: 'xyz:CL', size: 1, mark: 100 }, { coin: 'xyz:COIN', size: 0.1, mark: 200, isolatedMargin: 5 }], crossEquity: 4 },
    '': { positions: [{ coin: 'BTC', size: 0.001, mark: 100_000 }], crossEquity: 30, withdrawable: 20 },
  },
  50,
);
const cl = snap.positions.find((x) => x.coin === 'xyz:CL')!;

const sell = (over: Partial<Extract<GuardAction, { type: 'order' }>> = {}): GuardAction => ({
  type: 'order', ruleId: 'stage-1', reason: 't', dex: 'xyz', coin: 'xyz:CL', assetId: cl.asset.assetId,
  isBuy: false, size: 0.5, limitPx: 99.5, reduceOnly: true, tif: 'Ioc', closesPosition: false, ...over,
});
const check = (a: GuardAction & { builder?: { b: string; f: number } }, over = {}) => checkAction(a, p, snap, undefined, execCtx(p, over))?.invariant ?? null;

describe('I1 reduce-only', () => {
  it('accepts a valid trim', () => expect(check(sell())).toBeNull());
  it('rejects a non-reduce-only order', () => expect(check(sell({ reduceOnly: false as true }))).toBe('I1'));
  it('rejects an order on the same side as the position', () => expect(check(sell({ isBuy: true }))).toBe('I1'));
  it('rejects an order larger than the position', () => expect(check(sell({ size: 1.001 }))).toBe('I1'));
  it('rejects an order with no open position', () => expect(check(sell({ coin: 'xyz:GOLD' }))).toBe('I1'));
  it('rejects a limit outside the user’s slippage', () => expect(check(sell({ limitPx: 90 }))).toBe('I1'));
  it('rejects a non-IOC order', () => expect(check(sell({ tif: 'Gtc' as 'Ioc' }))).toBe('I1'));
});

describe('I2 no added risk', () => {
  it('only adds isolated margin, and only to isolated positions', () => {
    expect(check({ type: 'isolatedMargin', ruleId: 'stage-1', reason: 't', dex: 'xyz', coin: 'xyz:COIN', assetId: 1, amount: 1 })).toBeNull();
    expect(check({ type: 'isolatedMargin', ruleId: 'stage-1', reason: 't', dex: 'xyz', coin: 'xyz:COIN', assetId: 1, amount: -1 })).toBe('I2');
    expect(check({ type: 'isolatedMargin', ruleId: 'stage-1', reason: 't', dex: 'xyz', coin: 'xyz:CL', assetId: 1, amount: 1 })).toBe('I2');
  });
  it('never cancels the user’s reduce-only orders', () => {
    const openOrders = [{ coin: 'xyz:CL', oid: 7, side: 'A' as const, reduceOnly: true, isTrigger: true }];
    expect(check({ type: 'cancel', ruleId: 'stage-1', reason: 't', dex: 'xyz', coin: 'xyz:CL', oid: 7 }, { openOrders })).toBe('I2');
  });
});

describe('I3 own balances only', () => {
  const t = (over: Partial<Extract<GuardAction, { type: 'transfer' }>> = {}): GuardAction => ({ type: 'transfer', ruleId: 'stage-1', reason: 't', source: 'spot', toDex: 'xyz', amount: 5, token: 0, ...over });
  it('accepts a transfer from spot into the dex that needs it', () => expect(check(t())).toBeNull());
  it('rejects more than the source holds', () => expect(check(t({ amount: 51 }))).toBe('I3'));
  it('rejects a transfer into a dex with nothing at risk', () => expect(check(t({ toDex: 'para' }))).toBe('I3'));
  it('rejects draining another dex below the highest line', () => {
    // main: BTC notional 100, maintenance 1.25, equity 30 → room above 2× = 27.5; withdrawable caps it lower
    expect(check(t({ source: 'dex:', amount: 29 }))).toBe('I3');
  });
});

describe('I4 confirmed policy, kill switch, region', () => {
  it('blocks everything when the kill switch is on', () => expect(check(sell(), { killSwitch: true })).toBe('I4'));
  it('blocks actions under an unverified signature', () => expect(check(sell(), { confirmation: { policyHash: '0x', signatureVerified: false } })).toBe('I4'));
  it('blocks actions when the confirmed hash differs', () => expect(check(sell(), { confirmation: { policyHash: '0xdead', signatureVerified: true } })).toBe('I4'));
  it('blocks non-alert actions where automation is off', () => expect(check(sell(), { automationAllowed: false })).toBe('I4'));
  it('still lets alerts through where automation is off', () =>
    expect(check({ type: 'alert', ruleId: 'stage-1', reason: 't', level: 'warn' }, { automationAllowed: false })).toBeNull());
});

describe('I5 provenance at action time', () => {
  it('rejects an action from a rule that is not in the confirmed policy', () => expect(check(sell({ ruleId: 'made-up' }))).toBe('I5'));
});

describe('I6 rate cap and minimum', () => {
  it('rejects past the per-minute cap', () => {
    const now = Date.UTC(2026, 9, 7, 15, 0);
    expect(check(sell(), { now, recentActions: Array(MAX_ACTIONS_PER_MINUTE).fill(now - 1000) })).toBe('I6');
  });
  it('rejects a partial order under $10', () => expect(check(sell({ size: 0.05, limitPx: 99.5 }))).toBe('I6'));
});

describe('I7 builder code', () => {
  it('rejects a builder code while disabled', () => expect(check({ ...sell(), builder: { b: '0x1', f: 30 } })).toBe('I7'));
  it('rejects a fee above the user-approved maximum', () =>
    expect(check({ ...sell(), builder: { b: '0x1', f: 60 } }, { builder: { enabled: true, approvedMaxTenthsBps: 50, feeTenthsBps: 30 } })).toBe('I7'));
  it('accepts the approved fee', () =>
    expect(check({ ...sell(), builder: { b: '0x1', f: 30 } }, { builder: { enabled: true, approvedMaxTenthsBps: 50, feeTenthsBps: 30 } })).toBeNull());
  it('recognises the exchange’s builder rejections', () => {
    expect(isBuilderRejection('Builder fee has not been approved.')).toBe(true);
    expect(isBuilderRejection('Builder has insufficient balance to be approved.')).toBe(true);
    expect(isBuilderRejection('Order must have minimum value of $10.')).toBe(false);
  });
});
