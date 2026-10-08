#!/usr/bin/env node
// Every screen and the main interactions in the other browsers: desktop Safari (WebKit) and Firefox, and
// phones (Safari on an iPhone, Chrome on Android). Records page errors, console errors and a screenshot of
// each step, and fails on any page error or a step that can't be done.
// Usage: node scripts/browser-matrix.mjs <local review build url> <outDir> [--only webkit-desktop,…]
import { mkdirSync } from 'node:fs';
import { chromium, devices, firefox, webkit } from 'playwright';
import { installTestWallet } from './test-wallet.mjs';

const args = process.argv.slice(2);
const oi = args.indexOf('--only');
const only = oi === -1 ? null : args.splice(oi, 2)[1].split(',');
const [base = 'http://localhost:3230', out = 'browser-matrix'] = args;
mkdirSync(out, { recursive: true });
const W = 'watch=0x7c81e5a50a1931a5fbe663a916d31e46f804fd1e&rules=example';
const SCREENS = ['/app', '/app/trade/GOLD', '/app/positions', '/app/rules', '/app/simulator', '/app/audit', '/app/settings', '/app/account', '/app/onboarding', '/app/notifications'];
const TARGETS = [
  { name: 'webkit-desktop', engine: webkit, ctx: { viewport: { width: 1440, height: 900 } } },
  { name: 'firefox-desktop', engine: firefox, ctx: { viewport: { width: 1440, height: 900 } } },
  { name: 'safari-iphone', engine: webkit, ctx: { ...devices['iPhone 13'] } },
  { name: 'chrome-android', engine: chromium, ctx: { ...devices['Pixel 7'] } },
].filter((t) => !only || only.includes(t.name));

