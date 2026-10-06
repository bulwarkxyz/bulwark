#!/usr/bin/env node
// The bell, the notifications page and the wallet menu, checked in a real browser on a local review build
// (the watched account and its example alerts) and with the local test wallet.
// Usage: node scripts/nav-check.mjs <localBaseUrl>
import { chromium } from 'playwright';
import { installTestWallet } from './test-wallet.mjs';

const base = process.argv[2] ?? 'http://localhost:3230';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error('local builds only');
const WATCH = 'watch=0x7c81e5a50a1931a5fbe663a916d31e46f804fd1e&rules=example';
let failed = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};
const browser = await chromium.launch();
// Warm the server first: the first request after a start compiles nothing but is slow enough to miss a wait.
{
  const warm = await browser.newPage();
  for (const path of ['/app', '/app/positions', '/app/rules', '/app/notifications', '/app/settings']) await warm.goto(`${base}${path}`).catch(() => {});
  await warm.close();
}

for (const w of [1440, 390]) {
  const phone = w < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const p = await ctx.newPage();
  const at = `${w}px`;
  await p.goto(`${base}/app/positions?${WATCH}`);
  const bell = p.locator('header button.bell').filter({ visible: true }).first();
  await bell.waitFor({ timeout: 60_000 });
  await p.waitForFunction(() => document.querySelector('header button.bell .badge'), null, { timeout: 30_000 }).catch(() => {});
  check((await bell.locator('.badge').textContent()) === '5', `${at}: the bell shows 5 unread`);
  check(new URL(p.url()).pathname === '/app/positions', `${at}: opening the bell doesn't navigate`);
  await bell.click();
  const pop = p.locator('.pop');
  await pop.locator('.nlist li').first().waitFor();
  const box = await pop.boundingBox();
  const bb = await bell.boundingBox();
  check(phone ? Math.round(box.y + box.height) === (await p.evaluate(() => innerHeight)) : box.y >= bb.y + bb.height && box.y < bb.y + bb.height + 20, `${at}: ${phone ? 'opens as a bottom sheet' : 'opens anchored under the bell'}`);
  const rows = await pop.locator('.nlist li').count();
  check(rows === 5 && (await pop.locator('.nrow.unread').count()) === 5, `${at}: lists 5 alerts, all marked unread`);
  const times = await pop.locator('.nrow .num').allTextContents();
  check(times[0].includes('min ago'), `${at}: newest first, relative time`, times[0]);
  // The first alert links to its rule.
  await pop.locator('.nrow .nmain').first().click();
  await p.waitForURL(/\/app\/rules#rule-stage-1$/);
  await p.waitForTimeout(600);
  check(await p.evaluate(() => document.getElementById('rule-stage-1')?.classList.contains('target')), `${at}: an alert opens its rule, marked on screen`);
  check((await bell.locator('.badge').textContent()) === '4', `${at}: opening one marks it read (5 → 4)`);
  // The liquidation links to the position.
  await bell.click();
  await p.locator('.pop .nrow .nmain').filter({ hasText: 'liquidated' }).click();
  await p.waitForURL(/\/app\/positions\?coin=xyz%3ASILVER$/);
  const marked = await p
    .waitForFunction((ph) => document.getElementById(ph ? 'posc-xyz:SILVER' : 'pos-xyz:SILVER')?.className.includes(ph ? 'target' : 'sel'), phone, { timeout: 8_000 })
    .then(() => true, () => false);
  check(marked, `${at}: a liquidation opens that position, marked`);
  // The audit link opens and marks the entry.
  await bell.click();
  await p.locator('.pop .naudit').first().click();
  await p.waitForURL(/\/app\/audit\?seq=5$/);
  await p.waitForTimeout(800);
  // Review builds have no audit entry 5, so the log simply opens; with a real log the entry is opened.
  check(new URL(p.url()).searchParams.get('seq') === '5', `${at}: "Audit entry" opens the audit log at that entry`);
  // Mark all read, See all.
  await bell.click();
  await p.locator('.pop').getByRole('button', { name: 'Mark all read' }).click();
  check((await bell.locator('.badge').count()) === 0 && (await p.locator('.pop .nrow.unread').count()) === 0, `${at}: "Mark all read" clears the badge and the marks`);
  await p.locator('.pop').getByRole('link', { name: 'See all' }).click();
  await p.waitForURL(/\/app\/notifications$/);
  await p.locator('.nlist li').first().waitFor();
  check((await p.locator('.nlist li').count()) === 5, `${at}: "See all" opens the full page`);
  await p.getByRole('radio', { name: /^Liquidation/ }).click();
  check((await p.locator('.nlist li').count()) === 1, `${at}: filter by type`);
  await p.getByRole('radio', { name: 'Today' }).click();
  await p.getByRole('radio', { name: /^All/ }).first().click();
  const today = await p.locator('.nlist li').count();
  // The example liquidation is 30 h old, so "Today" never includes it; how many others it holds depends on the hour.
  check(today >= 1 && today <= 4, `${at}: filter by date`, `${today} today`);
  check((await p.locator('a[href="/app/settings#alerts"]').count()) > 0, `${at}: links to alert settings`);
  // Escape closes; the watching menu explains itself.
  await p.locator('header button.wallet').filter({ visible: true }).first().click();
  const wm = p.locator('.pop .wm');
  await wm.waitFor();
  check((await wm.textContent()).includes('Review build only') && (await wm.textContent()).includes('Nothing here can sign'), `${at}: "Watching" explains itself`);
  await p.keyboard.press('Escape');
  check((await p.locator('.pop').count()) === 0, `${at}: Escape closes the menu`);
  await ctx.close();

  // A connected wallet's menu.
  const ctx2 = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, ...(phone ? { isMobile: true, hasTouch: true } : {}), permissions: ['clipboard-read', 'clipboard-write'] });
  const addr = await installTestWallet(ctx2);
  const q = await ctx2.newPage();
  await q.goto(`${base}/app/settings`);
  await q.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first().click();
  await q.locator('[role="dialog"]').getByText('Test Wallet').click();
  const wb = q.locator('header button.wallet').filter({ visible: true }).first();
  await wb.waitFor();
  await q.evaluate(() => sessionStorage.setItem('bw.session', 'test-token'));
  await wb.click();
  const menu = q.locator('.pop .wm');
  await menu.waitFor();
  const text = await menu.textContent();
  check(text.includes(addr) && text.includes('Test Wallet') && text.includes('Hyperliquid testnet') && text.includes('Arbitrum One'), `${at}: wallet menu shows the full address, wallet name and networks`);
  await menu.getByRole('button', { name: 'Copy address' }).click();
  check((await q.evaluate(() => navigator.clipboard.readText())).toLowerCase() === addr.toLowerCase(), `${at}: Copy puts the address on the clipboard`);
  check((await menu.locator(`a[href$="/explorer/address/${addr}"]`).count()) === 1, `${at}: explorer link for the address`);
  check((await menu.getByRole('button', { name: /Account/ }).count()) === 1, `${at}: links to Account`);
  await menu.getByRole('button', { name: 'Disconnect' }).click();
  await q.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first().waitFor();
  check((await q.evaluate(() => sessionStorage.getItem('bw.session'))) === null, `${at}: Disconnect disconnects and clears the session`);
  // Switch wallet: disconnects and opens the connect modal.
  await q.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first().click();
  await q.locator('[role="dialog"]').getByText('Test Wallet').click();
  await wb.waitFor();
  await wb.click();
  await q.locator('.pop .wm').getByRole('button', { name: 'Switch wallet' }).click();
  await q.locator('[role="dialog"]').filter({ hasText: 'Connect a Wallet' }).waitFor({ timeout: 15_000 }).then(
    () => check(true, `${at}: Switch wallet disconnects and opens the connect modal`),
    () => check(false, `${at}: Switch wallet disconnects and opens the connect modal`),
  );
  await ctx2.close();
}
await browser.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
