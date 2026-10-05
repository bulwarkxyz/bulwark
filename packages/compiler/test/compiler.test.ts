import type { Policy } from '@bulwarkxyz/guard-core';
import { describe, expect, it } from 'vitest';
import { compileRule, describeRule, MODEL, nextRuleId, OUTPUT_SCHEMA, type MessagesClient } from '../src/index.js';

const policy: Policy = {
  version: 3,
  account: '0x9959260f1aa229f8a70e0c495ca9b251106c1a86',
  rules: [{ id: 'stage-1', when: { kind: 'buffer', below: 3 }, then: [{ kind: 'alert' }] }],
  execution: { maxSlippagePct: 1 },
};
const markets = [
  { coin: 'xyz:CL', name: 'WTI crude oil' },
  { coin: 'xyz:GOLD', name: 'Gold' },
];

function stub(output: unknown, stop = 'end_turn'): MessagesClient & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        return { content: [{ type: 'thinking' }, { type: 'text', text: JSON.stringify(output) }], stop_reason: stop, usage: { input_tokens: 1800, output_tokens: 300 } };
      },
    },
  };
}

describe('compileRule', () => {
  it('sends one tool-free structured-output request to the pinned model', async () => {
    const c = stub({ outcome: 'clarify', rule: null, message: 'Which market?' });
    await compileRule(c, { text: 'cut it when it drops', policy, markets });
    const p = c.calls[0]!;
    expect(p.model).toBe(MODEL);
    expect(p.tools).toBeUndefined();
    expect((p.output_config as { format: { type: string } }).format.type).toBe('json_schema');
    expect(String((p.messages as Array<{ content: string }>)[0]!.content)).toContain('<sentence>cut it when it drops</sentence>');
  });

  it('accepts a draft whose numbers the user typed and builds the next policy version', async () => {
    const text = 'Over the weekend, if CL drops 8%, cut my CL position by half';
    const c = stub({
      outcome: 'rule',
      rule: { window: 'weekend', when: { kind: 'priceMove', market: 'xyz:CL', direction: 'down', movePct: 8, from: 'window_start' }, then: [{ kind: 'reduce', target: { kind: 'market', market: 'xyz:CL' }, fraction: 0.5 }] },
      message: '',
    });
    const r = await compileRule(c, { text, policy, markets });
    expect(r.kind).toBe('draft');
    if (r.kind !== 'draft') return;
    expect(r.check.ok).toBe(true);
    expect(r.check.policy?.version).toBe(4);
    expect(r.check.policy?.rules).toHaveLength(2);
    expect(r.check.rule?.id).toBe('ai-2');
    expect(r.check.rule?.source).toEqual({ text, compiler: 'claude-opus-5-5/v1' });
    expect(describeRule(r.check.rule!)).toBe('Fri US close → Mon US open: when CL moves down 8% or more since the window opened, cut the CL position by 50%.');
  });

  it('rejects a draft containing a number the user did not type (I5)', async () => {
    const c = stub({ outcome: 'rule', rule: { when: { kind: 'buffer', below: 1.5 }, then: [{ kind: 'close', target: { kind: 'all' } }] }, message: '' });
    const r = await compileRule(c, { text: 'close everything if things get bad', policy, markets });
    expect(r.kind === 'draft' && r.check.ok).toBe(false);
    expect(r.kind === 'draft' && r.check.violations.join()).toContain('1.5');
  });

  it('reports an out-of-range value as a violation instead of throwing', async () => {
    const c = stub({ outcome: 'rule', rule: { when: { kind: 'buffer', below: 2 }, then: [{ kind: 'reduce', target: { kind: 'all' }, fraction: 150 }] }, message: '' });
    const r = await compileRule(c, { text: 'below 2x cut 150%', policy, markets });
    expect(r.kind === 'draft' && r.check.ok).toBe(false);
  });

  it('passes through a refusal and a question when they carry no invented numbers', async () => {
    expect(await compileRule(stub({ outcome: 'refuse', rule: null, message: 'The guard cannot raise leverage.' }), { text: 'raise my leverage', policy, markets })).toMatchObject({ kind: 'refuse', reason: 'The guard cannot raise leverage.' });
    expect(await compileRule(stub({ outcome: 'clarify', rule: null, message: 'Which market?' }), { text: 'cut when down 5%', policy, markets })).toMatchObject({ kind: 'clarify', question: 'Which market?' });
  });

  it('replaces a question that suggests a number', async () => {
    const r = await compileRule(stub({ outcome: 'clarify', rule: null, message: 'Did you mean a 20% drop?' }), { text: 'cut CL if it drops a lot', policy, markets });
    expect(r.kind === 'clarify' && r.question).not.toContain('20');
  });

  it('treats a model refusal stop as a refusal', async () => {
    expect((await compileRule(stub({}, 'refusal'), { text: 'x', policy, markets })).kind).toBe('refuse');
  });

  it('does not call the model for empty or overlong input', async () => {
    const c = stub({});
    expect((await compileRule(c, { text: '  ', policy, markets })).kind).toBe('clarify');
    expect((await compileRule(c, { text: 'a'.repeat(501), policy, markets })).kind).toBe('refuse');
    expect(c.calls).toHaveLength(0);
  });
});

describe('output schema', () => {
  const walk = (s: unknown, f: (o: Record<string, unknown>) => void): void => {
    if (Array.isArray(s)) s.forEach((x) => walk(x, f));
    else if (s && typeof s === 'object') {
      f(s as Record<string, unknown>);
      Object.values(s).forEach((x) => walk(x, f));
    }
  };
  it('uses only keywords structured outputs supports and closes every object', () => {
    walk(OUTPUT_SCHEMA, (o) => {
      for (const k of ['const', 'oneOf', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems']) expect(o).not.toHaveProperty(k);
      if (o.type === 'object') expect(o.additionalProperties).toBe(false);
    });
    expect((OUTPUT_SCHEMA as { type: string }).type).toBe('object');
  });
  it('keeps discriminators as one-value enums', () => {
    expect(JSON.stringify(OUTPUT_SCHEMA)).toContain('"enum":["reduceToBuffer"]');
  });
});

describe('ids', () => {
  it('skips taken ids', () => {
    expect(nextRuleId({ ...policy, rules: [...policy.rules, { id: 'ai-2', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }] }] })).toBe('ai-3');
  });
});
