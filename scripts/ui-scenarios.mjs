#!/usr/bin/env node
// Interaction screenshots for UI review: the same clicks on any build (production "before", local "after").
// Each scenario at desktop 1440 and phone 390, dark and light.
// Usage: node scripts/ui-scenarios.mjs <baseUrl> <outDir> <prefix> [--only name,name] [--video]
//   --video  also records one desktop pass of: open the market selector, type a size, open "When", load a trade screen.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const has = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? false : (args.splice(i, 1), true);
};
const only = opt('--only')?.split(',');
const video = has('--video');
const [base, out, prefix = 'shot'] = args;
mkdirSync(out, { recursive: true });

const wait = (p, ms) => p.waitForTimeout(ms);
const isPhone = (p) => (p.viewportSize()?.width ?? 1440) < 760;

/** Each scenario returns after setting up the screen to capture. */
const SCENARIOS = {
  // What a first-time visitor sees after pressing Trade.
  'trade-landing': async (p) => {
    await p.goto(`${base}/app`, { waitUntil: 'load', timeout: 120_000 });
    await wait(p, 2500);
    const link = isPhone(p) ? p.locator('nav.mtabbar').getByText('Trade', { exact: true }) : p.locator('header nav').getByText('Trade', { exact: true });
    await link.waitFor({ state: 'visible', timeout: 90_000 });
    await link.click({ timeout: 60_000 });
    await p.waitForURL(/\/app\/trade\/[A-Z0-9]+/, { timeout: 60_000 });
    await wait(p, 6000);
  },
  // Click the market selector: its focus styling, and whether the list shows above the chart.
  'market-selector': async (p) => {
    await p.goto(`${base}/app/trade/GOLD`, { waitUntil: 'load', timeout: 120_000 });
    await wait(p, 5000);
    await p.locator('.msel').first().click();
    await wait(p, 600);
  },
  // Click into the size field: input focus styling.
  'size-input': async (p) => {
    await p.goto(`${base}/app/trade/GOLD`, { waitUntil: 'load', timeout: 120_000 });
    await wait(p, 5000);
    if (isPhone(p)) {
      await p.locator('.mcta').getByText('Long', { exact: true }).click();
      await wait(p, 600);
    }
    const size = p.locator('input[placeholder="Your size"]').last();
    await size.click();
    await size.type('0.05', { delay: 60 });
    await wait(p, 400);
  },
  // Open the "When" field in the rule builder.
  'when-select': async (p) => {
    await p.goto(`${base}/app/rules`, { waitUntil: 'load', timeout: 120_000 });
    await wait(p, 4000);
    const trigger = p.locator('#rb-when');
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await wait(p, 600);
  },
  // Keyboard focus: Tab to the first control in the top bar.
  'keyboard-focus': async (p) => {
    await p.goto(`${base}/app/trade/GOLD`, { waitUntil: 'load', timeout: 120_000 });
    await wait(p, 4000);
    for (let i = 0; i < 4; i++) await p.keyboard.press('Tab');
    await wait(p, 300);
  },
};

const browser = await chromium.launch();
for (const theme of ['dark', 'light']) {
  for (const size of [
    { name: '1440', width: 1440, height: 900, mobile: false },
    { name: '390', width: 390, height: 844, mobile: true },
  ]) {
    for (const [name, run] of Object.entries(SCENARIOS)) {
      if (only && !only.includes(name)) continue;
      const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, isMobile: size.mobile, hasTouch: size.mobile, colorScheme: theme });
      await ctx.addInitScript((t) => localStorage.setItem('theme', t), theme);
      const p = await ctx.newPage();
      try {
        await run(p);
        await p.screenshot({ path: join(out, `${prefix}-${name}-${size.name}-${theme}.png`) });
        console.log(name, size.name, theme, 'ok');
      } catch (e) {
        console.log(name, size.name, theme, 'FAILED', e.message.split('\n')[0]);
      }
      await ctx.close();
    }
  }
}

if (video) {
  try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', recordVideo: { dir: out, size: { width: 1440, height: 900 } } });
  await ctx.addInitScript(() => localStorage.setItem('theme', 'dark'));
  const p = await ctx.newPage();
  await SCENARIOS['market-selector'](p);
  await wait(p, 1500);
  await p.keyboard.press('Escape');
  await wait(p, 500);
  const sizeBox = p.locator('input[placeholder="Your size"]').first();
  await sizeBox.click();
  await sizeBox.type('0.05', { delay: 120 });
  await wait(p, 1200);
  await SCENARIOS['when-select'](p);
  await wait(p, 1200);
  await p.keyboard.press('ArrowDown');
  await wait(p, 400);
  await p.keyboard.press('ArrowDown');
  await wait(p, 400);
  await p.keyboard.press('Enter');
  await wait(p, 1200);
  await SCENARIOS['trade-landing'](p);
  await wait(p, 2500);
  const v = p.video();
  await ctx.close();
  console.log('video', await v?.path());
  } catch (e) {
    console.log('video FAILED', e.message.split('\n')[0]);
  }
}
await browser.close();
