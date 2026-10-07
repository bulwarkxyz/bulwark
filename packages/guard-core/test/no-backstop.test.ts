import { describe, expect, it } from 'vitest';
import { planBackstops, whyNoBackstop } from '../src/backstop.js';
import { assessRisk } from '../src/risk.js';
import { policy, standardAccount } from './helpers.js';

// A line standing in for one the user typed.
const p = policy([{ id: 'line', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'alert' }] }]);
const long = (equity: number) => standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: 10, mark: 100 }], crossEquity: equity } }, 0);

describe('why a position has no backstop', () => {
  it('a long with margin at or above its notional-over-maintenance gets none, and says why', () => {
    const big = long(5_000); // $1,000 notional, $5,000 of margin
    expect(planBackstops(p, big, undefined, []).place).toEqual([]);
    const why = whyNoBackstop(p, big, undefined)['xyz:CL']!;
    expect(why.reason).toBe('margin_too_large');
    const pool = assessRisk(big).pools[0]!;
    expect(why.reason === 'margin_too_large' && why.ceiling).toBeCloseTo(pool.positions[0]!.notional / pool.positions[0]!.maintenance, 9);
  });

  it('the ceiling is the boundary: just below it the planner places a backstop, just above it none', () => {
    const row = assessRisk(long(100)).pools[0]!.positions[0]!;
    const ceiling = row.notional / row.maintenance;
    const below = long(row.maintenance * ceiling * 0.98);
    const above = long(row.maintenance * ceiling * 1.02);
    expect(planBackstops(p, below, undefined, []).place.map((t) => t.coin)).toEqual(['xyz:CL']);
    expect(whyNoBackstop(p, below, undefined)).toEqual({});
    expect(planBackstops(p, above, undefined, []).place).toEqual([]);
    expect(whyNoBackstop(p, above, undefined)['xyz:CL']?.reason).toBe('margin_too_large');
  });

  it('a short always gets one; a pool past its line is reported as crossed', () => {
    const short = standardAccount({ xyz: { positions: [{ coin: 'xyz:CL', size: -10, mark: 100 }], crossEquity: 5_000 } }, 0);
    expect(planBackstops(p, short, undefined, []).place.map((t) => t.coin)).toEqual(['xyz:CL']);
    expect(whyNoBackstop(p, short, undefined)).toEqual({});
    const tight = long(5); // buffer below 2
    expect(whyNoBackstop(p, tight, undefined)['xyz:CL']?.reason).toBe('line_crossed');
  });
});
