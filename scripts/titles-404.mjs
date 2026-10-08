#!/usr/bin/env node
// Every route has its own title and description, and a missing page gets the designed not-found page with
// a 404 status. Screenshots of the not-found pages in both themes.
// Usage: node scripts/titles-404.mjs <local build url> <outDir>
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const [base = 'http://localhost:3230', out = 'titles-404'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const ROUTES = ['/app', '/app/trade/GOLD', '/app/positions', '/app/rules', '/app/simulator', '/app/audit', '/app/settings', '/app/account', '/app/onboarding', '/app/notifications'];
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let failed = 0;
const titles = new Set();
for (const r of ROUTES) {
  await p.goto(`${base}${r}`, { waitUntil: 'domcontentloaded' });
  const title = await p.title();
  const desc = (await p.locator('meta[name="description"]').getAttribute('content')) ?? '';
  const bad = !/· Bulwark$/.test(title) || titles.has(title) || desc.length < 40;
  titles.add(title);
  if (bad) failed++;
  console.log(`${bad ? 'FAIL' : 'ok  '} ${r}: "${title}" · ${desc.slice(0, 70)}…`);
}
for (const [path, name] of [['/app/no-such-screen', 'app-404'], ['/no-such-page', 'root-404']])
  for (const theme of ['dark', 'light']) {
    await p.addInitScript((t) => localStorage.setItem('theme', t), theme);
    const res = await p.goto(`${base}${path}`);
    await p.waitForTimeout(1500);
    const h1 = await p.locator('h1').first().textContent();
    const ok = res?.status() === 404 && /isn’t here/.test(h1 ?? '') && /not found/i.test(await p.title());
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${path} (${theme}): ${res?.status()} "${h1}" title "${await p.title()}"`);
    await p.screenshot({ path: `${out}/${name}-${theme}.png` });
  }
await browser.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
