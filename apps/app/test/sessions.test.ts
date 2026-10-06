import { describe, expect, it } from 'vitest';
import { homeOpen, nextChange, type SessionKind } from '../lib/markets';

// The scan the fast version replaced: minute by minute, up to 4 days.
function slowNextChange(kind: SessionKind, t: number): number | null {
  const now = homeOpen(kind, t);
  let cur = Math.ceil(t / 60_000) * 60_000;
  for (let i = 0; i < 4 * 24 * 60; i++, cur += 60_000) if (homeOpen(kind, cur) !== now) return cur;
  return null;
}

const KINDS: SessionKind[] = ['usStocks', 'futures', 'futuresBrent', 'korea'];

describe('nextChange', () => {
  it('matches the minute-by-minute scan across a year, including both daylight-saving changes', () => {
    const start = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 160; i++) {
      // Spread over the year, with odd seconds so the start is never on a boundary.
      const t = start + i * 2.3 * 86_400_000 + i * 7_919_000 + 13_000;
      for (const k of KINDS) expect(nextChange(k, t), `${k} at ${new Date(t).toISOString()}`).toBe(slowNextChange(k, t));
    }
    // The reference scan is slow on purpose (minute by minute); give it room on a busy machine.
  }, 30_000);

  it('is exact on the boundary itself', () => {
    // Monday 9 March 2026, 09:00 KST = 00:00 UTC: KRX opens.
    const open = Date.UTC(2026, 2, 9, 0, 0);
    expect(homeOpen('korea', open)).toBe(true);
    expect(homeOpen('korea', open - 1)).toBe(false);
    expect(nextChange('korea', open - 1)).toBe(open);
    expect(nextChange('korea', open)).toBe(Date.UTC(2026, 2, 9, 6, 30));
  });

  it('runs every market label for a whole minute of one-second ticks quickly', () => {
    const t0 = Date.UTC(2026, 9, 6, 12, 0, 0);
    const began = performance.now();
    for (let s = 0; s < 60; s++) for (const k of KINDS) for (let m = 0; m < 4; m++) nextChange(k, t0 + s * 1000);
    expect(performance.now() - began).toBeLessThan(200);
  });
});
