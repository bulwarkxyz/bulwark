/**
 * The candle chart's view: how many candles span the plot (`count`) and how far its right edge sits back
 * from the newest candle (`end`, in candles; 0 = the newest candle at the right edge). Both may be
 * fractional, so zooming and panning are smooth. Pure functions, so the gestures can be tested.
 */
export interface ChartView {
  count: number;
  end: number;
}

export const MIN_CANDLES = 10;
/** Empty space allowed to the right of the newest candle, as a share of the view. */
const FUTURE = 0.3;

/** The most candles the view may span: all loaded ones (plus the right margin), at least 1 px each. */
export function maxCount(n: number, plotW: number): number {
  return Math.max(MIN_CANDLES, Math.min(Math.max(n, MIN_CANDLES) * (1 + FUTURE), Math.max(plotW, MIN_CANDLES)));
}

export function clampView(v: ChartView, n: number, plotW: number): ChartView {
  const count = Math.min(maxCount(n, plotW), Math.max(MIN_CANDLES, v.count));
  // Right edge: no further right than the margin past the newest candle, no further left than
  // keeping a few candles in view.
  const end = Math.min(Math.max(v.end, -count * FUTURE), Math.max(0, n - Math.min(MIN_CANDLES, n) / 2));
  return { count, end };
}

/** Index space: the left and right edges of the view (candle i is centred at i + 0.5). */
export function edges(v: ChartView, n: number): { left: number; right: number } {
  const right = n - v.end;
  return { left: right - v.count, right };
}

/**
 * Zoom by `factor` (> 1 zooms in: fewer candles) keeping the point at `anchor` (0 = left edge of the
 * plot, 1 = right edge) on the same candle, the way TradingView and Hyperliquid's chart zoom at the cursor.
 */
export function zoomAt(v: ChartView, factor: number, anchor: number, n: number, plotW: number): ChartView {
  const { left } = edges(v, n);
  const at = left + anchor * v.count;
  const count = Math.min(maxCount(n, plotW), Math.max(MIN_CANDLES, v.count / factor));
  const newLeft = at - anchor * count;
  return clampView({ count, end: n - (newLeft + count) }, n, plotW);
}

/** Pan by `candles` (positive moves the view back in time, as dragging the chart to the right does). */
export function panBy(v: ChartView, candles: number, n: number, plotW: number): ChartView {
  return clampView({ count: v.count, end: v.end + candles }, n, plotW);
}

/**
 * Wheel and trackpad, as TradingView and Hyperliquid's chart do: scrolling up (or spreading two fingers)
 * zooms in, down zooms out, at the cursor; a sideways two-finger swipe pans. A trackpad pinch arrives as
 * a wheel event with ctrlKey and smaller deltas, so it zooms a little faster per unit.
 */
export function wheelToView(v: ChartView, e: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean }, anchor: number, n: number, plotW: number): ChartView {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (Math.abs(dx) > Math.abs(dy) && !e.ctrlKey) return panBy(v, (-dx / plotW) * v.count, n, plotW);
  const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0025));
  return zoomAt(v, factor, anchor, n, plotW);
}

/** The candles to draw: those overlapping the view, with their position. */
export function visibleRange(v: ChartView, n: number): { from: number; to: number } {
  const { left, right } = edges(v, n);
  return { from: Math.max(0, Math.floor(left)), to: Math.min(n, Math.ceil(right)) };
}
