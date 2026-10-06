import { describe, expect, it } from 'vitest';
import { ABSTRACTION, modeChange } from '../lib/account-mode';

describe('account mode', () => {
  it('maps to Hyperliquid’s abstraction names', () => {
    expect(ABSTRACTION).toEqual({ standard: 'disabled', unified: 'unifiedAccount' });
  });
  it('explains margin and guard changes for both directions', () => {
    const toUnified = modeChange('standard', 'unified');
    expect(toUnified.margin.join(' ')).toMatch(/One USDC balance/);
    expect(toUnified.guard.join(' ')).toMatch(/shared USDC pool/);
    const toStandard = modeChange('unified', 'standard');
    expect(toStandard.margin.join(' ')).toMatch(/its own cross-margin pool/);
    expect(toStandard.guard.join(' ')).toMatch(/per venue/);
    for (const c of [toUnified, toStandard]) expect(c.guard.join(' ')).toMatch(/nothing resting/);
  });
  it('says the guard starts acting when leaving a mode it does not act on', () => {
    expect(modeChange('portfolio', 'unified').guard.join(' ')).toMatch(/does not act on a portfolio margin account\. After the switch it watches/);
  });
});
