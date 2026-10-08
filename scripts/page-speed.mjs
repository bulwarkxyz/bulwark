#!/usr/bin/env node
// A page's load on a mid-range phone (4x CPU slowdown, ~9 Mbit/s 4G, 85 ms): first and largest contentful
// paint, load event, layout shift, and bytes of JavaScript. Median of three cold loads.
// Usage: node scripts/page-speed.mjs <url> [<url>…]
import { chromium, devices } from 'playwright';

const urls = process.argv.slice(2);
const browser = await chromium.launch();
for (const url of urls) {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    const p = await ctx.newPage();
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 85, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 });
    let js = 0;
    const scripts = new Set();
    cdp.on('Network.responseReceived', (e) => e.type === 'Script' && scripts.add(e.requestId));
    cdp.on('Network.loadingFinished', (e) => scripts.has(e.requestId) && (js += e.encodedDataLength));
    await p.addInitScript(() => {
      window.__lcp = 0;
      window.__cls = 0;
      new PerformanceObserver((l) => l.getEntries().forEach((e) => (window.__lcp = e.startTime))).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((l) => l.getEntries().forEach((e) => !e.hadRecentInput && (window.__cls += e.value))).observe({ type: 'layout-shift', buffered: true });
    });
    await p.goto(url, { waitUntil: 'load', timeout: 120_000 });
    await p.waitForTimeout(3000);
    const m = await p.evaluate(() => ({
      fcp: Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0),
      lcp: Math.round(window.__lcp),
      load: Math.round(performance.getEntriesByType('navigation')[0].loadEventEnd),
      cls: +window.__cls.toFixed(3),
    }));
    runs.push({ ...m, jsKB: Math.round(js / 1024) });
    await ctx.close();
  }
  const med = (k) => runs.map((r) => r[k]).sort((a, b) => a - b)[1];
  console.log(`${url}  FCP ${med('fcp')} ms · LCP ${med('lcp')} ms · load ${med('load')} ms · CLS ${med('cls')} · JS ${med('jsKB')} KB`);
}
await browser.close();
