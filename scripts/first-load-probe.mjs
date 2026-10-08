#!/usr/bin/env node
// Fresh-browser loads of /app, timed to "Connect wallet"; for any load over 5 s, the slowest requests with their phases
// (DNS, connect, TLS, time to first byte), server-timing and x-vercel-id. Run it right after a deploy: on 8 Oct 2026 the
// first loads after a deploy took 12 s, 15 s and 76 s, and none of 16 loads half an hour later took over 4.3 s.
//   node scripts/first-load-probe.mjs [https://bulwark.0xo.in] [loads, default 16]
import { chromium } from 'playwright';
const site = process.argv[2] ?? 'https://bulwark.0xo.in';
const loads = Number(process.argv[3] ?? 16);
const b = await chromium.launch();
for (let i = 0; i < loads; i++) {
  const ctx = await b.newContext(i % 2 ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const done = [];
  p.on('requestfinished', (r) => done.push(r));
  p.on('requestfailed', (r) => done.push(r));
  const t0 = Date.now();
  let res;
  try {
    await p.goto(`${site}/app`, { timeout: 120_000 });
    await p.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first().waitFor({ timeout: 120_000 });
    res = Date.now() - t0;
  } catch (e) { res = 'TIMEOUT'; }
  if (typeof res === 'number' && res < 5000) { console.log(`${i}: ${res} ms`); await ctx.close(); continue; }
  console.log(`${i}: SLOW ${res} ms`);
  const rows = [];
  for (const r of done) {
    const t = r.timing();
    const st = (await r.response().catch(() => null))?.headers()?.['server-timing'] ?? '';
    rows.push({ total: Math.round(t.responseEnd), dns: Math.round(t.domainLookupEnd - t.domainLookupStart), connect: Math.round(t.connectEnd - t.connectStart), tls: Math.round(t.connectEnd - t.secureConnectionStart), ttfb: Math.round(t.responseStart - t.requestStart), url: r.url().replace(site, '').slice(0, 80), st, vid: (await r.response().catch(() => null))?.headers()?.['x-vercel-id'] ?? '' });
  }
  rows.sort((a, b) => b.total - a.total);
  for (const x of rows.slice(0, 6)) console.log('  ', JSON.stringify(x));
  await ctx.close();
}
await b.close();
