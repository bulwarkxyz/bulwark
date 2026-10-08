#!/usr/bin/env node
// A returning user: a wallet connected in this browser before reconnects after every page load. No screen
// may say "No wallet connected" (or show the setup's Connect step) while it does. Connects the local test
// wallet once, then loads each screen and records every text the page shows from first paint, plus a frame
// at 0.3 s. Production build on localhost only; the test wallet never signs in to a hosted API.
// Usage: node scripts/returning-wallet.mjs <local build url> <outDir>
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { installTestWallet } from './test-wallet.mjs';

const [base = 'http://localhost:3230', out = 'returning-wallet'] = process.argv.slice(2);
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error('localhost only');
mkdirSync(out, { recursive: true });
const SCREENS = ['/app/positions', '/app/account', '/app/simulator', '/app/audit', '/app/settings', '/app/notifications', '/app/rules', '/app/onboarding'];
// Setup's step 1 is right for a connected wallet that hasn't signed in; its Connect wallet button is not.
const WRONG = /No wallet connected|authorises nothing\.\s*Connect wallet|Connect a wallet and sign in/;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await installTestWallet(ctx);
await ctx.addInitScript(() => {
  window.__seen = [];
  const note = () => document.body && window.__seen.push(document.body.innerText.slice(0, 4000));
  new MutationObserver(note).observe(document, { childList: true, subtree: true, characterData: true });
  document.addEventListener('DOMContentLoaded', note);
});
const p = await ctx.newPage();
await p.goto(`${base}/app`);
await p.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first().click({ timeout: 60_000 });
await p.locator('[role="dialog"]').getByText(/^(Test Wallet|Browser wallet)$/).first().click({ timeout: 30_000 });
await p.locator('header button.wallet').filter({ visible: true }).first().waitFor({ timeout: 30_000 });

let failed = 0;
for (const path of SCREENS) {
  await p.goto(`${base}${path}`, { waitUntil: 'commit' });
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/${path.slice(5) || 'markets'}-300ms.png` });
  await p.locator('header button.wallet').filter({ visible: true }).first().waitFor({ timeout: 30_000 });
  await p.waitForTimeout(1500);
  const seen = await p.evaluate(() => window.__seen);
  const bad = seen.map((t) => t.match(WRONG)?.[0]).find(Boolean);
  if (bad) failed++;
  console.log(`${bad ? 'FAIL' : 'ok  '} ${path}${bad ? `: showed "${bad}" while the wallet reconnected` : ''}`);
}
await browser.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
