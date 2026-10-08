#!/usr/bin/env node
// Every screen the demo films, at 1920x1080 in both themes, on a local review build with a real testnet
// account: a settled screenshot, frames at 0.3 s and 1 s (loading flashes), the page's layout shift, and
// any text cut off by an ellipsis. Prints one line per screen.
// Usage: node scripts/camera-1080.mjs <local review build url> <outDir>
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const [base = 'http://localhost:3230', out = 'camera-1080'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const W = 'watch=0x7c81e5a50a1931a5fbe663a916d31e46f804fd1e&rules=example';
const SCREENS = ['/app', '/app/trade/GOLD', '/app/positions', '/app/rules', '/app/simulator', '/app/audit', '/app/settings', '/app/account', '/app/onboarding', '/app/notifications'];
const browser = await chromium.launch();
for (const theme of ['dark', 'light'])
  for (const path of SCREENS) {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem('theme', t);
      } catch {}
      window.__cls = 0;
      window.__shifts = [];
      new PerformanceObserver((l) =>
        l.getEntries().forEach((e) => {
          if (e.hadRecentInput) return;
          window.__cls += e.value;
          window.__shifts.push(...(e.sources ?? []).map((s) => (s.node?.className ?? s.node?.nodeName ?? '?').toString().slice(0, 50)));
        }),
      ).observe({ type: 'layout-shift', buffered: true });
    }, theme);
    const p = await ctx.newPage();
    const name = `${path.replace('/app', 'app').replace(/\//g, '_')}-${theme}`;
    const t0 = Date.now();
    await p.goto(`${base}${path}?${W}`, { waitUntil: 'commit', timeout: 120_000 });
    for (const at of [300, 1000]) {
      const wait = at - (Date.now() - t0);
      if (wait > 0) await p.waitForTimeout(wait);
      await p.screenshot({ path: `${out}/${name}-${at}ms.png` }).catch(() => {});
    }
    await p.waitForTimeout(6000);
    await p.screenshot({ path: `${out}/${name}.png` });
    const m = await p.evaluate(() => {
      const cut = [...document.querySelectorAll('main *, header *, .pg *')]
        .filter((el) => {
          const cs = getComputedStyle(el);
          return cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && el.getBoundingClientRect().width > 0;
        })
        .map((el) => (el.textContent ?? '').trim().slice(0, 40));
      return { cls: +window.__cls.toFixed(3), shifts: [...new Set(window.__shifts)].slice(0, 4), cut: cut.slice(0, 6) };
    });
    console.log(`${theme} ${path}: CLS ${m.cls}${m.shifts.length ? ` (${m.shifts.join(' | ')})` : ''}${m.cut.length ? ` · cut: ${m.cut.join(' | ')}` : ''}`);
    await ctx.close();
  }
await browser.close();
