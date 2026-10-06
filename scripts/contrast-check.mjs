#!/usr/bin/env node
// WCAG AA check for every text and fill pair the design lists (scripts/contrast-pairs.json), in both
// themes, using the token values exactly as apps/app/app/app/app.css defines them. Translucent tokens
// are composited over the surface named after "@" ("warn-soft@s2"). Exits 1 on any failure.
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../apps/app/app/app/app.css', import.meta.url), 'utf8');
const pairs = JSON.parse(readFileSync(new URL('./contrast-pairs.json', import.meta.url), 'utf8'));

function tokens(theme) {
  // The block may list more selectors after .bw (the wallet modal's [data-rk] shares the tokens).
  const m = css.match(new RegExp(`html\\.${theme} \\.bw(?:,[^{]*)?\\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`no ${theme} token block in app.css`);
  return Object.fromEntries([...m[1].matchAll(/--([\w-]+):([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
}
function rgba(v) {
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = v.match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  throw new Error(`unsupported colour ${v}`);
}
const over = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = ([r, g, b]) => [r, g, b].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

let failed = 0;
for (const theme of ['dark', 'light']) {
  const t = tokens(theme);
  const color = (name) => {
    const [tok, base] = name.split('@');
    if (!(tok in t)) throw new Error(`${theme}: unknown token --${tok}`);
    const c = rgba(t[tok]);
    return base ? over(c, color(base)) : c[3] < 1 ? over(c, color('surface')) : c;
  };
  for (const p of pairs) {
    const r = ratio(color(p.fg), color(p.bg));
    const ok = r >= p.min;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${theme.padEnd(5)} ${r.toFixed(2).padStart(5)} ≥ ${p.min}  ${p.fg} on ${p.bg}  (${p.use})`);
  }
}
if (failed) { console.error(`\n${failed} pair(s) below WCAG AA`); process.exit(1); }
console.log(`\nall ${pairs.length * 2} pairs pass WCAG AA`);
