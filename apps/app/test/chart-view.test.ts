import { describe, expect, it } from 'vitest';
import { MIN_CANDLES, clampView, edges, panBy, visibleRange, wheelToView, zoomAt } from '../lib/chart-view';

const N = 500;
const W = 900;
const start = { count: 100, end: 0 };
const candleAt = (v: { count: number; end: number }, anchor: number) => edges(v, N).left + anchor * v.count;

describe('chart view', () => {
  it('zooming keeps the candle under the cursor in place', () => {
    for (const anchor of [0, 0.25, 0.5, 0.8]) {
      const before = candleAt({ count: 100, end: 50 }, anchor);
      const z = zoomAt({ count: 100, end: 50 }, 2, anchor, N, W);
      expect(z.count).toBeCloseTo(50);
      expect(candleAt(z, anchor)).toBeCloseTo(before);
    }
  });
  it('wheel up zooms in and wheel down zooms out, like TradingView and Hyperliquid', () => {
    expect(wheelToView(start, { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: false }, 0.5, N, W).count).toBeLessThan(100);
    expect(wheelToView(start, { deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false }, 0.5, N, W).count).toBeGreaterThan(100);
  });
  it('a trackpad pinch (ctrlKey wheel) zooms; spreading fingers zooms in', () => {
    expect(wheelToView(start, { deltaX: 0, deltaY: -10, deltaMode: 0, ctrlKey: true }, 0.5, N, W).count).toBeLessThan(100);
  });
  it('a sideways two-finger swipe pans instead of zooming', () => {
    const v = wheelToView({ count: 100, end: 50 }, { deltaX: 90, deltaY: 5, deltaMode: 0, ctrlKey: false }, 0.5, N, W);
    expect(v.count).toBe(100);
    expect(v.end).toBeCloseTo(40); // 90 px of 900 px is 10 candles, toward the present
  });
  it('line-mode wheels (Firefox) zoom by a similar amount to pixel mode', () => {
    const px = wheelToView(start, { deltaX: 0, deltaY: 48, deltaMode: 0, ctrlKey: false }, 0.5, N, W).count;
    const lines = wheelToView(start, { deltaX: 0, deltaY: 3, deltaMode: 1, ctrlKey: false }, 0.5, N, W).count;
    expect(lines).toBeCloseTo(px);
  });
  it('never zooms in past the minimum or out past what is loaded', () => {
    expect(zoomAt(start, 1000, 0.5, N, W).count).toBe(MIN_CANDLES);
    expect(zoomAt(start, 0.0001, 0.5, N, W).count).toBeLessThanOrEqual(N * 1.3);
    expect(zoomAt(start, 0.0001, 0.5, 5000, W).count).toBeLessThanOrEqual(W); // at least 1 px per candle
  });
  it('panning stops at the oldest candle and a little past the newest', () => {
    expect(panBy(start, 10_000, N, W).end).toBeLessThanOrEqual(N);
    expect(panBy(start, -10_000, N, W).end).toBeCloseTo(-30);
    expect(visibleRange(panBy(start, 10_000, N, W), N).from).toBe(0);
  });
  it('the visible range covers the view', () => {
    expect(visibleRange({ count: 100, end: 0 }, N)).toEqual({ from: 400, to: 500 });
    expect(visibleRange({ count: 99.5, end: 10.2 }, N)).toEqual({ from: 390, to: 490 });
  });
  it('clamping keeps a view valid when fewer candles load', () => {
    const v = clampView({ count: 300, end: 200 }, 40, W);
    expect(v.count).toBeLessThanOrEqual(52);
    expect(v.end).toBeLessThanOrEqual(35);
  });
});
