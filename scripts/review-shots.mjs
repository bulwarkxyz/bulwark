#!/usr/bin/env node
// Design-review screenshots against a review-mode build (NEXT_PUBLIC_REVIEW_MODE=1): every screen at
// desktop 1440 and phone 390, dark and light, in each state.
// Usage: node scripts/review-shots.mjs <baseUrl> <outDir> --routes /app/trade/CL,/app/positions
//        [--watch 0x…] [--states live,empty,loading,error,closed] [--full]
// "live" uses ?watch=&rules=example (a public account read-only with example rules, labelled on screen).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const has = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};
const watch = flag('--watch');
const routes = (flag('--routes') ?? '/app/trade/CL').split(',');
const states = (flag('--states') ?? 'live').split(',');
const full = has('--full');
const base = args[0] ?? 'http://localhost:3227';
const out = args[1] ?? 'review-shots';
const sizes = [
  { name: '1440', width: 1440, height: 900, mobile: false },
  { name: '390', width: 390, height: 844, mobile: true },
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const theme of ['dark', 'light']) {
  for (const size of sizes) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, isMobile: size.mobile, hasTouch: size.mobile, colorScheme: theme });
    await ctx.addInitScript((t) => localStorage.setItem('theme', t), theme);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    for (const route of routes) {
      for (const state of states) {
        const q = new URLSearchParams();
        if (watch && state !== 'empty') q.set('watch', watch);
        if (watch && state !== 'empty') q.set('rules', 'example');
        if (state !== 'live') q.set('state', state);
        await page.goto(`${base}${route}${route.includes('?') ? '&' : '?'}${q}`, { waitUntil: 'networkidle', timeout: 90_000 });
        await page.waitForTimeout(2500);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) errors.push(`horizontal overflow ${overflow}px`);
        const name = `${route.replace(/^\//, '').replaceAll('/', '_').replace('?', '_').replace('=', '')}-${state}-${size.name}-${theme}.png`;
        await page.screenshot({ path: join(out, name), fullPage: full || !route.includes('/trade/') });
        console.log(name, errors.length ? `errors: ${[...new Set(errors)].join(' | ').slice(0, 300)}` : '');
        errors.length = 0;
      }
    }
    await ctx.close();
  }
}
await browser.close();
