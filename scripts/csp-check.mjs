#!/usr/bin/env node
// The Content Security Policy against real use: every screen, then every wallet in the connect modal
// (WalletConnect included), then (localhost only) connecting the test wallet and opening its menu. Lists
// every request or script the policy blocks or, in report-only mode, would block, and fails if there is
// any: a policy that would block the app can't be switched to enforce.
// Usage: node scripts/csp-check.mjs <baseUrl> [--watch 0x…]
//   --watch: a review build's watched account, so the screens load real account data.
import { chromium } from 'playwright';
import { installTestWallet } from './test-wallet.mjs';

const args = process.argv.slice(2);
const wi = args.indexOf('--watch');
const watch = wi === -1 ? null : args.splice(wi, 2)[1];
const base = args[0] ?? 'http://localhost:3230';
const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base);
const SCREENS = ['/app', '/app/trade/GOLD', '/app/positions', '/app/rules', '/app/simulator', '/app/audit', '/app/settings', '/app/account', '/app/onboarding', '/app/notifications', '/app/no-such-screen'];
const q = watch ? `?watch=${watch}&rules=example` : '';

const seen = new Map();
const browser = await chromium.launch();
async function context(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  await ctx.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      // Origin only: no paths or query strings in the output.
      let b = e.blockedURI;
      try {
        b = new URL(b).origin;
      } catch {}
      window.__csp = window.__csp ?? [];
      window.__csp.push(`${e.effectiveDirective} ${b}${e.disposition === 'report' ? '' : ' (enforced)'}`);
    });
  });
  return ctx;
}
async function collect(p, where) {
  const v = await p.evaluate(() => window.__csp ?? []).catch(() => []);
  for (const x of v) seen.set(x, [...(seen.get(x) ?? []), where]);
}

const header = await fetch(`${base}/app`).then((r) => r.headers.get('content-security-policy-report-only') ? 'report-only' : r.headers.get('content-security-policy') ? 'enforced' : 'none');
console.log(`policy: ${header}`);
if (header === 'none') {
  console.log('FAIL no Content-Security-Policy header');
  process.exit(1);
}

// Screens.
{
  const ctx = await context();
  const p = await ctx.newPage();
  for (const s of SCREENS) {
    await p.goto(`${base}${s}${q}`, { timeout: 120_000 });
    await p.waitForTimeout(5000);
    await collect(p, s);
  }
  await ctx.close();
}
// Every wallet in the modal, at desktop and phone width.
for (const phone of [false, true]) {
  const opts = phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {};
  const probe = await context(opts);
  let p = await probe.newPage();
  await p.goto(`${base}/app`);
  await p.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first().click({ timeout: 60_000 });
  await p.locator('[data-testid^="rk-wallet-option-"]').first().waitFor({ timeout: 60_000 });
  const ids = await p.locator('[data-testid^="rk-wallet-option-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  await collect(p, `${phone ? 'phone' : 'desktop'} wallet window`);
  await probe.close();
  for (const id of ids) {
    const ctx = await context(opts);
    p = await ctx.newPage();
    await p.goto(`${base}/app`);
    await p.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first().click({ timeout: 60_000 });
    await p.locator(`[data-testid="${id}"]`).click();
    await p.waitForTimeout(6000);
    const qr = await p.locator('[role="dialog"]').getByText('Scan with your phone').count();
    await collect(p, `${phone ? 'phone' : 'desktop'} ${id.replace('rk-wallet-option-', '')}${qr ? ' (QR drawn)' : ''}`);
    console.log(`checked ${phone ? 'phone' : 'desktop'} ${id.replace('rk-wallet-option-', '')}${qr ? ' (QR drawn)' : ''}`);
    await ctx.close();
  }
}
// Connecting a wallet and its menu (the local test wallet: localhost only).
if (local) {
  const ctx = await context();
  await installTestWallet(ctx);
  const p = await ctx.newPage();
  await p.goto(`${base}/app/positions`);
  await p.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first().click({ timeout: 60_000 });
  await p.locator('[role="dialog"]').getByText(/^(Test Wallet|Browser wallet)$/).first().click({ timeout: 30_000 });
  const wb = p.locator('header button.wallet').filter({ visible: true }).first();
  await wb.waitFor({ timeout: 30_000 });
  await wb.click();
  await p.waitForTimeout(3000);
  await collect(p, 'connected wallet');
  await ctx.close();
}
await browser.close();
for (const [v, where] of seen) console.log(`FAIL ${v} · on ${[...new Set(where)].slice(0, 4).join(', ')}`);
console.log(seen.size ? `${seen.size} blocked` : 'nothing blocked');
process.exit(seen.size ? 1 : 0);
