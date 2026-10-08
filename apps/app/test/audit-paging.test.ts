import type { AuditEntry } from '@bulwarkxyz/store/audit';
import { describe, expect, it } from 'vitest';
import { fetchAudit } from '@/lib/audit';

// Security review F8 (8 Oct 2026): the app read only the newest 500 entries, so a log longer than that was never checked.
const chain = (n: number) => Array.from({ length: n }, (_, i) => ({ seq: n - i }) as AuditEntry);
const server = (n: number) => {
  const all = chain(n);
  const asked: string[] = [];
  const get = async (path: string) => {
    asked.push(path);
    const before = Number(new URL(path, 'https://x').searchParams.get('before') ?? Infinity);
    return all.filter((e) => e.seq < before).slice(0, 500);
  };
  return { get, asked };
};

describe('reading the whole audit chain (F8)', () => {
  it('pages back with `before` until entry #1', async () => {
    const s = server(1234);
    const got = await fetchAudit(40, s.get);
    expect(got).toHaveLength(1234);
    expect(got.at(-1)!.seq).toBe(1);
    expect(s.asked).toEqual(['/v1/audit?limit=500', '/v1/audit?limit=500&before=735', '/v1/audit?limit=500&before=235']);
  });
  it('stops at the page limit, so the page says the chain was not checked from the start', async () => {
    const got = await fetchAudit(2, server(1234).get);
    expect(got).toHaveLength(1000);
    expect(got.some((e) => e.seq === 1)).toBe(false);
  });
  it('one page for the guard panel', async () => {
    const s = server(600);
    expect(await fetchAudit(1, s.get)).toHaveLength(500);
    expect(s.asked).toHaveLength(1);
  });
});
