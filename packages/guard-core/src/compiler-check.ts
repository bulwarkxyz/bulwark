import { canonicalJson, Policy, Rule } from './policy.js';

/**
 * I5, compile-time half. A rule drafted by the plain-language layer is accepted only if
 *  (a) it parses against the schema,
 *  (b) every number in it is one the user typed (or that number as a fraction/percent), and
 *  (c) adding it to the current policy only adds protection: existing rules and execution settings
 *      are unchanged. Loosening is a manual edit with its own confirmation, never an AI draft.
 * Time words map to the fixed window table (windows.ts), which carries no numbers.
 */

const WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, half: 50, quarter: 25,
};

/** Numbers the user typed, as written. "20%", "20 percent", "5x", "$3,000", "twenty", "half". */
export function numbersInText(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g)) {
    out.push(Number(`${m[1]?.replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`));
  }
  const tokens = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (!(t in WORDS)) continue;
    const v = WORDS[t] as number;
    const next = tokens[i + 1];
    // "twenty five" → 25
    if (v >= 20 && v % 10 === 0 && next && next in WORDS && (WORDS[next] as number) < 10) {
      out.push(v + (WORDS[next] as number));
      i++;
    } else out.push(v);
  }
  return out;
}

/** Every numeric leaf in a value, with its path. */
export function numericLeaves(value: unknown, path = ''): Array<{ path: string; value: number }> {
  if (typeof value === 'number') return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => numericLeaves(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => numericLeaves(v, path ? `${path}.${k}` : k));
  }
  return [];
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

export interface CompileCheck {
  ok: boolean;
  rule: Rule | null;
  policy: Policy | null;
  violations: string[];
  /** Where each number came from, for the UI ("20% · you typed it"). */
  provenance: Array<{ path: string; value: number; typed: number }>;
}

export function checkDraft(text: string, current: Policy, draft: unknown): CompileCheck {
  const violations: string[] = [];
  const parsed = Rule.safeParse(draft);
  if (!parsed.success) return { ok: false, rule: null, policy: null, violations: parsed.error.issues.map((i) => `schema: ${i.path.join('.')} ${i.message}`), provenance: [] };
  const rule = parsed.data;

  // (b) number provenance — the rule's own source text is excluded from the check.
  const typed = numbersInText(text);
  const provenance: CompileCheck['provenance'] = [];
  const { source: _source, ...body } = rule;
  for (const leaf of numericLeaves(body)) {
    const match = typed.find((t) => close(leaf.value, t) || close(leaf.value, t / 100) || close(leaf.value * 100, t));
    if (match === undefined) violations.push(`the number ${leaf.value} at ${leaf.path} is not in what you typed`);
    else provenance.push({ path: leaf.path, value: leaf.value, typed: match });
  }

  // (c) only adds protection
  if (current.rules.some((r) => r.id === rule.id)) violations.push(`rule id ${rule.id} already exists; a draft can only add a new rule`);
  const proposed: Policy = { ...current, version: current.version + 1, rules: [...current.rules, rule] };
  const verdict = onlyAddsProtection(current, proposed);
  violations.push(...verdict);

  const ok = violations.length === 0;
  return { ok, rule, policy: ok ? Policy.parse(proposed) : null, violations, provenance };
}

/** Returns reasons `proposed` is not a pure addition to `current` (empty when it is). */
export function onlyAddsProtection(current: Policy, proposed: Policy): string[] {
  const out: string[] = [];
  if (proposed.account.toLowerCase() !== current.account.toLowerCase()) out.push('account changed');
  if (proposed.version !== current.version + 1) out.push('version must increase by one');
  if (canonicalJson(proposed.execution) !== canonicalJson(current.execution)) out.push('execution settings changed');
  for (const r of current.rules) {
    const after = proposed.rules.find((x) => x.id === r.id);
    if (!after) out.push(`rule ${r.id} removed`);
    else if (canonicalJson(after) !== canonicalJson(r)) out.push(`rule ${r.id} changed`);
  }
  const ids = proposed.rules.map((r) => r.id);
  if (new Set(ids).size !== ids.length) out.push('duplicate rule ids');
  return out;
}
