'use client';

import { fmtPx } from './format';

/** A plain line chart of closes. No animation. */
export function LineChart({ points, label, loading }: { points: Array<{ t: number; c: number }>; label: string; loading: boolean }) {
  if (loading) return <div className="skeleton" style={{ height: 240 }} aria-label="Loading chart" />;
  if (points.length < 2)
    return (
      <div className="faint" style={{ height: 240, display: 'grid', placeItems: 'center', fontSize: 13 }}>
        No trades in this market over the last 5 days.
      </div>
    );
  const W = 760;
  const H = 240;
  const lo = Math.min(...points.map((p) => p.c));
  const hi = Math.max(...points.map((p) => p.c));
  const span = hi - lo || 1;
  const pts = points.map((p, i) => `${((i / (points.length - 1)) * W).toFixed(1)},${(H - 12 - ((p.c - lo) / span) * (H - 24)).toFixed(1)}`).join(' ');
  const fmtDay = (t: number) => new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(t));
  return (
    <>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}: range ${fmtPx(lo)} to ${fmtPx(hi)}`}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" y1={H * f} x2={W} y2={H * f} stroke="var(--line)" strokeWidth="1" />
        ))}
        <polyline fill="none" stroke="var(--text)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" points={pts} />
      </svg>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
        <span className="faint num" style={{ fontSize: 12 }}>
          H {fmtPx(hi)} · L {fmtPx(lo)} · {label}, {fmtDay(points[0]!.t)} – {fmtDay(points[points.length - 1]!.t)}
        </span>
      </div>
    </>
  );
}
