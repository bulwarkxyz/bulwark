#!/usr/bin/env node
// What a first-time visitor downloads: JavaScript bytes over the wire (compressed) and uncompressed, and
// load timings, for each page given, on a cold cache. Also: the bytes fetched when the wallet modal opens.
// Usage: node scripts/bundle-size.mjs <baseUrl> [--json out.json] [--profile phone] [paths…]
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args.splice(i, 2)[1];
};
const jsonOut = opt('--json');
const phone = opt('--profile', 'laptop') === 'phone';
const [base = 'http://localhost:3230', ...paths] = args;
const pages = paths.length ? paths : ['/app', '/app/onboarding', '/app/trade/GOLD'];

const browser = await chromium.launch();
const out = [];
for (const path of pages) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  if (phone) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 85, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 });
  }
  const js = new Map();
  cdp.on('Network.responseReceived', (e) => {
    if (e.type === 'Script') js.set(e.requestId, { url: e.response.url, wire: 0, raw: 0 });
  });
  cdp.on('Network.dataReceived', (e) => {
    const r = js.get(e.requestId);
    if (r) r.raw += e.dataLength;
  });
  cdp.on('Network.loadingFinished', (e) => {
    const r = js.get(e.requestId);
    if (r) r.wire = e.encodedDataLength;
  });
  await page.goto(`${base}${path}`, { waitUntil: 'load', timeout: 120_000 });
  const sumNow = (k) => [...js.values()].reduce((s, r) => s + r[k], 0);
  const atLoad = { wire: sumNow('wire'), raw: sumNow('raw') };
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return { domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), fcp: fcp ? Math.round(fcp.startTime) : null };
  });
  const sum = (k) => [...js.values()].reduce((s, r) => s + r[k], 0);
  // Before the load event: what the first view waits for. Total: including what loads once the page is idle.
  const row = { path, scripts: js.size, loadWireKB: Math.round(atLoad.wire / 1024), totalWireKB: Math.round(sum('wire') / 1024), totalRawKB: Math.round(sum('raw') / 1024), ...nav };
  // The wallet modal: what opening it fetches, and how long until it's on screen.
  const btn = page.getByRole('button', { name: /^Connect( wallet)?$/ }).filter({ visible: true }).first();
  if (await btn.count()) {
    const before = new Set(js.keys());
    const t = Date.now();
    await btn.click();
    await page.locator('[role="dialog"]').filter({ visible: true }).first().waitFor({ timeout: 30_000 }).then(
      () => (row.modalMs = Date.now() - t),
      () => (row.modalMs = null),
    );
    await page.waitForTimeout(1000);
    row.modalJsWireKB = Math.round([...js].filter(([id]) => !before.has(id)).reduce((s, [, r]) => s + r.wire, 0) / 1024);
  }
  out.push(row);
  await ctx.close();
}
await browser.close();
console.table(out);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ base, phone, at: new Date().toISOString(), pages: out }, null, 1));
