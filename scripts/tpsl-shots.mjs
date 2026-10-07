#!/usr/bin/env node
// Screenshots of the TP/SL panel on a real position, as its signed-in owner sees it: 1440 and 390, dark and
// light. Read-only: the browser announces the account's address and refuses every signature, and nothing is
// placed or cancelled (a take profit is typed to show the preview, never sent).
// The session comes from a file (BW_SESSION_FILE: the API's session token, one line) and is put in the
// page's sessionStorage; it is never printed.
// Usage: BW_SESSION_FILE=<path> node scripts/tpsl-shots.mjs <baseUrl> <address> <coin, e.g. xyz:GOLD> <outDir>
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [base, address, coin, out] = process.argv.slice(2);
if (!base || !/^0x[0-9a-fA-F]{40}$/.test(address ?? '') || !coin || !out) throw new Error('usage: BW_SESSION_FILE=… node scripts/tpsl-shots.mjs <baseUrl> <address> <coin> <outDir>');
const token = process.env.BW_SESSION_FILE ? readFileSync(process.env.BW_SESSION_FILE, 'utf8').trim() : '';
if (!token) throw new Error('BW_SESSION_FILE must point at a file holding the session token');
mkdirSync(out, { recursive: true });

// An EIP-6963 wallet that only knows the address: every signing request is refused.
const readOnly = ({ addr }) => {
  const provider = {
    async request({ method }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
      if (method === 'eth_chainId') return '0xa4b1';
      if (method === 'net_version') return '42161';
      if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions') return [{ parentCapability: 'eth_accounts' }];
      throw Object.assign(new Error('Read-only: this browser signs nothing.'), { code: 4001 });
    },
    on() {},
    removeListener() {},
  };
  const detail = Object.freeze({ info: { uuid: '7d3c2b8e-2222-4a5b-9c0d-000000000002', name: 'Read-only', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2228%22 height=%2228%22%3E%3Crect width=%2228%22 height=%2228%22 rx=%226%22 fill=%22%235D6B7B%22/%3E%3C/svg%3E', rdns: 'local.bulwark.readonly' }, provider });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
};

const browser = await chromium.launch();
const ticker = coin.replace(/^xyz:/, '');
for (const theme of ['dark', 'light'])
  for (const w of [1440, 390]) {
    const phone = w < 500;
    const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 2, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(
      ({ t, s, a }) => {
        localStorage.setItem('theme', t);
        sessionStorage.setItem('bw.session', s);
        sessionStorage.setItem('bw.session.address', a.toLowerCase());
      },
      { t: theme, s: token, a: address },
    );
    await ctx.addInitScript(readOnly, { addr: address });
    const p = await ctx.newPage();
    await p.goto(`${base}/app/positions`, { timeout: 120_000 });
    await p.waitForTimeout(4000);
    if (!(await p.locator('header button.wallet').filter({ visible: true }).count())) {
      await p.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first().click({ timeout: 60_000 });
      const opt = p.locator('[data-testid="rk-wallet-option-local.bulwark.readonly"]');
      await opt.waitFor({ timeout: 30_000 }).then(() => opt.click({ force: true })).catch(() => {});
    }
    const row = phone ? p.locator(`article[id="posc-${coin}"]`) : p.locator(`tr[id="pos-${coin}"]`);
    await row.waitFor({ timeout: 90_000 });
    const btn = row.getByRole('button', { name: /TP\/SL|TP |SL / });
    await btn.waitFor({ timeout: 60_000 });
    await p.waitForTimeout(3000);
    await btn.click();
    const pop = p.locator('.pop');
    await pop.locator('#tpsl-tp').waitFor();
    await p.waitForTimeout(2000);
    const head = (await pop.locator('.tiny.t2').first().textContent()) ?? '';
    const now = Number((head.match(/price now ([\d,.]+)/)?.[1] ?? '0').replace(/,/g, ''));
    const long = /long/.test(head);
    await pop.locator('#tpsl-tp').fill(String(+(now * (long ? 1.025 : 0.975)).toPrecision(5)));
    await pop.locator('#tpsl-slip').fill('1');
    await p.waitForTimeout(500);
    const listed = await pop.locator('.tpsl-list li').allTextContents();
    await p.screenshot({ path: `${out}/tpsl-${ticker}-${w}-${theme}.png` });
    console.log(`${theme} ${w}: ${head.trim()} | listed: ${listed.map((x) => x.replace(/\s+/g, ' ').slice(0, 40)).join(' / ') || 'none'}`);
    await ctx.close();
  }
await browser.close();
