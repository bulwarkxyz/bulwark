import type { Policy } from '@bulwarkxyz/guard-core';
import { describe, expect, it } from 'vitest';
import { ANTHROPIC_MODEL, anthropicProvider, compileRule, describeRule, nextRuleId, OUTPUT_SCHEMA, REPEAT_QUESTION, repeatInText, type MessagesClient } from '../src/index.js';

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
    await compileRule(anthropicProvider(c), { text: 'cut it when it drops', policy, markets });
    const p = c.calls[0]!;
    expect(p.model).toBe(ANTHROPIC_MODEL);
    expect(p.tools).toBeUndefined();
    expect((p.output_config as { format: { type: string } }).format.type).toBe('json_schema');
    expect(String((p.messages as Array<{ content: string }>)[0]!.content)).toContain('<sentence>cut it when it drops</sentence>');
  });

  it('accepts a draft whose numbers the user typed and builds the next policy version', async () => {
    const text = 'Over the weekend, if CL drops 8%, cut my CL position by half, only once';
    const c = stub({
      outcome: 'rule',
      rule: { window: 'weekend', when: { kind: 'priceMove', market: 'xyz:CL', direction: 'down', movePct: 8, from: 'window_start' }, then: [{ kind: 'reduce', target: { kind: 'market', market: 'xyz:CL' }, fraction: 0.5 }], repeat: { mode: 'oncePerBreach' } },
      message: '',
    });
    const r = await compileRule(anthropicProvider(c), { text, policy, markets });
    expect(r.kind).toBe('draft');
    if (r.kind !== 'draft') return;
    expect(r.check.ok).toBe(true);
    expect(r.check.policy?.version).toBe(4);
    expect(r.check.policy?.rules).toHaveLength(2);
    expect(r.check.rule?.id).toBe('ai-2');
    expect(r.check.rule?.source).toEqual({ text, compiler: 'anthropic:claude-opus-5-5/v3' });
    expect(describeRule(r.check.rule!)).toBe('Fri US close → Mon US open: when CL moves down 8% or more since the window opened, cut the CL position by 50%. Acts once per fall, then leaves the rest to the backstop.');
  });

  it('the repeat choice comes only from the user’s words: if the sentence does not say, it asks, whatever the model returned', async () => {
    const rule = { when: { kind: 'buffer', below: 2 }, then: [{ kind: 'close', target: { kind: 'all' } }] };
    const ask = (text: string, repeat?: unknown) => compileRule(anthropicProvider(stub({ outcome: 'rule', rule: { ...rule, ...(repeat ? { repeat } : {}) }, message: '' })), { text, policy, markets });
    // Not said: asks, even when the model picked one.
    expect(await ask('below 2x close everything')).toMatchObject({ kind: 'clarify', question: REPEAT_QUESTION });
    expect(await ask('below 2x close everything', { mode: 'everyCrossing' })).toMatchObject({ kind: 'clarify', question: REPEAT_QUESTION });
    expect(await ask('once my buffer is below 2x close everything', { mode: 'oncePerBreach' })).toMatchObject({ kind: 'clarify' });
    expect(await ask('whenever the buffer is below 2x close everything', { mode: 'everyCrossing' })).toMatchObject({ kind: 'clarify' });
    // Said: accepted only if the model matched the words.
    expect(await ask('below 2x close everything, only once', { mode: 'oncePerBreach' })).toMatchObject({ kind: 'draft' });
    expect(await ask('below 2x close everything, only once', { mode: 'everyCrossing' })).toMatchObject({ kind: 'clarify' });
    expect(await ask('every time the buffer goes below 2x close everything', { mode: 'everyCrossing' })).toMatchObject({ kind: 'draft' });
    // A limit's numbers must be ones the user typed.
    const limited = await ask('every time the buffer goes below 2x close everything, at most 3 times in 24 hours', { mode: 'everyCrossing', limit: { times: 3, perHours: 24 } });
    expect(limited.kind === 'draft' && limited.check.ok).toBe(true);
    const invented = await ask('every time the buffer goes below 2x close everything', { mode: 'everyCrossing', limit: { times: 3, perHours: 24 } });
    expect(invented.kind === 'draft' && invented.check.ok).toBe(false);
  });

  it('reads the repeat choice from the words, not from "once" meaning "when"', () => {
    expect(repeatInText('only once')).toBe('oncePerBreach');
    expect(repeatInText('just the first time it happens')).toBe('oncePerBreach');
    expect(repeatInText('each time it drops below 2x')).toBe('everyCrossing');
    expect(repeatInText('once the buffer drops below 2x')).toBeNull();
    expect(repeatInText('whenever it drops')).toBeNull();
    expect(repeatInText('only once, every time')).toBeNull();
  });

  it('rejects a draft containing a number the user did not type (I5)', async () => {
    const c = stub({ outcome: 'rule', rule: { when: { kind: 'buffer', below: 1.5 }, then: [{ kind: 'close', target: { kind: 'all' } }] }, message: '' });
    const r = await compileRule(anthropicProvider(c), { text: 'close everything if things get bad', policy, markets });
    expect(r.kind === 'draft' && r.check.ok).toBe(false);
    expect(r.kind === 'draft' && r.check.violations.join()).toContain('1.5');
  });

  it('reports an out-of-range value as a violation instead of throwing', async () => {
    const c = stub({ outcome: 'rule', rule: { when: { kind: 'buffer', below: 2 }, then: [{ kind: 'reduce', target: { kind: 'all' }, fraction: 150 }] }, message: '' });
    const r = await compileRule(anthropicProvider(c), { text: 'below 2x cut 150%', policy, markets });
    expect(r.kind === 'draft' && r.check.ok).toBe(false);
  });

  it('passes through a refusal and a question when they carry no invented numbers', async () => {
    expect(await compileRule(anthropicProvider(stub({ outcome: 'refuse', rule: null, message: 'The guard cannot raise leverage.' })), { text: 'raise my leverage', policy, markets })).toMatchObject({ kind: 'refuse', reason: 'The guard cannot raise leverage.' });
    expect(await compileRule(anthropicProvider(stub({ outcome: 'clarify', rule: null, message: 'Which market?' })), { text: 'cut when down 5%', policy, markets })).toMatchObject({ kind: 'clarify', question: 'Which market?' });
  });

  it('replaces a question that suggests a number', async () => {
    const r = await compileRule(anthropicProvider(stub({ outcome: 'clarify', rule: null, message: 'Did you mean a 20% drop?' })), { text: 'cut CL if it drops a lot', policy, markets });
    expect(r.kind === 'clarify' && r.question).not.toContain('20');
  });

  it('treats a model refusal stop as a refusal', async () => {
    expect((await compileRule(anthropicProvider(stub({}, 'refusal')), { text: 'x', policy, markets })).kind).toBe('refuse');
  });

  it('does not call the model for empty or overlong input', async () => {
    const c = stub({});
    expect((await compileRule(anthropicProvider(c), { text: '  ', policy, markets })).kind).toBe('clarify');
    expect((await compileRule(anthropicProvider(c), { text: 'a'.repeat(501), policy, markets })).kind).toBe('refuse');
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

describe('top-up wording', () => {
  it('says the exact amount, never "up to"', () => {
    const text = describeRule({ when: { kind: 'buffer', below: 2.5 }, then: [{ kind: 'topUp', maxUsdc: 150 }] });
    expect(text).toBe('When the buffer falls below 2.5×, move 150 USDC from your idle balance into the pool.');
    expect(text).not.toMatch(/up to/i);
  });
});
