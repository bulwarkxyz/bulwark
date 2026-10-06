#!/usr/bin/env node
// The chart's gestures, checked in a real browser:
//   laptop: wheel zooms at the cursor (the candle under it stays put) without scrolling the page; wheel up
//           zooms in; a drag pans to the past; panning back loads older candles; double-click resets.
//   phone:  pinch zooms and a one-finger drag pans on the chart; a vertical swipe that starts outside the
//           chart still scrolls the page; one that starts on the chart doesn't.
// Usage: node scripts/chart-zoom-check.mjs <baseUrl> [--shots dir]
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const si = args.indexOf('--shots');
const shots = si === -1 ? null : args.splice(si, 2)[1];
const base = args[0] ?? 'http://localhost:3230';
const path = args[1] ?? '/app/trade/GOLD';
if (shots) mkdirSync(shots, { recursive: true });
let failed = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};
const state = (page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('.cchart')].find((e) => e.getBoundingClientRect().width > 0);
    const r = el.getBoundingClientRect();
    const gs = [...el.querySelectorAll('g[data-t]')].map((g) => ({ t: Number(g.dataset.t), x: Number(g.dataset.x) }));
    return { left: r.left, top: r.top, width: r.width, height: r.height, loaded: Number(el.dataset.candles), shown: gs, scrollY: window.scrollY, reset: Boolean(el.querySelector('.cchart-reset')) };
  });
const under = (s, x) => s.shown.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a)).t;
const shot = async (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png` });

const browser = await chromium.launch();
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}${path}`);
  await page.locator('.cchart g[data-t]').first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  const s0 = await state(page);
  await shot(page, 'laptop-0-default');
  const cx = s0.left + (s0.width - 64) * 0.3;
  const cy = s0.top + s0.height / 2;
  await page.mouse.move(cx, cy);
  const t0 = under(s0, cx - s0.left);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(300);
  const s1 = await state(page);
  check(s1.shown.length < s0.shown.length, 'wheel up zooms in', `${s0.shown.length} → ${s1.shown.length} candles`);
  const t1 = under(s1, cx - s1.left);
  const candleMs = s0.shown[1].t - s0.shown[0].t;
  check(Math.abs(t1 - t0) <= candleMs, 'the candle under the cursor stays under it', `${new Date(t0).toISOString()} → ${new Date(t1).toISOString()}`);
  check(s1.scrollY === s0.scrollY, 'the page does not scroll while zooming');
  await shot(page, 'laptop-1-zoomed-in');
  const newest1 = Math.max(...s1.shown.map((c) => c.t));
  await page.mouse.down();
  await page.mouse.move(cx + 300, cy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const s2 = await state(page);
  check(Math.max(...s2.shown.map((c) => c.t)) < newest1, 'dragging right pans to the past');
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 240);
  await page.waitForTimeout(200);
  const s3 = await state(page);
  check(s3.shown.length > s0.shown.length, 'wheel down zooms out', `${s3.shown.length} candles`);
  await shot(page, 'laptop-2-zoomed-out');
  await page.mouse.down();
  await page.mouse.move(cx + 1200, cy, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction((n) => Number(document.querySelector('.cchart').dataset.candles) > n, s0.loaded, { timeout: 15_000 }).catch(() => {});
  const s4 = await state(page);
  check(s4.loaded > s0.loaded, 'panning back loads older candles', `${s0.loaded} → ${s4.loaded}`);
  check(s4.reset, 'a Reset view button shows once moved');
  await shot(page, 'laptop-3-older');
  await page.mouse.dblclick(cx, cy);
  await page.waitForTimeout(200);
  const s5 = await state(page);
  check(s5.shown.length === s0.shown.length && !s5.reset, 'double-click resets', `${s5.shown.length} candles`);
  await page.close();
}
{
  // A short phone (390 × 600), so the Trade screen is taller than the screen and the page can scroll.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 600 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`${base}${path}`);
  await page.locator('.cchart g[data-t]').first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  const touch = async (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  // Scroll to the bottom, so the chart is clear of the sticky trade bar and the page can scroll back up.
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
  await page.waitForTimeout(300);
  const s0 = await state(page);
  const cx = s0.left + (s0.width - 64) / 2;
  const cy = s0.top + s0.height / 2;
  // Pinch out (fingers apart) zooms in.
  await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx - 30 - i * 12, cy], [cx + 30 + i * 12, cy]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(200);
  const s1 = await state(page);
  check(s1.shown.length < s0.shown.length, 'phone: pinch out zooms in', `${s0.shown.length} → ${s1.shown.length}`);
  await shot(page, 'phone-1-pinched');
  const newest = Math.max(...s1.shown.map((c) => c.t));
  await touch('touchStart', [[cx - 80, cy]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx - 80 + i * 20, cy]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(200);
  const s2 = await state(page);
  check(Math.max(...s2.shown.map((c) => c.t)) < newest, 'phone: one-finger drag pans');
  check(s2.scrollY === s0.scrollY, 'phone: a touch on the chart does not scroll the page');
  // A swipe down on the chart doesn't move the page; the same swipe above the chart scrolls it back up.
  const s4 = await state(page);
  await cdp.send('Input.synthesizeScrollGesture', { x: cx, y: s4.top + 40, yDistance: 150, gestureSourceType: 'touch', speed: 1200 });
  await page.waitForTimeout(300);
  check((await state(page)).scrollY === s4.scrollY, 'phone: a swipe that starts on the chart does not scroll the page');
  await cdp.send('Input.synthesizeScrollGesture', { x: 195, y: Math.max(10, s4.top - 60), yDistance: 150, gestureSourceType: 'touch', speed: 1200 });
  await page.waitForTimeout(300);
  const s3 = await state(page);
  check(s3.scrollY < s4.scrollY, 'phone: a swipe that starts outside the chart scrolls the page', `scrollY ${s4.scrollY} → ${s3.scrollY}`);
  await ctx.close();
}
await browser.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
