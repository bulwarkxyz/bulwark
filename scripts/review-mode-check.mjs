#!/usr/bin/env node
// Proves review mode (apps/app/lib/review.tsx) is compiled out of production builds.
// Builds the app three ways and scans everything Next emits (client chunks and server output):
//   1. production, flag unset                     → no review marker, no ?watch= reader
//   2. NEXT_PUBLIC_REVIEW_MODE=1 (review preview) → marker present (positive control: the check can see it)
//   3. VERCEL_ENV=production with the flag set    → no marker (production wins)
// Usage: node scripts/review-mode-check.mjs   (about three minutes; runs in CI)
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const app = new URL('../apps/app/', import.meta.url).pathname;
const MARKER = 'bulwark-review-mode-compiled-in';
const READER = /\.get\(\s*["']watch["']\s*\)/;

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    const st = statSync(p);
    return st.isDirectory() ? (f === 'cache' ? [] : files(p)) : /\.(js|html|json|rsc|body)$/.test(f) ? [p] : [];
  });
}
function build(env) {
  const clean = { ...process.env };
  delete clean.NEXT_PUBLIC_REVIEW_MODE;
  delete clean.VERCEL_ENV;
  execFileSync('npx', ['next', 'build'], { cwd: app, env: { ...clean, ...env }, stdio: 'ignore' });
  const out = files(join(app, '.next'));
  const hits = (re) => out.filter((f) => re.test(readFileSync(f, 'utf8')));
  return { marker: hits(new RegExp(MARKER)), reader: hits(READER) };
}

const cases = [
  { name: 'production (flag unset)', env: {}, expectMarker: false },
  { name: 'review preview (NEXT_PUBLIC_REVIEW_MODE=1)', env: { NEXT_PUBLIC_REVIEW_MODE: '1' }, expectMarker: true },
  { name: 'Vercel production with the flag set', env: { NEXT_PUBLIC_REVIEW_MODE: '1', VERCEL_ENV: 'production' }, expectMarker: false },
];
let failed = 0;
for (const c of cases) {
  const r = build(c.env);
  const markerOk = c.expectMarker ? r.marker.length > 0 : r.marker.length === 0;
  const readerOk = c.expectMarker ? r.reader.length > 0 : r.reader.length === 0;
  const ok = markerOk && readerOk;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: marker in ${r.marker.length} file(s), ?watch= reader in ${r.reader.length} file(s)`);
}
execFileSync('npx', ['next', 'build'], { cwd: app, env: (({ NEXT_PUBLIC_REVIEW_MODE, VERCEL_ENV, ...rest }) => rest)(process.env), stdio: 'ignore' });
if (failed) process.exit(1);
console.log('review mode is compiled out of production builds');
