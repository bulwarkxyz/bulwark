import { describe, expect, it } from 'vitest';
import { ORACLE_BAND, allowedTriggers, buildPositionTpsl, nearestValidPrice, tpslAction, type PositionTpslInput } from '@/lib/tpsl';

// The testnet run of 6 Oct 2026: xyz:GOLD long 0.0061 (szDecimals 4), mark and oracle about 4,151.
const gold: PositionTpslInput = { asset: 110003, szDecimals: 4, size: 0.0061, mark: 4151, oracle: 4151, tp: '', sl: '', slippage: '1' };

describe('TP/SL on a position: the shape proven on testnet', () => {
  it('a stop loss is a reduce-only market trigger on the closing side, for the whole position', () => {
    const r = buildPositionTpsl({ ...gold, sl: '3985.1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.legs).toHaveLength(1);
    const w = r.legs[0]!.wire as unknown as Record<string, unknown>;
    // Hyperliquid's order wire: a asset, b isBuy, p limit, s size, r reduceOnly, t type.
    expect(w).toMatchObject({ a: 110003, b: false, s: '0.0061', r: true, t: { trigger: { isMarket: true, triggerPx: '3985.1', tpsl: 'sl' } } });
    // 1% worst fill below the trigger (the run used 3945.3; one tick lower is the same 1%, rounded down).
    expect(Number(w.p)).toBeCloseTo(3945.2, 1);
  });
  it('a take profit has the same shape with tpsl "tp"', () => {
    const r = buildPositionTpsl({ ...gold, tp: '4286.1' });
    expect(r.ok && r.legs[0]!.wire).toMatchObject({ b: false, r: true, t: { trigger: { isMarket: true, triggerPx: '4286.1', tpsl: 'tp' } }, p: '4243.2' });
  });
  it('both are sent as plain orders (grouping "na"), with no builder fee', () => {
    const r = buildPositionTpsl({ ...gold, tp: '4286.1', sl: '3985.1' });
    if (!r.ok) throw new Error(r.problem);
    const a = tpslAction(r.legs) as unknown as Record<string, unknown>;
    expect(a.type).toBe('order');
    expect(a.grouping).toBe('na');
    expect(a.builder).toBeUndefined();
    expect((a.orders as unknown[]).length).toBe(2);
  });
  it('a short closes with buys', () => {
    const r = buildPositionTpsl({ ...gold, size: -0.5, tp: '4000', sl: '4300' });
    if (!r.ok) throw new Error(r.problem);
    expect(r.legs.every((l) => (l.wire as unknown as { b: boolean; r: boolean }).b && (l.wire as unknown as { r: boolean }).r)).toBe(true);
    expect(r.size).toBe(0.5);
    expect(r.legs.find((l) => l.kind === 'sl')!.limitPx).toBeGreaterThan(4300);
  });
});

describe('TP/SL: nothing is filled in, and every price is checked', () => {
  it('needs a price and the user’s own slippage', () => {
    expect(buildPositionTpsl(gold)).toEqual({ ok: false, problem: 'Type a take-profit price, a stop-loss price, or both.' });
    expect(buildPositionTpsl({ ...gold, sl: '4000', slippage: '' }).ok).toBe(false);
    expect(buildPositionTpsl({ ...gold, sl: '4000', slippage: '11' }).ok).toBe(false);
  });
  it.each([
    [0.0061, '4100', '', 'A take profit on a long must be above the price now.'],
    [0.0061, '', '4200', 'A stop loss on a long must be below the price now.'],
    [-0.0061, '4200', '', 'A take profit on a short must be below the price now.'],
    [-0.0061, '', '4100', 'A stop loss on a short must be above the price now.'],
  ])('size %s tp %s sl %s', (size, tp, sl, problem) => {
    expect(buildPositionTpsl({ ...gold, size, tp, sl })).toEqual({ ok: false, problem });
  });
  it('no position, no orders', () => {
    expect(buildPositionTpsl({ ...gold, size: 0, sl: '4000' }).ok).toBe(false);
  });
  it('rounds to a valid price and says so', () => {
    const r = buildPositionTpsl({ ...gold, sl: '3985.123' });
    expect(r.ok && r.legs[0]!.triggerPx).toBe(3985.1);
    expect(r.ok && r.warnings.some((w) => w.includes('rounded to 3985.1'))).toBe(true);
  });
  it('warns when the stop is past the liquidation price', () => {
    const r = buildPositionTpsl({ ...gold, sl: '3950', liquidationPx: 3960 });
    expect(r.ok && r.warnings.some((w) => w.includes('past the liquidation price'))).toBe(true);
  });
});

describe('TP/SL: Hyperliquid’s oracle band', () => {
  it('refuses a price whose worst fill is more than 6% from the oracle, and names the range it accepts', () => {
    const r = buildPositionTpsl({ ...gold, sl: '3700' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem).toMatch(/too far from the price for now/);
    expect(r.problem).toMatch(/accepts wider ones when they're placed; whether it fills beyond about 6% .* isn't tested yet/);
    const band = allowedTriggers(false, 4151, 1);
    expect(r.problem).toContain(String(nearestValidPrice(band.lo, 4)));
    expect(r.problem).toContain(String(nearestValidPrice(band.hi, 4)));
  });
  it('never moves a limit past its trigger to fit the band (a stop that triggers and cannot fill)', () => {
    for (const sl of ['3990', '3960', '3945']) {
      const r = buildPositionTpsl({ ...gold, sl });
      if (r.ok) for (const l of r.legs) expect(l.limitPx).toBeLessThanOrEqual(l.triggerPx);
    }
  });
  it('the accepted range matches the band for both sides', () => {
    const sell = allowedTriggers(false, 100, 1);
    expect(sell.lo * 0.99).toBeCloseTo(100 * (1 - ORACLE_BAND));
    const buy = allowedTriggers(true, 100, 1);
    expect(buy.hi * 1.01).toBeCloseTo(100 * (1 + ORACLE_BAND));
  });
});
