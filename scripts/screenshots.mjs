#!/usr/bin/env node
// Screenshots every route at desktop 1440 and mobile 390, in light and dark (the merge rule).
// Usage: node scripts/screenshots.mjs [baseUrl] [outDir] [--address 0x…] [--routes /a,/b]
// --address connects a read-only wallet stub with that address (no signing), so account screens
// show that account's real state.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const address = flag('--address');
const routesArg = flag('--routes');
const base = args[0] ?? 'http://localhost:3217';
const out = args[1] ?? 'screenshots';
const routes = routesArg ? routesArg.split(',') : ['/app', '/app/trade/CL', '/app/positions', '/app/settings', '/app/onboarding', '/app/audit'];
const sizes = [
  { name: '1440', width: 1440, height: 1000, mobile: false },
  { name: '390', width: 390, height: 844, mobile: true },
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const theme of ['dark', 'light']) {
  for (const size of sizes) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, isMobile: size.mobile, hasTouch: size.mobile, colorScheme: theme });
    await ctx.addInitScript(
      ([t, addr]) => {
        localStorage.setItem('theme', t);
        if (addr) {
          const handlers = {};
          window.ethereum = {
            isMetaMask: true,
            request: async ({ method }) => {
              if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [addr];
              if (method === 'eth_chainId') return '0xa4b1';
              if (method === 'net_version') return '42161';
              throw Object.assign(new Error(`stub wallet: ${method} not supported`), { code: 4200 });
            },
            on: (e, h) => ((handlers[e] ??= []).push(h)),
            removeListener: () => {},
          };
        }
      },
      [theme, address ?? null],
    );
    const page = await ctx.newPage();
    for (const route of routes) {
      await page.goto(base + route, { waitUntil: 'networkidle', timeout: 120_000 });
      if (address) {
        const btn = page.getByRole('button', { name: 'Connect wallet' }).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click();
          await page.waitForLoadState('networkidle');
        }
      }
      await page.waitForTimeout(2500);
      const file = join(out, `${route.replace(/^\//, '').replace(/\//g, '_') || 'root'}-${size.name}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(file);
    }
    await ctx.close();
  }
}
await browser.close();
