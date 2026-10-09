import { describe, expect, it } from 'vitest';
import { actionWords } from '../src/guard.js';

// Audit entries name the market and side (10 Oct 2026); before, they read "order sent, filled …" with no market.
describe('guard actions in words, for the audit log', () => {
  const base = { ruleId: 'r', reason: 'why' } as const;
  it('names the market and side of an order, the pool of a transfer, the market of a margin top-up', () => {
    expect(actionWords({ ...base, type: 'order', dex: 'xyz', coin: 'xyz:GOLD', assetId: 1, isBuy: false, size: 1, limitPx: 1, reduceOnly: true, tif: 'Ioc', closesPosition: false } as never, 'sent')).toBe('Reduce xyz:GOLD: sell order sent');
    expect(actionWords({ ...base, type: 'order', dex: '', coin: 'BTC', assetId: 0, isBuy: true, size: 1, limitPx: 1, reduceOnly: true, tif: 'Ioc', closesPosition: true } as never, 'failed')).toBe('Reduce BTC: buy order failed');
    expect(actionWords({ ...base, type: 'transfer', source: 'spot', toDex: 'xyz', amount: 2, token: 0 } as never, 'sent')).toBe('Move 2 USDC to the xyz pool: sent');
    expect(actionWords({ ...base, type: 'transfer', source: 'spot', toDex: '', amount: 2, token: 0 } as never, 'sent')).toBe('Move 2 USDC to the main pool: sent');
    expect(actionWords({ ...base, type: 'isolatedMargin', dex: 'xyz', coin: 'xyz:CL', assetId: 1, amount: 3 } as never, 'sent')).toBe('Add 3 USDC margin to xyz:CL: sent');
  });
});