let failed = 0;
for (const t of TARGETS) {
  const browser = await t.engine.launch();
  const phone = Boolean(t.ctx.isMobile);
  const log = (ok, what, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${t.name}: ${what}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed++;
  };
  const watch = async (ctx) => {
    const errors = [];
    ctx.on('page', (p) => {
      p.on('pageerror', (e) => errors.push(`pageerror: ${e.message.split('\n')[0]}`));
      p.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_|net::|429|status of 5\d\d|WebSocket|relay|walletconnect|Allowlist/i.test(m.text()) && errors.push(`console: ${m.text().slice(0, 160)}`));
    });
    return errors;
  };
  const step = async (p, name, fn) => {
    try {
      await fn();
      await p.screenshot({ path: `${out}/${t.name}-${name}.png` });
      log(true, name);
    } catch (e) {
      await p.screenshot({ path: `${out}/${t.name}-${name}-FAILED.png` }).catch(() => {});
      log(false, name, e.message.split('\n')[0].slice(0, 160));
    }
  };

  // Every screen, with an account's data (review build, watched account).
  {
    const ctx = await browser.newContext({ ...t.ctx });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('bw.tpsl', '1');
      } catch {
        /* about:blank has no storage */
      }
    });
    const errors = await watch(ctx);
    const p = await ctx.newPage();
    for (const path of SCREENS)
      await step(p, `screen${path.replace(/\//g, '_')}`, async () => {
        await p.goto(`${base}${path}?${W}`, { timeout: 120_000 });
        await p.waitForTimeout(4000);
        const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (over > 2) throw new Error(`page scrolls sideways by ${over}px`);
      });
    // Chart: zoom and pan.
    await step(p, 'chart-zoom-pan', async () => {
      await p.goto(`${base}/app/trade/GOLD?${W}`);
      const g = p.locator('.cchart g[data-t]').filter({ visible: true }).first();
      await g.waitFor({ timeout: 60_000 });
      const box = await p.locator('.cchart').filter({ visible: true }).first().boundingBox();
      const before = await p.locator('.cchart').filter({ visible: true }).first().locator('g[data-t]').count();
      if (!phone) {
        await p.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
        for (let i = 0; i < 4; i++) await p.mouse.wheel(0, -120);
        await p.waitForTimeout(300);
        const after = await p.locator('.cchart').filter({ visible: true }).first().locator('g[data-t]').count();
        if (!(after < before)) throw new Error(`wheel didn't zoom (${before} → ${after})`);
        await p.mouse.down();
        await p.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 8 });
        await p.mouse.up();
      } else {
        // Phones: a one-finger drag pans (pinch needs CDP touch, checked separately on Chrome).
        await p.locator('.cchart').filter({ visible: true }).first().dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: box.x + 100, clientY: box.y + 60, isPrimary: true, bubbles: true });
        for (let i = 1; i <= 6; i++) await p.locator('.cchart').filter({ visible: true }).first().dispatchEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: box.x + 100 + i * 20, clientY: box.y + 60, isPrimary: true, bubbles: true });
        await p.locator('.cchart').filter({ visible: true }).first().dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', bubbles: true });
        await p.waitForTimeout(300);
        if (!(await p.locator('.cchart-reset').count())) throw new Error('drag did not pan (no Reset view)');
      }
    });
    // The bell panel.
    await step(p, 'bell-panel', async () => {
      await p.goto(`${base}/app/positions?${W}`);
      const bell = p.locator('header button.bell').filter({ visible: true }).first();
      await bell.waitFor({ timeout: 60_000 });
      await p.waitForTimeout(1500);
      await bell.click();
      await p.locator('.pop .nlist li').first().waitFor({ timeout: 30_000 });
    });
    // TP/SL panel on a position (read-only: watched account).
    await step(p, 'tpsl-panel', async () => {
      await p.keyboard.press('Escape');
      const btn = p.getByRole('button', { name: /^(TP\/SL|TP |SL )/ }).filter({ visible: true }).first();
      await btn.waitFor({ timeout: 60_000 });
      await btn.click();
      await p.locator('.pop #tpsl-tp').waitFor({ timeout: 30_000 });
      await p.locator('.pop #tpsl-tp').fill('1');
      await p.locator('.pop #tpsl-slip').fill('1');
      await p.waitForTimeout(300);
      if (!(await p.locator('.pop .wt').count())) throw new Error('no check message for an impossible take profit');
    });
    // Settings: switch theme and time zone.
    await step(p, 'settings-switches', async () => {
      await p.keyboard.press('Escape');
      await p.goto(`${base}/app/settings?${W}`);
      await p.getByRole('radio', { name: 'Light' }).first().click({ timeout: 60_000 });
      await p.waitForTimeout(300);
      if (!(await p.evaluate(() => document.documentElement.className.includes('light')))) throw new Error('theme did not switch');
      await p.getByRole('radio', { name: 'Local' }).first().click();
      await p.getByRole('radio', { name: 'Dark' }).first().click();
    });
    log(errors.length === 0, 'no page or console errors', errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // The wallet window with a browser wallet (test wallet), then the wallet menu.
  {
    const ctx = await browser.newContext({ ...t.ctx });
    const errors = await watch(ctx);
    await installTestWallet(ctx);
    const p = await ctx.newPage();
    await step(p, 'wallet-window', async () => {
      await p.goto(`${base}/app`);
      await p.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first().click({ timeout: 60_000 });
      await p.locator('[data-testid^="rk-wallet-option-"]').first().waitFor({ timeout: 30_000 });
    });
    await step(p, 'wallet-connected-menu', async () => {
      // Phones list an in-app browser's wallet as "Browser wallet"; desktops list it by name (EIP-6963).
      await p.locator('[role="dialog"]').getByText(/^(Test Wallet|Browser wallet)$/).first().click();
      const wb = p.locator('header button.wallet').filter({ visible: true }).first();
      await wb.waitFor({ timeout: 30_000 });
      await wb.click();
      await p.locator('.pop .wm').waitFor({ timeout: 15_000 });
    });
    log(errors.length === 0, 'no page or console errors (wallet)', errors.slice(0, 3).join(' | '));
    await ctx.close();
  }
  await browser.close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
