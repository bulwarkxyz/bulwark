#!/usr/bin/env node
// Accessibility: axe-core on every screen (WCAG 2.1 A and AA rules), and a keyboard walk that tabs through
// each screen and reports focusable controls with no accessible name or no visible focus.
// axe is loaded into the page from cdnjs at run time (nothing added to the repo).
// Usage: node scripts/a11y-scan.mjs <local review build url> [outJson]
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [base = 'http://localhost:3230', out] = process.argv.slice(2);
const W = 'watch=0x7c81e5a50a1931a5fbe663a916d31e46f804fd1e&rules=example';
const SCREENS = ['/app', '/app/trade/GOLD', '/app/positions', '/app/rules', '/app/simulator', '/app/audit', '/app/settings', '/app/account', '/app/onboarding', '/app/notifications'];
const AXE = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js';
const browser = await chromium.launch();
const report = [];
for (const theme of ['dark', 'light'])
  for (const path of SCREENS) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
    await ctx.addInitScript((t) => localStorage.setItem('theme', t), theme);
    const p = await ctx.newPage();
    await p.goto(`${base}${path}?${W}`, { timeout: 120_000 });
    await p.waitForTimeout(4000);
    await p.addScriptTag({ url: AXE });
    const res = await p.evaluate(async () => {
      // @ts-ignore
      const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ')), count: v.nodes.length }));
    });
    // Keyboard walk: Tab through up to 120 stops.
    const stops = [];
    await p.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
    for (let i = 0; i < 120; i++) {
      await p.keyboard.press('Tab');
      const s = await p.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const labelled = el.getAttribute('aria-labelledby') ? el.getAttribute('aria-labelledby').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : '';
        const name = (el.getAttribute('aria-label') || labelled || [...(el.labels ?? [])].map((l) => l.textContent).join(' ') || el.textContent || el.getAttribute('title') || '').trim().slice(0, 40);
        const ring = cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px' ? 'outline' : cs.boxShadow !== 'none' ? 'shadow' : el.matches('input,textarea') && cs.borderColor ? 'border' : 'none';
        const r = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(), name, ring, visible: r.width > 0 && r.height > 0, key: `${el.tagName}|${name}|${Math.round(r.x)}|${Math.round(r.y)}` };
      });
      if (!s) continue;
      if (stops.length && stops[0].key === s.key) break; // wrapped around
      stops.push(s);
    }
    const unnamed = stops.filter((s) => !s.name);
    const noRing = stops.filter((s) => s.ring === 'none' && s.visible);
    const hidden = stops.filter((s) => !s.visible);
    report.push({ theme, path, axe: res, stops: stops.length, unnamed: unnamed.map((s) => `${s.tag}@${s.key}`), noRing: noRing.map((s) => `${s.tag}:${s.name}`), hiddenStops: hidden.map((s) => `${s.tag}:${s.name}`) });
    console.log(`${theme} ${path}: axe ${res.length ? res.map((v) => `${v.id}(${v.count})`).join(' ') : 'clean'} · tab stops ${stops.length}, unnamed ${unnamed.length}, no visible focus ${noRing.length}, focus on hidden ${hidden.length}`);
    await ctx.close();
  }
// 200% zoom: 1440 px at 200% is a 720 px layout. Nothing may need sideways scrolling.
{
  const ctx = await browser.newContext({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  for (const path of SCREENS) {
    await p.goto(`${base}${path}?${W}`, { timeout: 120_000 });
    await p.waitForTimeout(3000);
    const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    console.log(`zoom 200% ${path}: ${over > 2 ? `scrolls sideways by ${over}px` : 'fits'}`);
    report.push({ zoom200: path, over });
  }
  await ctx.close();
}
// Keyboard flows: open the bell and the wallet menu with Enter, focus lands inside, Escape closes and
// returns focus to the button.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${base}/app/positions?${W}`);
  await p.locator('header button.bell').waitFor({ timeout: 60_000 });
  await p.waitForTimeout(2000);
  for (const [name, sel] of [['bell', 'header button.bell'], ['wallet menu', 'header button.wallet']]) {
    await p.locator(sel).focus();
    await p.keyboard.press('Enter');
    await p.waitForTimeout(400);
    const inside = await p.evaluate(() => Boolean(document.activeElement?.closest('.pop')));
    await p.keyboard.press('Tab');
    const tabInside = await p.evaluate(() => Boolean(document.activeElement?.closest('.pop')));
    await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
    const closed = (await p.locator('.pop').count()) === 0;
    const back = await p.evaluate((s) => document.activeElement === document.querySelector(s), sel);
    console.log(`keyboard ${name}: opens with Enter ${inside ? 'ok' : 'NO'}, Tab stays inside ${tabInside ? 'ok' : 'NO'}, Escape closes ${closed ? 'ok' : 'NO'}, focus returns ${back ? 'ok' : 'NO'}`);
    report.push({ keyboard: name, inside, tabInside, closed, back });
  }
  await ctx.close();
}
await browser.close();
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
