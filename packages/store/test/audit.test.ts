import { describe, expect, it } from 'vitest';
import { MemoryAuditStore, verifyChain } from '../src/audit.js';

const A = '0x9959260F1aA229F8A70E0C495ca9b251106C1A86';

describe('audit chain', () => {
  it('chains entries per account and verifies', async () => {
    const s = new MemoryAuditStore();
    await s.append({ account: A, at: 1, kind: 'rule_confirmed', why: 'You confirmed', what: 'weekend limit v1' });
    await s.append({ account: A, at: 2, kind: 'guard_action', why: 'buffer 1.98× below your 2× line', what: 'reduced CL 40 → 30', proof: { oid: 1 } });
    await s.append({ account: '0xother', at: 3, kind: 'alert', why: 'x', what: 'y' });
    expect(verifyChain(s.raw(A))).toBeNull();
    expect(s.raw(A).map((e) => e.seq)).toEqual([1, 2]);
    expect(s.raw(A)[1]!.prevHash).toBe(s.raw(A)[0]!.hash);
  });

  it('detects an edited entry', async () => {
    const s = new MemoryAuditStore();
    for (let i = 0; i < 5; i++) await s.append({ account: A, at: i, kind: 'alert', why: 'w', what: `m${i}` });
    const chain = s.raw(A);
    chain[2] = { ...chain[2]!, what: 'edited' };
    expect(verifyChain(chain)).toBe(3);
  });

  it('detects a deleted entry', async () => {
    const s = new MemoryAuditStore();
    for (let i = 0; i < 5; i++) await s.append({ account: A, at: i, kind: 'alert', why: 'w', what: `m${i}` });
    const chain = s.raw(A).filter((e) => e.seq !== 2);
    expect(verifyChain(chain)).toBe(3);
  });
});

describe('a database belongs to one network (mainnet prerequisites)', () => {
  it('the first service stamps it; a service for the other network refuses to start against it', async () => {
    const { MemoryStore, stampNetwork } = await import('../src/store.js');
    const store = new MemoryStore();
    await stampNetwork(store, 'testnet', 1);
    await stampNetwork(store, 'testnet', 2);
    await expect(stampNetwork(store, 'mainnet', 3)).rejects.toThrow(/belongs to testnet/);
  });
});
