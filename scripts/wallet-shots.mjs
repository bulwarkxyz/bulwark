#!/usr/bin/env node
// The connect modal at 1440 and 390, dark and light: closed button, modal open (with a test browser wallet
// discovered through EIP-6963), and connected. Local builds only (scripts/test-wallet.mjs).
// Usage: node scripts/wallet-shots.mjs <baseUrl> <outDir>
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { installTestWallet } from './test-wallet.mjs';

const [base = 'http://localhost:3230', out = 'wallet-shots'] = process.argv.slice(2);
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error('local builds only');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const theme of ['dark', 'light'])
  for (const w of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: w > 500 ? 900 : 844 }, colorScheme: theme, ...(w < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    await ctx.addInitScript((t) => localStorage.setItem('theme', t), theme);
    await installTestWallet(ctx);
    const page = await ctx.newPage();
    await page.goto(`${base}/app/onboarding`, { waitUntil: 'networkidle' });
    const btn = page.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first();
    await btn.click();
    const dialog = page.locator('[role="dialog"]').filter({ visible: true }).first();
    await dialog.waitFor();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${out}/modal-${w}-${theme}.png` });
    await dialog.getByText('Test Wallet').first().click();
    await page.getByRole('button', { name: 'Sign in' }).filter({ visible: true }).first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/connected-${w}-${theme}.png` });
    await ctx.close();
  }
await browser.close();
console.log('saved to', out);
