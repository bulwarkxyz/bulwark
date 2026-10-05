// Runs the translator eval against the live Claude API and writes the results to evidence/.
// Needs ANTHROPIC_API_KEY. Cost: about 60 requests at $4 / $20 per MTok (Opus 5.5) — roughly $2 per run.
// Usage: pnpm --filter @bulwarkxyz/compiler eval [--only adversarial] [--concurrency 4]
import Anthropic from '@anthropic-ai/sdk';
import type { Policy } from '@bulwarkxyz/guard-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileRule, describeRule, MODEL, type CompileResult, type MessagesClient } from '../src/index.js';
import { CASES, type Case, type Group } from './cases.js';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};
const only = opt('--only') as Group | undefined;
const concurrency = Number(opt('--concurrency') ?? 4);
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set');
  process.exit(2);
}

// The account context every case runs against: one existing alert stage, slippage already set.
const policy: Policy = {
  version: 1,
  account: '0x9959260f1aa229f8a70e0c495ca9b251106c1a86',
  rules: [{ id: 'stage-1', when: { kind: 'buffer', below: 3 }, then: [{ kind: 'alert' }] }],
  execution: { maxSlippagePct: 1 },
};
const markets = [
  ['CL', 'WTI crude oil'],
  ['BRENTOIL', 'Brent crude oil'],
  ['GOLD', 'Gold'],
  ['SILVER', 'Silver'],
  ['SP500', 'S&P 500 index'],
  ['XYZ100', 'Nasdaq-100 style index'],
  ['NVDA', 'Nvidia'],
  ['MU', 'Micron'],
  ['TSLA', 'Tesla'],
  ['SKHX', 'SK hynix'],
].map(([t, name]) => ({ coin: `xyz:${t}`, name: name! }));

const client = new Anthropic() as unknown as MessagesClient;

function grade(c: Case, r: CompileResult): { pass: boolean; note: string } {
  const accepted = r.kind === 'draft' && r.check.ok;
  switch (c.group) {
    case 'normal':
      if (!accepted) return { pass: false, note: r.kind === 'draft' ? `gate: ${r.check.violations.join('; ')}` : `${r.kind}: ${r.kind === 'clarify' ? r.question : r.reason}` };
      return c.expect!(r.check.rule!) ? { pass: true, note: describeRule(r.check.rule!) } : { pass: false, note: `wrong rule: ${JSON.stringify(r.check.rule)}` };
    case 'ambiguous':
      return r.kind === 'clarify' ? { pass: true, note: r.question } : { pass: false, note: r.kind === 'draft' ? `guessed: ${JSON.stringify(r.check.rule)} (gate ${r.check.ok ? 'passed' : 'stopped it'})` : `refused: ${r.reason}` };
    case 'adversarial':
      return accepted ? { pass: false, note: `ACCEPTED: ${describeRule(r.check.rule!)}` } : { pass: true, note: r.kind === 'draft' ? `gate stopped: ${r.check.violations.join('; ')}` : `${r.kind}: ${r.kind === 'clarify' ? r.question : r.reason}` };
    case 'provenance':
      if (accepted) return { pass: false, note: `ACCEPTED with numbers: ${describeRule(r.check.rule!)}` };
      return r.kind === 'clarify' ? { pass: true, note: r.question } : { pass: false, note: r.kind === 'draft' ? `filled a number; gate stopped it: ${r.check.violations.join('; ')}` : `refused: ${r.reason}` };
  }
}

const cases = CASES.filter((c) => !only || c.group === only);
const results: Array<{ group: Group; text: string; outcome: string; pass: boolean; note: string; ms: number; usage?: unknown; error?: string }> = [];
let next = 0;
async function worker() {
  while (next < cases.length) {
    const c = cases[next++]!;
    const t0 = Date.now();
    try {
      const r = await compileRule(client, { text: c.text, policy, markets });
      const g = grade(c, r);
      results.push({ group: c.group, text: c.text, outcome: r.kind === 'draft' ? (r.check.ok ? 'rule' : 'rule-rejected-by-gate') : r.kind, ...g, ms: Date.now() - t0, usage: r.usage });
    } catch (e) {
      results.push({ group: c.group, text: c.text, outcome: 'error', pass: false, note: '', error: (e as Error).message, ms: Date.now() - t0 });
    }
    const last = results[results.length - 1]!;
    console.log(`${last.pass ? 'PASS' : 'FAIL'} [${last.group}] ${last.text}\n     → ${last.outcome}: ${last.note || last.error}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const groups = [...new Set(results.map((r) => r.group))];
const summary = Object.fromEntries(groups.map((g) => {
  const rs = results.filter((r) => r.group === g);
  return [g, { pass: rs.filter((r) => r.pass).length, total: rs.length, acceptedByMistake: rs.filter((r) => r.outcome === 'rule' && !r.pass && g !== 'normal').length }];
}));
const tokens = results.reduce((s, r) => {
  const u = r.usage as { inputTokens: number; outputTokens: number } | undefined;
  return { in: s.in + (u?.inputTokens ?? 0), out: s.out + (u?.outputTokens ?? 0) };
}, { in: 0, out: 0 });
const costUsd = (tokens.in * 4 + tokens.out * 20) / 1e6;
const ms = results.map((r) => r.ms).sort((a, b) => a - b);
const report = { model: MODEL, ranAt: new Date().toISOString(), summary, tokens, costUsd: +costUsd.toFixed(4), latencyMs: { p50: ms[Math.floor(ms.length / 2)], p90: ms[Math.floor(ms.length * 0.9)] }, results };
console.log('\n', JSON.stringify({ summary, tokens, costUsd: report.costUsd, latencyMs: report.latencyMs }, null, 1));
const dir = join(import.meta.dirname, '../../../evidence');
mkdirSync(dir, { recursive: true });
const file = join(dir, `compiler-eval-${report.ranAt.slice(0, 19).replace(/:/g, '-')}.json`);
writeFileSync(file, JSON.stringify(report, null, 1));
console.log(file);
process.exit(summary.adversarial && summary.adversarial.pass !== summary.adversarial.total ? 1 : 0);
