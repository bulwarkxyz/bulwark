import { describe, expect, it } from 'vitest';
import { checkDraft, numbersInText, onlyAddsProtection } from '../src/compiler-check.js';
import { policy } from './helpers.js';

const current = policy([{ id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'reduce', target: { kind: 'first_position' }, fraction: 0.25 }] }], 0.5);
const TEXT = 'Never let me lose more than 20 percent this weekend.';

describe('numbers the user typed', () => {
  it('reads digits, separators, decimals and words', () => {
    expect(numbersInText('close gold if it drops 5% overnight')).toEqual([5]);
    expect(numbersInText('top up at most $3,000')).toEqual([3000]);
    expect(numbersInText('keep oil under 2.5x')).toEqual([2.5]);
    expect(numbersInText('never lose more than twenty five percent')).toEqual([25]);
    expect(numbersInText('cut half')).toEqual([50]);
  });
});

describe('I5: drafts may only contain numbers the user typed', () => {
  it('accepts the weekend rule built from the sentence and the fixed table', () => {
    const draft = { id: 'weekend-limit', source: { text: TEXT, compiler: 'test' }, window: 'weekend', when: { kind: 'drawdown', atLeastPct: 20, baseline: 'window_start' }, then: [{ kind: 'close', target: { kind: 'all' } }] };
    const r = checkDraft(TEXT, current, draft);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.provenance).toEqual([{ path: 'when.atLeastPct', value: 20, typed: 20 }]);
    expect(r.policy?.version).toBe(2);
  });

  it('rejects the draft from the old mockup: a 15% step and a 50% reduction the user never typed', () => {
    const draft = { id: 'weekend-limit', window: 'weekend', when: { kind: 'drawdown', atLeastPct: 15, baseline: 'window_start' }, then: [{ kind: 'reduce', target: { kind: 'all' }, fraction: 0.5 }] };
    const r = checkDraft(TEXT, current, draft);
    expect(r.ok).toBe(false);
    expect(r.violations.join(' ')).toMatch(/15/);
    expect(r.violations.join(' ')).toMatch(/0\.5/);
  });

  it('accepts a typed percent stored as a fraction', () => {
    const text = 'If oil falls 8%, cut 30% of it';
    const draft = { id: 'oil-cut', when: { kind: 'priceMove', market: 'xyz:CL', direction: 'down', movePct: 8, from: 'rule_confirmed' }, then: [{ kind: 'reduce', target: { kind: 'market', market: 'xyz:CL' }, fraction: 0.3 }] };
    expect(checkDraft(text, current, draft).ok).toBe(true);
  });

  it('rejects a draft that fails the schema', () => {
    expect(checkDraft(TEXT, current, { id: 'x', when: { kind: 'buffer', below: 0.5 }, then: [] }).ok).toBe(false);
  });
});

describe('I5: a draft can only add protection', () => {
  it('rejects changing an existing rule', () => {
    const changed = { ...current, version: 2, rules: [{ ...current.rules[0]!, when: { kind: 'buffer' as const, below: 1.5 } }] };
    expect(onlyAddsProtection(current, changed)).toContain('rule stage-1 changed');
  });
  it('rejects removing a rule', () => expect(onlyAddsProtection(current, { ...current, version: 2, rules: [] })).toContain('rule stage-1 removed'));
  it('rejects touching execution settings', () =>
    expect(onlyAddsProtection(current, { ...current, version: 2, execution: { maxSlippagePct: 5 } })).toContain('execution settings changed'));
  it('rejects a draft reusing an existing rule id', () => {
    const draft = { id: 'stage-1', when: { kind: 'buffer', below: 3 }, then: [{ kind: 'alert' }] };
    expect(checkDraft('alert me below 3', current, draft).ok).toBe(false);
  });
});
