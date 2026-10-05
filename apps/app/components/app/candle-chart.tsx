'use client';

import { useEffect, useRef, useState } from 'react';
import type { Candle } from '@/lib/hl';
import { fmtPx } from './format';

export interface ChartLine {
  px: number;
  kind: 'entry' | 'guard' | 'liq' | 'mark';
  label: string;
}

const AXIS = 64;
const PAD_T = 12;
const PAD_B = 22;

/**
 * Candles (blue up, orange down) with the levels a trader needs in one place: entry, each of the
 * user's guard lines as a price, and the liquidation price. Static drawing, no animation.
 */
export function CandleChart({ candles, lines, stale }: { candles: readonly Candle[]; lines: readonly ChartLine[]; stale?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { w, h } = size;
  const plotW = Math.max(0, w - AXIS);
  const plotH = Math.max(0, h - PAD_T - PAD_B);
  const shown = candles.slice(-Math.max(10, Math.floor(plotW / 9)));
  const ext = [...shown.flatMap((c) => [c.h, c.l]), ...lines.filter((l) => l.kind !== 'mark').map((l) => l.px)].filter((x) => x > 0);
  let lo = Math.min(...ext);
  let hi = Math.max(...ext);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
  lo -= pad;
  hi += pad;
  const Y = (p: number) => PAD_T + ((hi - p) / (hi - lo)) * plotH;
  const step = shown.length ? plotW / shown.length : 0;
  const ticks = niceTicks(lo, hi, Math.max(3, Math.floor(plotH / 60)));
  // Lay out level labels and axis tags so none overlap (sorted top to bottom, pushed down by 18 px).
  const placed = lines
    .map((l, i) => ({ l, i, y: Y(l.px) }))
    .filter((x) => x.y >= 0 && x.y <= h)
    .sort((a, b) => a.y - b.y);
  let lastTag = -Infinity;
  let lastLabel = -Infinity;
  const tagY = new Map<number, number>();
  const labelY = new Map<number, number>();
  for (const x of placed) {
    const ty = Math.max(x.y, lastTag + 18);
    tagY.set(x.i, ty);
    lastTag = ty;
    if (x.l.kind !== 'mark') {
      const ly = Math.max(x.y - 12, lastLabel + 18);
      labelY.set(x.i, ly);
      lastLabel = ly;
    }
  }
  const tagYs = [...tagY.values()];
  const color = { entry: 'var(--text-2)', guard: 'var(--warn)', liq: 'var(--crit)', mark: 'var(--ink)' } as const;
  const tagText = { entry: 'var(--surface)', guard: 'var(--on-warn)', liq: 'var(--on-crit)', mark: 'var(--on-ink)' } as const;

  return (
    <div ref={box} className="cchart" role="img" aria-label={`Price chart${lines.length ? `; levels: ${lines.map((l) => `${l.label} ${fmtPx(l.px)}`).join(', ')}` : ''}`}>
      {w > 0 && h > 0 && shown.length ? (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={0} x2={plotW} y1={Y(t)} y2={Y(t)} stroke="var(--line)" />
              {tagYs.some((ty) => Math.abs(ty - Y(t)) < 14) ? null : (
                <text x={w - 6} y={Y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-3)" fontFamily="var(--font-geist-mono)">
                  {fmtPx(t)}
                </text>
              )}
            </g>
          ))}
          <line x1={plotW} x2={plotW} y1={0} y2={h} stroke="var(--line)" />
          {shown.map((c, i) => {
            const x = i * step + step / 2;
            const up = c.c >= c.o;
            const col = up ? 'var(--long)' : 'var(--short)';
            const top = Y(Math.max(c.o, c.c));
            return (
              <g key={c.t}>
                <line x1={x} x2={x} y1={Y(c.h)} y2={Y(c.l)} stroke={col} />
                <rect x={x - Math.max(1, step * 0.32)} y={top} width={Math.max(2, step * 0.64)} height={Math.max(1, Y(Math.min(c.o, c.c)) - top)} fill={col} />
              </g>
            );
          })}
          {lines.map((l, i) => {
            const y = Y(l.px);
            if (y < 0 || y > h) return null;
            const ty = tagY.get(i) ?? y;
            const ly = labelY.get(i) ?? y - 12;
            return (
              <g key={`${l.kind}-${i}`}>
                <line x1={0} x2={plotW} y1={y} y2={y} stroke={color[l.kind]} strokeDasharray={l.kind === 'liq' ? undefined : l.kind === 'mark' ? '2 3' : '5 4'} strokeWidth={l.kind === 'guard' || l.kind === 'liq' ? 1.25 : 1} />
                <rect x={plotW} y={ty - 9} width={AXIS} height={18} rx={3} fill={l.kind === 'entry' ? 'var(--text-2)' : color[l.kind]} />
                <text x={plotW + AXIS / 2} y={ty + 4} textAnchor="middle" fontSize="11" fill={tagText[l.kind]} fontFamily="var(--font-geist-mono)">
                  {fmtPx(l.px)}
                </text>
                {l.kind !== 'mark' ? (
                  <g>
                    <rect x={8} y={ly - 8} width={l.label.length * 6.4 + 12} height={16} rx={4} fill="var(--surface)" stroke={l.kind === 'entry' ? 'var(--line-2)' : color[l.kind]} />
                    <text x={14} y={ly + 4} fontSize="11" fill="var(--text)">
                      {l.label}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })}
          {stale ? (
            <g>
              <rect x={plotW - stale.length * 6.4 - 22} y={8} width={stale.length * 6.4 + 14} height={20} rx={10} fill="var(--surface)" stroke="var(--crit)" />
              <text x={plotW - stale.length * 6.4 - 15} y={22} fontSize="11" fill="var(--crit)">
                {stale}
              </text>
            </g>
          ) : null}
        </svg>
      ) : null}
    </div>
  );
}

function niceTicks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [];
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(+t.toFixed(10));
  return out;
}
