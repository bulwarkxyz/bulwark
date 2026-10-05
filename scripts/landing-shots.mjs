#!/usr/bin/env node
// Landing page screenshots for design review: full page at desktop 1440 and phone 390, dark and light.
// Scrolls through the page first so scroll-revealed sections are drawn, then shoots the top and the full page.
// Usage: node scripts/landing-shots.mjs <baseUrl> <outDir> <prefix>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [base = 'http://localhost:3218', out = 'landing-shots', prefix = 'landing'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const theme of ['dark', 'light']) {
  for (const size of [{ name: '1440', width: 1440, height: 900, mobile: false }, { name: '390', width: 390, height: 844, mobile: true }]) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, isMobile: size.mobile, hasTouch: size.mobile, colorScheme: theme });
    await ctx.addInitScript((t) => localStorage.setItem('theme', t), theme);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base, { waitUntil: 'load', timeout: 90_000 });
    await page.waitForTimeout(2500);
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < h; y += Math.round(size.height * 0.6)) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(350);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(3000);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.screenshot({ path: join(out, `${prefix}-top-${size.name}-${theme}.png`) });
    await page.screenshot({ path: join(out, `${prefix}-full-${size.name}-${theme}.png`), fullPage: true });
    // Pinned (scroll-driven) sections draw nothing in a full-page shot: shoot them in the viewport, mid-scroll.
    for (const id of ['how-it-works']) {
      const top = await page.evaluate((i) => { const el = document.getElementById(i); return el ? el.getBoundingClientRect().top + window.scrollY : null; }, id);
      if (top === null) continue;
      await page.evaluate((y) => window.scrollTo(0, y), top + size.height * 0.9);
      await page.waitForTimeout(1800);
      await page.screenshot({ path: join(out, `${prefix}-${id}-${size.name}-${theme}.png`) });
    }
    console.log(prefix, size.name, theme, overflow > 0 ? `overflow ${overflow}px` : 'ok', errors.length ? errors.join(' | ').slice(0, 200) : '');
    await ctx.close();
  }
}
await browser.close();
