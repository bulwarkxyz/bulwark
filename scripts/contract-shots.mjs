#!/usr/bin/env node
// The screens for the 8 Oct API contract on a local review build, at 1440 and 390 in both themes:
//   rules that need signing again (Guard rules banner, and the guard bar's pause line);
//   the trade ticket in every region case: blocked (country, declaration, unknown place), alerts only, no answer, limited;
//   the global stop in the guard bar.
// Usage: node scripts/contract-shots.mjs <local review build url> <outDir>
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const [base = 'http://localhost:3231', out = 'contract-shots'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const W = 'watch=0x7c81e5a50a1931a5fbe663a916d31e46f804fd1e&rules=example';
const SHOTS = [
  ['resign-rules', `/app/rules?${W}&resign=1&guard=paused:resign_required`, 'Sign your rules again'],
  ['resign-positions', `/app/positions?${W}&resign=1&guard=paused:resign_required`, 'Sign your rules again'],
  ['operator-stop', `/app/positions?${W}&guard=paused:operator_stop`, 'resumes when Bulwark lifts the stop'],
  ['region-blocked-country', `/app/trade/GOLD?${W}&region=blocked`, 'Your connection comes from United States'],
  ['region-blocked-declared', `/app/trade/GOLD?${W}&region=declared`, 'residence or citizenship you declared in setup'],
  ['region-blocked-unknown-place', `/app/trade/GOLD?${W}&region=nowhere`, 'can’t tell which country'],
  ['region-alerts-only', `/app/trade/GOLD?${W}&region=alerts_only`, 'From Germany, the guard sends alerts'],
  ['region-no-answer', `/app/trade/GOLD?${W}&region=unknown`, 'didn’t answer the region check'],
  ['region-limited', `/app/trade/GOLD?${W}&region=limited`, 'limiting region checks'],
];
const browser = await chromium.launch();
let failed = 0;
for (const theme of ['dark', 'light'])
  for (const w of [1440, 390]) {
    const phone = w < 500;
    const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, deviceScaleFactor: 2, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript((t) => localStorage.setItem('theme', t), theme);
    const p = await ctx.newPage();
    for (const [name, path, text] of SHOTS) {
      await p.goto(`${base}${path}`, { timeout: 120_000 });
      const el = p.getByText(text).filter({ visible: true }).first();
      // On phones the ticket sits behind the Long / Short buttons.
      if (phone && path.includes('/trade/')) await p.getByRole('button', { name: /^Long/ }).filter({ visible: true }).first().click({ timeout: 30_000 }).catch(() => {});
      const ok = await el.waitFor({ timeout: 45_000 }).then(() => true, () => false);
      if (!ok) failed++;
      if (ok) await el.scrollIntoViewIfNeeded();
      await p.waitForTimeout(1500);
      await p.screenshot({ path: `${out}/${name}-${w}-${theme}.png` });
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${w} ${theme}`);
    }
    await ctx.close();
  }
await browser.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
