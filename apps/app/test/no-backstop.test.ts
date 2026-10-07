import { describe, expect, it } from 'vitest';
import { NO_BACKSTOP_LINE, marginTooLarge, noBackstopText } from '../lib/guard';

describe('no backstop needed (wording from the guard session)', () => {
  it('one line for the table and chart', () => {
    expect(NO_BACKSTOP_LINE).toBe('No backstop needed: a fall can’t bring this pool to your line');
  });
  it('the full reason, rounded: whole numbers above 10, one decimal otherwise', () => {
    const t = noBackstopText({ reason: 'margin_too_large', line: 1.8, buffer: 1999.4, ceiling: 49.6 });
    expect(t).toContain('(buffer 1,999×, above 50×)');
    expect(t).toContain('drops below 50×');
    expect(noBackstopText({ reason: 'margin_too_large', line: 1.8, buffer: 9.44, ceiling: 8.04 })).toContain('(buffer 9.4×, above 8.0×)');
  });
  it('only the margin case: a crossed line keeps its own wording', () => {
    const g = { noBackstop: { 'xyz:GOLD': { reason: 'line_crossed' as const, line: 2, buffer: 1.9 }, 'xyz:SILVER': { reason: 'margin_too_large' as const, line: 1.8, buffer: 80, ceiling: 50 } } };
    expect(marginTooLarge(g, 'xyz:GOLD')).toBeNull();
    expect(marginTooLarge(g, 'xyz:SILVER')?.ceiling).toBe(50);
    expect(marginTooLarge(g, 'xyz:NVDA')).toBeNull();
  });
});
