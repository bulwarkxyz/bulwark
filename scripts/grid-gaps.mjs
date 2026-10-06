#!/usr/bin/env node
// Uneven grids: on each screen, every CSS grid with items in more than one column whose row-mates differ
// in height, leaving dead space under the shorter one. Reports the worst gap per grid (px).
// Usage: node scripts/grid-gaps.mjs <baseUrl> [--query 'watch=0x…&rules=example'] [--width 1440] [--min 48]
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args.splice(i, 2)[1];
};
const query = opt('--query', '');
const width = Number(opt('--width', '1440'));
const min = Number(opt('--min', '48'));
const base = args[0] ?? 'http://localhost:3230';
const PAGES = ['/app', '/app/trade/GOLD', '/app/positions', '/app/rules', '/app/simulator', '/app/audit', '/app/settings', '/app/account', '/app/onboarding', '/app/notifications'];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height: 1000 } });
let found = 0;
for (const path of PAGES) {
  await page.goto(`${base}${path}${query ? `?${query}` : ''}`, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForTimeout(5000);
  const gaps = await page.evaluate((min) => {
    const out = [];
    for (const g of document.querySelectorAll('main *, .pg *')) {
      const cs = getComputedStyle(g);
      // Grids of cards only: named-area layouts (the trade grid) span on purpose, and rows like a rule's
      // number | text | status are one item's parts.
      if (cs.display !== 'grid' || cs.gridTemplateColumns.split(' ').length < 2 || cs.gridTemplateAreas !== 'none') continue;
      // An item placed across several rows (the trade ticket) is meant to be tall.
      const spans = (k) => {
        const st = getComputedStyle(k);
        const a = Number.parseInt(st.gridRowStart, 10);
        const b = Number.parseInt(st.gridRowEnd, 10);
        return (/span (\d+)/.exec(st.gridRowEnd)?.[1] ?? '1') !== '1' || (Number.isFinite(a) && Number.isFinite(b) && b - a > 1);
      };
      const isCard = (k) => k.matches('.panel, section, article') || Boolean(k.firstElementChild?.matches('.panel, section, article'));
      const kids = [...g.children].filter((k) => k.getBoundingClientRect().height > 0 && getComputedStyle(k).position !== 'absolute' && isCard(k) && !spans(k));
      if (kids.length < 3) continue;
      const rows = new Map();
      for (const k of kids) {
        const top = Math.round(k.getBoundingClientRect().top);
        rows.set(top, [...(rows.get(top) ?? []), k]);
      }
      let worst = 0;
      for (const r of rows.values()) {
        if (r.length < 2) continue;
        const hs = r.map((k) => k.getBoundingClientRect().height);
        worst = Math.max(worst, Math.max(...hs) - Math.min(...hs));
      }
      if (worst >= min) out.push({ grid: `${g.tagName.toLowerCase()}.${[...g.classList].join('.')}`, items: kids.length, gap: Math.round(worst), first: kids.map((k) => (k.querySelector('h2,h3,b,.ph')?.textContent ?? '').trim().slice(0, 24)).join(' | ') });
    }
    return out;
  }, min);
  for (const x of gaps) console.log(`${path}  ${x.grid}  ${x.items} items  gap ${x.gap}px  [${x.first}]`);
  found += gaps.length;
}
await browser.close();
console.log(found ? `${found} uneven grid(s) at ${width}px` : `no uneven grids at ${width}px`);
