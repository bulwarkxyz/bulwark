#!/usr/bin/env node
// Every wallet in the connect modal, clicked one by one on a fresh page, at 1440 and 390: the app must not
// throw (no pageerror) and must still be on screen afterwards. Catches crashes like the WalletConnect QR one
// (qr refusing border 0, fixed by the cuer>qr override). Wallets that aren't installed show their own
// "get" or QR screen; that's fine, as long as nothing throws.
// Usage: node scripts/wallet-modal-check.mjs <baseUrl> [--no-test-wallet] [--first <url>]
//   Locally, build with NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID set (any 32 hex characters) to list the
//   WalletConnect wallets. A placeholder ID gets no pairing link from the relay, so the QR is never drawn
//   there: to cover the QR itself, run it against the live site (its project ID is allow-listed). It only
//   opens the modal and clicks each wallet: nothing is signed and nobody signs in. The local test wallet is
//   announced on localhost only.
import { chromium } from 'playwright';
import { installTestWallet } from './test-wallet.mjs';

const args = process.argv.slice(2);
const bare = args.includes('--no-test-wallet');
// --first <url>: opened in each new browser before the check, e.g. a protected preview's share link (sets its cookie).
const fi = args.indexOf('--first');
const first = fi === -1 ? null : args.splice(fi, 2)[1];
const base = args.find((a) => !a.startsWith('--')) ?? 'http://localhost:3230';
// The local test wallet is announced on localhost only, and never with --no-test-wallet: production visitors
// usually have no wallet at all, and the bar must see what they see too.
const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base) && !bare;
let failed = 0;
const browser = await chromium.launch();
// Opens the app and waits for "Connect wallet". When either times out (8 Oct 2026: /app once took 85 s, once over 30 s,
// and once the button was not shown for 30 s), it names the requests still open and the slowest finished ones first.
async function go(page, url) {
  const open = new Map();
  const done = [];
  const start = (r) => open.set(r, Date.now());
  const end = (r) => {
    if (open.has(r)) done.push([Date.now() - open.get(r), r]);
    open.delete(r);
  };
  page.on('request', start);
  page.on('requestfinished', end);
  page.on('requestfailed', end);
  try {
    await page.goto(url);
    await page.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
  } catch (e) {
    console.log(`slow: ${url} (${String(e.message).split('\n')[0]})`);
    for (const [r, t] of open) console.log(`  open ${Date.now() - t} ms  ${r.resourceType()}  ${r.url().slice(0, 160)}`);
    for (const [ms, r] of done.sort((a, b) => b[0] - a[0]).slice(0, 8)) console.log(`  took ${ms} ms  ${r.resourceType()}  ${r.url().slice(0, 160)}`);
    throw e;
  } finally {
    page.off('request', start);
    page.off('requestfinished', end);
    page.off('requestfailed', end);
  }
}
for (const w of [1440, 390]) {
  const phone = w < 500;
  const opts = { viewport: { width: w, height: phone ? 844 : 900 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) };
  // The wallets the modal lists.
  const probe = await browser.newContext(opts);
  if (local) await installTestWallet(probe);
  let p = await probe.newPage();
  if (first) await p.goto(first, { timeout: 120_000 });
  await go(p, `${base}/app`);
  await p.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first().click();
  await p.locator('[data-testid^="rk-wallet-option-"]').first().waitFor({ timeout: 60_000 });
  const ids = await p.locator('[data-testid^="rk-wallet-option-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  await probe.close();
  for (const id of ids) {
    const ctx = await browser.newContext(opts);
    if (local) await installTestWallet(ctx);
    p = await ctx.newPage();
    if (first) await p.goto(first, { timeout: 120_000 });
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
    await go(p, `${base}/app`);
    await p.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first().click();
    await p.locator(`[data-testid="${id}"]`).click();
    await p.waitForTimeout(4000);
    // WalletConnect's QR: drawn once the relay hands back a pairing link.
    const qr = await p.locator('[role="dialog"]').getByText('Scan with your phone').count();
    // The app crashed if Next's error page replaced it or the header is gone.
    const alive = (await p.locator('header').count()) > 0 && !(await p.getByText(/This page couldn.t load|Application error/).count());
    // WalletConnect's relay refusing the connection (a placeholder project ID, an origin not on the allowlist,
    // no network) is the wallet's own error state, not a crash: noted, not failed.
    const network = /Connection interrupted|WebSocket|relay|Unauthorized|not found on Allowlist|Failed to fetch|socket/i;
    const real = errors.filter((e) => !network.test(e));
    const ok = !real.length && alive;
    const noted = errors.filter((e) => network.test(e));
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${w}px ${id.replace('rk-wallet-option-', '')}${real.length ? `: ${real.join(' | ')}` : ''}${alive ? '' : ' (the app is gone)'}${noted.length ? ` (relay: ${noted[0]})` : ''}${qr ? ' (QR drawn)' : ''}`);
    if (!ok) failed++;
    await ctx.close();
  }
}
await browser.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
