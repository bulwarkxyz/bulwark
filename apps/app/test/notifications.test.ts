import type { AuditEntry } from '@bulwarkxyz/store/audit';
import { describe, expect, it } from 'vitest';
import { badge, classify, isRead, markAll, markOne, rangeStart } from '../lib/notifications';

const entry = (o: Partial<AuditEntry> & Pick<AuditEntry, 'kind'>): AuditEntry => ({ account: '0xabc', seq: 7, at: 1000, why: 'why', what: 'what', hash: '0x1', prevHash: '0x0', ...o }) as AuditEntry;

describe('classify', () => {
  it('liquidations link to the position', () => {
    const n = classify(entry({ kind: 'alert', why: 'Liquidation reported by the exchange', proof: { fill: { coin: 'xyz:GOLD', sz: '0.1' } } }));
    expect(n.type).toBe('liquidation');
    expect(n.href).toBe('/app/positions?coin=xyz%3AGOLD');
    expect(n.hrefLabel).toBe('GOLD in Positions');
  });
  it('a stage that needs a choice links to that rule', () => {
    const n = classify(entry({ kind: 'alert', why: 'A new setting needs your choice', proof: { ruleIds: ['r2', 'r3'], policyVersion: 4 } }));
    expect(n.type).toBe('choice');
    expect(n.href).toBe('/app/rules#rule-r2');
  });
  it('an alert rule links to the rule', () => {
    const n = classify(entry({ kind: 'alert', proof: { ruleId: 'r1' } }));
    expect(n).toMatchObject({ type: 'alert', href: '/app/rules#rule-r1', hrefLabel: 'The rule' });
  });
  it('held off and anything else link to the audit entry', () => {
    expect(classify(entry({ kind: 'degraded' }))).toMatchObject({ type: 'heldOff', href: '/app/audit?seq=7' });
    expect(classify(entry({ kind: 'alert' }))).toMatchObject({ type: 'alert', href: '/app/audit?seq=7' });
  });
  it('always carries the audit entry', () => {
    expect(classify(entry({ kind: 'alert', proof: { ruleId: 'r1' } })).auditHref).toBe('/app/audit?seq=7');
  });
});

describe('read state', () => {
  const items = [{ at: 300, seq: 3 }, { at: 200, seq: 2 }, { at: 100, seq: 1 }];
  it('marks one, then all', () => {
    let r = { upTo: 0, seqs: [] as number[] };
    r = markOne(r, 2);
    expect(items.filter((n) => !isRead(n, r)).map((n) => n.seq)).toEqual([3, 1]);
    r = markAll(items, r);
    expect(items.every((n) => isRead(n, r))).toBe(true);
    expect(r.seqs).toEqual([]);
  });
  it('a newer alert is unread again after mark all', () => {
    const r = markAll(items, { upTo: 0, seqs: [] });
    expect(isRead({ at: 301, seq: 4 }, r)).toBe(false);
  });
});

describe('badge and ranges', () => {
  it('caps the badge at 99+', () => {
    expect(badge(7)).toBe('7');
    expect(badge(120)).toBe('99+');
  });
  it('ranges start where they say', () => {
    const now = Date.UTC(2026, 9, 6, 15);
    expect(rangeStart('all', now)).toBeNull();
    expect(rangeStart('7d', now)).toBe(now - 7 * 86_400_000);
    expect(rangeStart('today', now)! <= now).toBe(true);
  });
});
