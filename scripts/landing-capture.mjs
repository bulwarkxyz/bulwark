#!/usr/bin/env node
// Landing captures: full-page stills at 1440 and 390 in both themes (after scrolling through, so every
// on-scroll reveal has played), and optional smooth full-scroll screen recordings (--video).
// Usage: node scripts/landing-capture.mjs <baseUrl> <outDir> [--video]
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [base = 'http://localhost:3218', out = 'landing-captures', flag] = process.argv.slice(2);
const video = flag === '--video';
mkdirSync(out, { recursive: true });
const sizes = [
  { name: '1440', width: 1440, height: 900, mobile: false },
  { name: '390', width: 390, height: 844, mobile: true },
];
const browser = await chromium.launch();

async function scrollThrough(page, { stepPx, pauseMs }) {
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < total; y += stepPx) {
    await page.evaluate((v) => window.scrollTo({ top: v, behavior: 'instant' }), y);
    await page.waitForTimeout(pauseMs);
  }
}

for (const theme of ['dark', 'light']) {
  for (const s of sizes) {
    const ctx = await browser.newContext({
      viewport: { width: s.width, height: s.height },
      deviceScaleFactor: video ? 1 : 2,
      isMobile: s.mobile,
      hasTouch: s.mobile,
      colorScheme: theme,
      ...(video ? { recordVideo: { dir: out, size: { width: s.width, height: s.height } } } : {}),
    });
    await ctx.addInitScript((t) => localStorage.setItem('theme', t), theme);
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'networkidle', timeout: 120_000 });
    if (video) {
      await page.waitForTimeout(3500); // hero entrance and the first guard cycle
      await scrollThrough(page, { stepPx: s.mobile ? 6 : 8, pauseMs: 16 }); // ~1 screen per 2 s
      await page.waitForTimeout(2500);
      const v = page.video();
      await ctx.close();
      if (v) renameSync(await v.path(), join(out, `landing-scroll-${s.name}-${theme}.webm`));
      console.log(`video ${s.name} ${theme}`);
      continue;
    }
    await scrollThrough(page, { stepPx: Math.round(s.height * 0.6), pauseMs: 250 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1200);
    const file = join(out, `landing-${s.name}-${theme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(file);
    await ctx.close();
  }
}
await browser.close();
