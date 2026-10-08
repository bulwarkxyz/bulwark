// Loads each tab once in a real browser (its scripts, styles and images, as a first visitor), up to 2 minutes per tab,
// and prints how long each took. A fresh deployment's first full load can take far longer than its HTML.
import { chromium } from 'playwright';
const site = process.argv[2] ?? 'https://bulwark.0xo.in';
const tabs = ['/app', '/app/trade/GOLD', '/app/positions', '/app/rules', '/app/simulator', '/app/audit', '/app/settings', '/app/notifications'];
const browser = await chromium.launch();
let worst = 0;
for (const tab of tabs) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const reqs = [];
  p.on('requestfinished', (r) => reqs.push([Math.round(r.timing().responseEnd), r.url().replace(site, '')]));
  const t0 = Date.now();
  await p.goto(`${site}${tab}`, { waitUntil: 'load', timeout: 120_000 });
  const ms = Date.now() - t0;
  worst = Math.max(worst, ms);
  console.log(`  ${tab}: full load ${ms} ms`);
  // A slow first load: name the requests that held it up (what a fresh deployment serves slowly).
  if (ms > 10_000) for (const [t, u] of reqs.sort((a, b) => b[0] - a[0]).slice(0, 5)) console.log(`      ${t} ms  ${u.slice(0, 120)}`);
  await ctx.close();
}
await browser.close();
if (worst > 30_000) console.log(`  slowest first load: ${worst} ms`);
