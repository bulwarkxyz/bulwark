import type { Policy, Rule } from '@bulwarkxyz/guard-core';
import { describe, expect, it } from 'vitest';
import { EMPTY_FORM, THEN_OPTIONS, WHEN_OPTIONS, buildRule, draftChanges, draftFrom, draftPolicy, formFromRule, nextRuleId, type RuleForm } from '@/lib/rule-builder';

const ACCOUNT = '0x7c81e5a50a1931a5fbe663a916d31e46f804fd1e';
const form = (patch: Partial<RuleForm>): RuleForm => ({ ...EMPTY_FORM, ...patch });

describe('rule builder: no number the user did not type', () => {
  it('the empty form has no numbers in it', () => {
    for (const [k, v] of Object.entries(EMPTY_FORM)) if (typeof v === 'string' && /\d/.test(v)) throw new Error(`${k} has a preset number: ${v}`);
  });
  it('every trigger and action refuses to build until its numbers are typed', () => {
    for (const w of WHEN_OPTIONS)
      for (const t of THEN_OPTIONS) {
        const r = buildRule(form({ when: w.kind, then: t.kind, market: 'xyz:CL', toLevMarket: 'xyz:CL' }), 'x-1');
        expect(r.ok).toBe(false);
      }
  });
  it('every number in the rule is one from the form', () => {
    const r = buildRule(form({ when: 'buffer', line: '2.2', then: 'reduce', target: 'market', targetMarket: 'xyz:CL', share: '30' }), 'hand-1');
    expect(r).toEqual({ ok: true, rule: { id: 'hand-1', when: { kind: 'buffer', below: 2.2 }, then: [{ kind: 'reduce', target: { kind: 'market', market: 'xyz:CL' }, fraction: 0.3 }] } });
  });
});

describe('rule builder: checks', () => {
  it.each([
    [{ when: 'buffer', line: '1', then: 'alert' }, 'above 1×'],
    [{ when: 'buffer', line: '0.5', then: 'alert' }, 'above 1×'],
    [{ when: 'drawdown', drawdownPct: '100', then: 'alert' }, 'between 0% and 100%'],
    [{ when: 'priceMove', movePct: '5', then: 'alert' }, 'Choose the market'],
    [{ when: 'buffer', line: '2', then: 'reduce', share: '120' }, 'at most 100%'],
    [{ when: 'buffer', line: '2', then: 'reduce', target: 'market', share: '20' }, 'Choose which position'],
    [{ when: 'buffer', line: '2', then: 'reduceToBuffer', toBuffer: '1.5' }, 'above the line'],
    [{ when: 'buffer', line: '2', then: 'topUp', usdc: '-5' }, 'Type the USDC'],
  ] as Array<[Partial<RuleForm>, string]>)('%o → %s', (patch, problem) => {
    const r = buildRule(form(patch), 'x-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain(problem);
  });
  it('a window sets the baseline to the window start; without one it is the moment you sign', () => {
    const a = buildRule(form({ when: 'drawdown', drawdownPct: '4', window: 'weekend', then: 'alert' }), 'w-1');
    const b = buildRule(form({ when: 'drawdown', drawdownPct: '4', then: 'alert' }), 'w-2');
    expect(a.ok && a.rule).toMatchObject({ window: 'weekend', when: { baseline: 'window_start' } });
    expect(b.ok && b.rule).toMatchObject({ when: { baseline: 'rule_confirmed' } });
    expect(b.ok && 'window' in b.rule).toBe(false);
  });
});

describe('rule builder: Edit round-trips', () => {
  const cases: RuleForm[] = [
    form({ when: 'buffer', line: '3', then: 'alert' }),
    form({ when: 'buffer', line: '2.5', then: 'reduce', target: 'first_position', share: '25' }),
    form({ when: 'buffer', line: '1.8', then: 'close', target: 'all' }),
    form({ when: 'buffer', line: '2', then: 'reduceToBuffer', toBuffer: '3' }),
    form({ when: 'drawdown', drawdownPct: '6', window: 'overnight', then: 'topUp', usdc: '250' }),
    form({ when: 'priceMove', market: 'xyz:GOLD', direction: 'up', movePct: '3', then: 'cancelOpeningOrders' }),
    form({ when: 'leverageAbove', market: 'xyz:NVDA', leverage: '8', then: 'reduceToLeverage', toLevMarket: 'xyz:NVDA', toLeverage: '5' }),
    form({ when: 'buffer', line: '2.2', then: 'reduce', target: 'market', targetMarket: 'xyz:CL', share: '33.3' }),
  ];
  it.each(cases.map((c, i) => [i, c] as const))('case %i', (_, f) => {
    const built = buildRule(f, 'r-1');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const back = formFromRule(built.rule)!;
    const again = buildRule(back, 'r-1');
    expect(again).toEqual(built);
  });
  it('a translated rule with several actions is kept, not edited', () => {
    const r: Rule = { id: 'ai-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }, { kind: 'cancelOpeningOrders' }] };
    expect(formFromRule(r)).toBeNull();
  });
});

describe('policy draft', () => {
  const signed: Policy = {
    version: 3,
    account: ACCOUNT,
    rules: [
      { id: 'stage-1', when: { kind: 'buffer', below: 3 }, then: [{ kind: 'alert' }] },
      { id: 'stage-2', when: { kind: 'buffer', below: 2.5 }, then: [{ kind: 'reduce', target: { kind: 'first_position' }, fraction: 0.25 }] },
    ],
    execution: { maxSlippagePct: 0.5 },
  };
  it('starts equal to the signed version, with no changes', () => {
    const d = draftFrom(signed);
    expect(draftChanges(signed, d).any).toBe(false);
  });
  it('tracks added, changed and removed rules and the slippage', () => {
    const d = draftFrom(signed);
    d.rules = d.rules.filter((r) => r.id !== 'stage-1');
    d.rules = d.rules.map((r) => (r.id === 'stage-2' ? { ...r, when: { kind: 'buffer', below: 2.4 } } : r));
    d.rules.push({ id: nextRuleId(d.rules), when: { kind: 'buffer', below: 1.8 }, then: [{ kind: 'close', target: { kind: 'all' } }] });
    d.slippage = '0.4';
    expect(draftChanges(signed, d)).toEqual({ added: ['hand-1'], changed: ['stage-2'], removed: ['stage-1'], slippage: true, any: true });
    const p = draftPolicy(signed, d, ACCOUNT);
    expect(p.ok && p.policy.version).toBe(4);
    expect(p.ok && p.policy.execution.maxSlippagePct).toBe(0.4);
  });
  it('a first policy needs the slippage typed; nothing is filled in', () => {
    const d = draftFrom(null);
    expect(d).toEqual({ rules: [], slippage: '' });
    const p = draftPolicy(null, d, ACCOUNT);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.problem).toContain('slippage');
  });
  it('rule ids stay unique', () => {
    expect(nextRuleId([{ id: 'hand-1' }, { id: 'hand-2' }] as Rule[])).toBe('hand-3');
  });
});
