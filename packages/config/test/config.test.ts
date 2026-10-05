import { describe, expect, it } from 'vitest';
import { builderEnabled, builderField, regionVerdict, strictestVerdict } from '../src/index.js';

describe('regions', () => {
  it('blocks the required list', () => {
    for (const c of ['US', 'PR', 'CA', 'GB', 'CU', 'IR', 'KP', 'SY', 'MM', 'RU', 'BY']) expect(regionVerdict(c)).toBe('blocked');
  });
  it('blocks sanctioned subdivisions in either header form', () => {
    expect(regionVerdict('UA', '43')).toBe('blocked');
    expect(regionVerdict('UA', 'UA-14')).toBe('blocked');
    expect(regionVerdict('UA', '30')).toBe('allowed'); // Kyiv
  });
  it('turns the guard off in the EU/EEA', () => {
    for (const c of ['DE', 'FR', 'NL', 'NO']) expect(regionVerdict(c)).toBe('guardOff');
  });
  it('does not block the prudent list yet', () => {
    for (const c of ['IN', 'SG', 'CN', 'KR', 'AE']) expect(regionVerdict(c)).toBe('allowed');
  });
  it('fails closed on unknown location', () => expect(regionVerdict(null)).toBe('blocked'));
  it('takes the strictest signal', () => {
    expect(strictestVerdict('allowed', 'guardOff')).toBe('guardOff');
    expect(strictestVerdict(regionVerdict('IN'), regionVerdict('US'))).toBe('blocked');
  });
});

describe('builder switch', () => {
  it('is off on mainnet and on for testnet by default', () => {
    expect(builderEnabled('mainnet', {})).toBe(false);
    expect(builderEnabled('testnet', {})).toBe(true);
    expect(builderField('mainnet', {})).toBeNull();
  });
  it('turns on with one variable', () => {
    expect(builderField('mainnet', { BUILDER_CODE_ENABLED_MAINNET: 'true' })).toEqual({ b: '0x813843cf39a4d312182af6c5b85cff9290c42981', f: 30 });
  });
});
