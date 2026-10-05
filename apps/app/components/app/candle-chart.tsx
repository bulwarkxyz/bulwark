'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { MIN_CANDLES, clampView, edges, panBy, visibleRange, wheelToView, zoomAt, type ChartView } from '@/lib/chart-view';
import type { Candle } from '@/lib/hl';
import { formatTime, useTimes } from '@/lib/time';
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
 *
 * Zoom and pan, as on TradingView and Hyperliquid: the wheel or a two-finger scroll zooms the time axis
 * at the cursor, a sideways swipe or a drag pans, a pinch zooms, a double-click resets. Keys when
 * focused: + and − zoom, ← and → pan, 0 resets. While the pointer is over the chart the page doesn't
 * scroll; on phones a touch that starts outside the chart scrolls the page as usual. Panning near the
 * oldest loaded candle asks for older ones (onNeedOlder). The price axis always fits the visible candles
 * and every level line, so guard, liquidation and price tags stay right at any zoom.
 */
export function CandleChart({ candles, lines, stale, onNeedOlder, loadingOlder, noOlder }: { candles: readonly Candle[]; lines: readonly ChartLine[]; stale?: string; onNeedOlder?: () => void; loadingOlder?: boolean; noOlder?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const clipId = `cc${useId().replace(/:/g, '')}`;
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
  const n = candles.length;
  // null: the default view (newest candles at about 9 px each), until the user zooms or pans.
  const [userView, setUserView] = useState<ChartView | null>(null);
  const fit: ChartView = { count: Math.max(MIN_CANDLES, Math.min(n, Math.floor(plotW / 9))), end: 0 };
  const view = clampView(userView ?? fit, n, plotW);

  // Older candles arrive at the start of the array: keep the view where it was (end counts from the
  // newest candle, so it stays put); a new candle at the end moves a panned-back view by one, so add it.
  const lastT = useRef<number | null>(null);
  const newest = candles[n - 1]?.t ?? null;
  useEffect(() => {
    const prev = lastT.current;
    lastT.current = newest;
    if (prev === null || newest === null || newest === prev || !userView || userView.end <= 0) return;
    const added = candles.filter((c) => c.t > prev).length;
    if (added) setUserView((v) => (v ? { ...v, end: v.end + added } : v));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newest]);

  // Ask for older candles when the view gets near the oldest loaded one.
  const { left } = edges(view, n);
  useEffect(() => {
    if (userView && onNeedOlder && !loadingOlder && !noOlder && n > 0 && left < Math.max(10, view.count * 0.25)) onNeedOlder();
  }, [userView, left, n, view.count, onNeedOlder, loadingOlder, noOlder]);

  // Gestures. Handlers read the latest view through a ref; the wheel listener is non-passive so it can
  // stop the page from scrolling.
  const live = useRef({ view, n, plotW });
  live.current = { view, n, plotW };
  const set = (v: ChartView) => setUserView(clampView(v, live.current.n, live.current.plotW));
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { view: v, n: count, plotW: pw } = live.current;
      if (!pw || !count) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const anchor = Math.min(1, Math.max(0, (e.clientX - r.left) / pw));
      setUserView(wheelToView(v, e, anchor, count, pw));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; view: ChartView; anchor: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const r = box.current!.getBoundingClientRect();
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, view: live.current.view, anchor: Math.min(1, Math.max(0, ((a.x + b.x) / 2 - r.left) / live.current.plotW)) };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const { view: v, n: count, plotW: pw } = live.current;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      set(zoomAt(pinch.current.view, dist / pinch.current.dist, pinch.current.anchor, count, pw));
      return;
    }
    if (!pw) return;
    // Drag right to see the past, as on every trading chart.
    set(panBy(v, ((e.clientX - prev.x) / pw) * v.count, count, pw));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const { view: v, n: count, plotW: pw } = live.current;
    const step = Math.max(1, v.count * 0.1);
    const act: Record<string, () => ChartView | null> = {
      '+': () => zoomAt(v, 1.25, 0.5, count, pw),
      '=': () => zoomAt(v, 1.25, 0.5, count, pw),
      '-': () => zoomAt(v, 0.8, 0.5, count, pw),
      ArrowLeft: () => panBy(v, step, count, pw),
      ArrowRight: () => panBy(v, -step, count, pw),
      '0': () => null,
    };
    const f = act[e.key];
    if (!f) return;
    e.preventDefault();
    setUserView(f());
  };

  const { from, to } = visibleRange(view, n);
  const shown = candles.slice(from, to);
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
  const step = view.count ? plotW / view.count : 0;
  const X = (i: number) => (i + 0.5 - left) * step;
  const times = useTimes();
  const timeTicks = timeAxis(candles, from, to, X, plotW, times.zone);
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
    <div
      ref={box}
      className="cchart"
      data-candles={n}
      role="img"
      tabIndex={0}
      aria-roledescription="zoomable chart"
      aria-label={`Price chart${lines.length ? `; levels: ${lines.map((l) => `${l.label} ${fmtPx(l.px)}`).join(', ')}` : ''}. Scroll or pinch to zoom, drag to pan, double-click or 0 to reset.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => setUserView(null)}
      onKeyDown={onKeyDown}
    >
      {w > 0 && h > 0 && shown.length ? (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
          <defs>
            <clipPath id={clipId}>
              <rect x={0} y={0} width={plotW} height={h - PAD_B + 4} />
            </clipPath>
          </defs>
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
          <g clipPath={`url(#${clipId})`}>
          {shown.map((c, k) => {
            const x = X(from + k);
            const up = c.c >= c.o;
            const col = up ? 'var(--long)' : 'var(--short)';
            const top = Y(Math.max(c.o, c.c));
            return (
              <g key={c.t} data-t={c.t} data-x={Math.round(x)}>
                <line x1={x} x2={x} y1={Y(c.h)} y2={Y(c.l)} stroke={col} />
                <rect x={x - Math.max(1, step * 0.32)} y={top} width={Math.max(2, step * 0.64)} height={Math.max(1, Y(Math.min(c.o, c.c)) - top)} fill={col} />
              </g>
            );
          })}
          </g>
          {timeTicks.map((t) => (
            <text key={t.x} x={t.x} y={h - 6} textAnchor="middle" fontSize="11" fill="var(--text-3)" fontFamily="var(--font-geist-mono)">
              {t.label}
            </text>
          ))}
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
      {userView ? (
        <button type="button" className="btn btn-sm cchart-reset" onClick={() => setUserView(null)} onPointerDown={(e) => e.stopPropagation()}>
          Reset view
        </button>
      ) : null}
      {loadingOlder ? <span className="tiny t3 cchart-note">Loading older candles…</span> : noOlder && left < 1 ? <span className="tiny t3 cchart-note">No older candles on Hyperliquid</span> : null}
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

/** Time labels along the bottom, at least 90 px apart: the date where the day changes, else the time. */
function timeAxis(candles: readonly Candle[], from: number, to: number, X: (i: number) => number, plotW: number, zone: Parameters<typeof formatTime>[1]): Array<{ x: number; label: string }> {
  if (to - from < 2) return [];
  const span = candles[1] && candles[0] ? candles[1].t - candles[0].t : 3_600_000;
  const px = Math.abs(X(from + 1) - X(from)) || 1;
  const every = Math.max(1, Math.ceil(90 / px));
  const out: Array<{ x: number; label: string }> = [];
  let lastDay = '';
  for (let i = Math.ceil(from / every) * every; i < to; i += every) {
    const c = candles[i];
    if (!c) continue;
    const x = X(i);
    if (x < 24 || x > plotW - 24) continue;
    const short = formatTime(c.t, zone, 'short'); // MM-DD HH:mm
    const day = short.slice(0, 5);
    out.push({ x, label: span >= 86_400_000 || day !== lastDay ? day : short.slice(6) });
    lastDay = day;
  }
  return out;
}
