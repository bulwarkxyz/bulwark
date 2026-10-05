import type { Policy } from '@bulwarkxyz/guard-core';
import { describe, expect, it } from 'vitest';
import { compileRule, OPENAI_MODEL, openAIProvider, OUTPUT_SCHEMA, stripNulls, toStrictSchema } from '../src/index.js';

const policy: Policy = { version: 1, account: '0x9959260f1aa229f8a70e0c495ca9b251106c1a86', rules: [{ id: 'stage-1', when: { kind: 'buffer', below: 3 }, then: [{ kind: 'alert' }] }], execution: { maxSlippagePct: 1 } };
const markets = [{ coin: 'xyz:CL', name: 'WTI crude oil' }];

/** A fake OpenAI Responses endpoint: records the request and answers with `output`. */
function fakeOpenAI(reply: (body: Record<string, unknown>) => unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    return { ok: status < 300, status, json: async () => reply(body) } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}
const message = (json: unknown) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(json) }] }], usage: { input_tokens: 1800, output_tokens: 400, input_tokens_details: { cached_tokens: 1200 } } });

/** Every object lists all its properties as required and is closed; checked over the whole schema. */
function everyObjectStrict(s: unknown): boolean {
  if (Array.isArray(s)) return s.every(everyObjectStrict);
  if (!s || typeof s !== 'object') return true;
  const o = s as Record<string, unknown>;
  if (o.type === 'object' && o.properties) {
    const keys = Object.keys(o.properties as object);
    if (o.additionalProperties !== false || JSON.stringify([...(o.required as string[])].sort()) !== JSON.stringify(keys.sort())) return false;
  }
  return Object.values(o).every(everyObjectStrict);
}

describe('OpenAI provider', () => {
  it('sends one strict json_schema request to the pinned model: no tools, not stored', async () => {
    const { f, calls } = fakeOpenAI(() => message({ outcome: 'clarify', rule: null, message: 'Which market?' }));
    await compileRule(openAIProvider({ apiKey: 'k', fetch: f }), { text: 'cut it when it drops', policy, markets });
    const c = calls[0]!;
    expect(c.url).toBe('https://api.openai.com/v1/responses');
    expect(c.headers.authorization).toBe('Bearer k');
    expect(c.body.model).toBe(OPENAI_MODEL);
    expect(c.body.tools).toBeUndefined();
    expect(c.body.store).toBe(false);
    expect(c.body.text).toMatchObject({ format: { type: 'json_schema', name: 'bulwark_rule_draft', strict: true } });
    expect(String(c.body.input)).toContain('<sentence>cut it when it drops</sentence>');
    expect(everyObjectStrict((c.body.text as { format: { schema: unknown } }).format.schema)).toBe(true);
  });

  it('strict schema: optional fields become nullable, and the nulls are stripped before our checks', () => {
    const strict = toStrictSchema(OUTPUT_SCHEMA) as { required: string[] };
    expect(strict.required.sort()).toEqual(['message', 'outcome', 'rule']);
    expect(stripNulls({ a: 1, b: null, c: { d: null, e: [1, null] } })).toEqual({ a: 1, c: { e: [1, null] } });
  });

  it('a draft through OpenAI goes through the same checks: typed numbers, the repeat choice from the words, the provider recorded', async () => {
    const rule = { window: null, when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }], repeat: { mode: 'everyCrossing', limit: null } };
    const ok = await compileRule(openAIProvider({ apiKey: 'k', fetch: fakeOpenAI(() => message({ outcome: 'rule', rule, message: '' })).f }), { text: 'every time my buffer drops below 2x, alert me', policy, markets });
    expect(ok.kind === 'draft' && ok.check.ok).toBe(true);
    expect(ok.kind === 'draft' && ok.check.rule?.source?.compiler).toBe('openai:gpt-6.1-sol/v3');
    expect(ok.usage).toEqual({ inputTokens: 1800, outputTokens: 400, cachedInputTokens: 1200 });
    const unsaid = await compileRule(openAIProvider({ apiKey: 'k', fetch: fakeOpenAI(() => message({ outcome: 'rule', rule, message: '' })).f }), { text: 'when my buffer drops below 2x, alert me', policy, markets });
    expect(unsaid.kind).toBe('clarify');
    const invented = await compileRule(openAIProvider({ apiKey: 'k', fetch: fakeOpenAI(() => message({ outcome: 'rule', rule: { ...rule, when: { kind: 'buffer', below: 1.5 } }, message: '' })).f }), { text: 'every time things look bad, alert me', policy, markets });
    expect(invented.kind === 'draft' && invented.check.ok).toBe(false);
  });

  it('maps a refusal, an incomplete answer and an HTTP error', async () => {
    const refusal = { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }], usage: {} };
    expect((await compileRule(openAIProvider({ apiKey: 'k', fetch: fakeOpenAI(() => refusal).f }), { text: 'raise my leverage', policy, markets })).kind).toBe('refuse');
    const incomplete = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: {} };
    await expect(compileRule(openAIProvider({ apiKey: 'k', fetch: fakeOpenAI(() => incomplete).f }), { text: 'x y', policy, markets })).rejects.toThrow(/ran out of tokens/);
    await expect(compileRule(openAIProvider({ apiKey: 'k', fetch: fakeOpenAI(() => ({ error: { message: 'bad key' } }), 401).f }), { text: 'x y', policy, markets })).rejects.toThrow(/OpenAI 401: bad key/);
  });
});
