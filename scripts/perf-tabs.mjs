#!/usr/bin/env node
// Tab-switch timings, as a visitor clicks through the app: for each tab, the time from the click to the new
// screen's frame (its own heading or grid on screen) and to its data (no loading placeholder left), on the
// first visit and on a repeat; and whether the click was a client-side navigation or a full page load.
// Profiles: "laptop" (no throttling) and "phone" (390 wide, 4x CPU slowdown, 4G-class network).
// Usage: node scripts/perf-tabs.mjs <baseUrl> [--profile laptop|phone] [--json out.json] [--trace out.zip]
//        [--budget-frame ms] [--budget-data ms] [--query 'watch=0x…'] [--limit ms] [--first url]
// Budgets: every tab switch (first and repeat visit) must show its frame within --budget-frame, and every
// repeat visit must show its data within --budget-data; otherwise the script exits 1 (the CI check).
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args.splice(i, 2)[1];
};
const profile = opt('--profile', 'laptop');
const jsonOut = opt('--json');
const traceOut = opt('--trace');
const limit = Number(opt('--limit', '60000')); // give up on a tab after this long
const first = opt('--first'); // a URL to open before timing, e.g. a protected preview's share link (sets its cookie)
const query = opt('--query', ''); // e.g. watch=0x… on a review build: the screens with an account's data
const budgetFrame = Number(opt('--budget-frame', '0'));
const budgetData = Number(opt('--budget-data', '0'));
const base = args[0] ?? 'https://bulwark.0xo.in';
const phone = profile === 'phone';

// What "the frame" and "the data" mean for each screen (selectors from the app's own markup).
const TABS = [
  { name: 'Markets', path: /\/app\/?(\?.*)?$/, frame: 'h1:has-text("Markets"), .ptl:has-text("Markets")' },
  { name: 'Trade', path: /\/app\/trade\/[A-Z0-9]+/, frame: '.tgrid' },
  { name: 'Positions', path: /\/app\/positions/, frame: 'h1:has-text("Positions"), .ptl:has-text("Positions")' },
  { name: phone ? 'Guard' : 'Guard rules', path: /\/app\/rules/, frame: 'h1:has-text("Guard rules"), .ptl:has-text("Guard rules")' },
  ...(phone ? [] : [{ name: 'Simulator', path: /\/app\/simulator/, frame: 'h1:has-text("Simulator")' }, { name: 'Audit log', path: /\/app\/audit/, frame: 'h1:has-text("Audit log")' }]),
  { name: phone ? 'More' : 'Settings', path: /\/app\/settings/, frame: phone ? '.ptl:has-text("More")' : 'h1:has-text("Settings")' },
];

const browser = await chromium.launch();
const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
if (phone) {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.enable');
  // Roughly a good 4G connection: 9 Mbit/s down, 1.5 up, 85 ms round trip.
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 85, downloadThroughput: (9e6 / 8), uploadThroughput: (1.5e6 / 8) });
}
if (traceOut) await ctx.tracing.start({ screenshots: true, snapshots: true });

// Count the documents loaded, to tell client navigation from a full page load.
let documents = 0;
page.on('request', (r) => {
  if (r.resourceType() === 'document') documents++;
});
const requests = [];
page.on('requestfinished', (r) => requests.push(r.url()));

if (first) await page.goto(first, { waitUntil: 'load', timeout: 120_000 });
const results = [];
const t0 = Date.now();
await page.goto(`${base}/app${query ? `?${query}` : ''}`, { waitUntil: 'commit', timeout: 120_000 });
await page.locator(TABS[0].frame).filter({ visible: true }).first().waitFor({ timeout: 120_000 });
const coldFrame = Date.now() - t0;
await page.waitForFunction(() => !document.querySelector('main .sk, main .skb'), null, { timeout: 120_000 }).catch(() => {});
results.push({ tab: 'Markets (cold load of /app)', round: 0, frameMs: coldFrame, dataMs: Date.now() - t0, fullLoad: true });

const link = (name) => (phone ? page.locator('nav.mtabbar').getByText(name, { exact: true }) : name === 'Settings' ? page.locator('header a[aria-label="Settings"]') : page.locator('header nav').getByText(name, { exact: true })).filter({ visible: true });

for (const round of [1, 2]) {
  const order = [...TABS.slice(1), TABS[0]]; // start from Markets: Trade first
  for (const tab of order) {
    await page.evaluate(() => {
      window.__bwMark = Math.random();
    });
    const mark = await page.evaluate(() => window.__bwMark);
    const docsBefore = documents;
    const reqBefore = requests.length;
    const start = Date.now();
    try {
      await link(tab.name).first().click({ timeout: 60_000, noWaitAfter: true });
      await page.waitForURL(tab.path, { timeout: limit });
      await page.locator(tab.frame).filter({ visible: true }).first().waitFor({ timeout: limit });
    } catch {
      // Not on screen within the limit: record it as over and carry on from the next tab.
      results.push({ tab: tab.name, round, frameMs: null, dataMs: null, fullLoad: null, requests: requests.length - reqBefore });
      continue;
    }
    const frameMs = Date.now() - start;
    // Data: no loading placeholder in the page, and stays that way for 300 ms.
    await page
      .waitForFunction(
        () => {
          const busy = document.querySelector('main .sk, main .skb, [aria-busy="true"]');
          const w = window;
          if (busy) {
            w.__bwQuiet = 0;
            return false;
          }
          w.__bwQuiet = w.__bwQuiet || performance.now();
          return performance.now() - w.__bwQuiet > 300;
        },
        null,
        { timeout: 60_000, polling: 50 },
      )
      .catch(() => {});
    const dataMs = Date.now() - start - 300;
    const same = await page.evaluate((m) => window.__bwMark === m, mark).catch(() => false);
    results.push({ tab: tab.name, round, frameMs, dataMs: Math.max(frameMs, dataMs), fullLoad: !same || documents > docsBefore, requests: requests.length - reqBefore });
    await page.waitForTimeout(800);
  }
}
if (traceOut) await ctx.tracing.stop({ path: traceOut });
await browser.close();

const pad = (s, n) => String(s).padEnd(n);
console.log(`${profile} · ${base}${query ? ` · ?${query}` : ''}`);
console.log(`${pad('tab', 30)}${pad('visit', 8)}${pad('frame ms', 10)}${pad('data ms', 10)}${pad('full load', 11)}requests`);
const overLimit = `>${limit / 1000}s`;
for (const r of results) console.log(`${pad(r.tab, 30)}${pad(r.round === 0 ? 'cold' : r.round === 1 ? 'first' : 'repeat', 8)}${pad(r.frameMs ?? overLimit, 10)}${pad(r.dataMs ?? overLimit, 10)}${pad(r.fullLoad === null ? '?' : r.fullLoad ? 'yes' : 'no', 11)}${r.requests ?? ''}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ profile, base, at: new Date().toISOString(), results }, null, 1));
const over = results.filter((r) => r.round > 0 && (r.frameMs === null || (budgetFrame && r.frameMs > budgetFrame) || (budgetData && r.round === 2 && r.dataMs > budgetData)));
if (over.length) {
  console.log(`OVER BUDGET (frame ${budgetFrame} ms, repeat data ${budgetData} ms): ${over.map((r) => `${r.tab} (${r.round === 1 ? 'first' : 'repeat'})`).join(', ')}`);
  process.exit(1);
}
