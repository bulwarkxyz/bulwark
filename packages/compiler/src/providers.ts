import { z } from 'zod';

/**
 * The translator's model provider, behind one interface. A provider gets the fixed system text, the
 * user message and the output schema, and returns the model's JSON text. It is given no tools and
 * no keys: it can only return a draft, which our own code then checks (number provenance, only adds
 * protection, the repeat choice from the user's words) before the user sees and signs anything.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache, when it reports them. */
  cachedInputTokens?: number;
}

export interface Completion {
  text: string;
  stop: 'done' | 'refusal' | 'length';
  usage: Usage;
}

export interface TranslatorProvider {
  /** Stable id recorded on every drafted rule, e.g. "openai:gpt-6.1-sol". */
  id: string;
  /** What the product tells users, e.g. "OpenAI (GPT-6.1 Sol)". */
  label: string;
  complete(req: { system: string; user: string; schema: Record<string, unknown>; schemaName: string }): Promise<Completion>;
}

const DROP = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', '$schema', 'default']);

/**
 * JSON Schema for structured outputs: `const` becomes a one-value `enum` (so discriminators stay
 * enforced), `oneOf` becomes `anyOf`, bounds some APIs reject are dropped (our checks re-apply every
 * bound), and every object is closed with additionalProperties: false.
 */
export function toOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toOutputSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (DROP.has(k)) continue;
    if (k === 'const') out.enum = [v];
    else if (k === 'oneOf') out.anyOf = toOutputSchema(v);
    else if (k === 'properties' || k === '$defs' || k === 'definitions') out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toOutputSchema(pv)]));
    else out[k] = toOutputSchema(v);
  }
  if (out.type === 'object') out.additionalProperties = false;
  if ('enum' in out && !('type' in out)) out.type = typeof (out.enum as unknown[])[0] === 'number' ? 'number' : 'string';
  return out;
}

/**
 * OpenAI strict mode: every property is listed in `required`, and an optional one becomes a union
 * with null. `stripNulls` turns those nulls back into absent fields before our checks run.
 */
export function toStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const s = { ...(schema as Record<string, unknown>) };
  for (const k of ['anyOf', 'items', '$defs', 'definitions']) {
    if (k in s) s[k] = k === '$defs' || k === 'definitions' ? Object.fromEntries(Object.entries(s[k] as Record<string, unknown>).map(([n, d]) => [n, toStrictSchema(d)])) : toStrictSchema(s[k]);
  }
  if (s.type === 'object' && s.properties) {
    const props = s.properties as Record<string, unknown>;
    const required = new Set((s.required as string[] | undefined) ?? []);
    s.properties = Object.fromEntries(
      Object.entries(props).map(([k, v]) => {
        const strict = toStrictSchema(v) as Record<string, unknown>;
        if (required.has(k)) return [k, strict];
        return [k, strict.anyOf ? { ...strict, anyOf: [...(strict.anyOf as unknown[]), { type: 'null' }] } : { anyOf: [strict, { type: 'null' }] }];
      }),
    );
    s.required = Object.keys(props);
    s.additionalProperties = false;
  }
  return s;
}

/** Removes null-valued keys recursively (OpenAI strict mode sends null for an absent optional field). */
export function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null).map(([k, x]) => [k, stripNulls(x)]));
}

export const jsonSchemaOf = (t: z.ZodType) => toOutputSchema(z.toJSONSchema(t, { io: 'input' })) as Record<string, unknown>;

// ------------------------------------------------------------------ OpenAI (active)

export const OPENAI_MODEL = 'gpt-6.1-sol';

/**
 * OpenAI Responses API with a strict JSON-schema text format. `store: false`: OpenAI does not keep
 * the request for later retrieval. No tools are sent.
 */
export function openAIProvider(opts: { apiKey: string; model?: string; fetch?: typeof fetch; effort?: 'low' | 'medium' | 'high' }): TranslatorProvider {
  const model = opts.model ?? OPENAI_MODEL;
  const f = opts.fetch ?? fetch;
  return {
    id: `openai:${model}`,
    label: `OpenAI (${model === 'gpt-6.1-sol' ? 'GPT-6.1 Sol' : model})`,
    async complete({ system, user, schema, schemaName }) {
      const res = await f('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          instructions: system,
          input: user,
          reasoning: { effort: opts.effort ?? 'medium' },
          text: { format: { type: 'json_schema', name: schemaName, schema: toStrictSchema(schema), strict: true } },
          max_output_tokens: 6000,
          store: false,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const body = (await res.json()) as {
        status?: string;
        error?: { message?: string } | null;
        incomplete_details?: { reason?: string } | null;
        output?: Array<{ type: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>;
        usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
      };
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body.error?.message ?? 'request failed'}`);
      const usage = { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0, cachedInputTokens: body.usage?.input_tokens_details?.cached_tokens ?? 0 };
      const parts = (body.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []);
      if (parts.some((p) => p.type === 'refusal')) return { text: '', stop: 'refusal', usage };
      if (body.status === 'incomplete') return { text: '', stop: body.incomplete_details?.reason === 'content_filter' ? 'refusal' : 'length', usage };
      const text = parts.filter((p) => p.type === 'output_text').map((p) => p.text ?? '').join('');
      return { text: JSON.stringify(stripNulls(JSON.parse(text || 'null'))), stop: 'done', usage };
    },
  };
}

// ------------------------------------------------------------------ Anthropic (kept behind the same interface)

/** The slice of the Anthropic client used (lets tests pass a stub). */
export interface MessagesClient {
  messages: {
    create(params: Record<string, unknown>): Promise<{
      content: Array<{ type: string; text?: string }>;
      stop_reason: string | null;
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}

export const ANTHROPIC_MODEL = 'claude-opus-5-5';

export function anthropicProvider(client: MessagesClient, model = ANTHROPIC_MODEL): TranslatorProvider {
  return {
    id: `anthropic:${model}`,
    label: 'Anthropic (Claude)',
    async complete({ system, user, schema }) {
      const res = await client.messages.create({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: user }], output_config: { effort: 'medium', format: { type: 'json_schema', schema } } });
      const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
      if (res.stop_reason === 'refusal') return { text: '', stop: 'refusal', usage };
      if (res.stop_reason === 'max_tokens') return { text: '', stop: 'length', usage };
      return { text: res.content.find((b) => b.type === 'text')?.text ?? '', stop: 'done', usage };
    },
  };
}
