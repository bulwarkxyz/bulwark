import { describe, expect, it } from 'vitest';
import { describeResult, waitForCommand } from '@/lib/commands';

describe('command results in words (GET /v1/commands/:id)', () => {
  it('stop', () => {
    expect(describeResult('stop', { cancelled: 2, error: null })).toBe('The guard cancelled 2 resting orders of its own.');
    expect(describeResult('stop', { cancelled: 0, error: null })).toBe('The guard had no resting orders to cancel.');
    expect(describeResult('stop', { cancelled: 0, error: 'exchange unreachable' })).toMatch(/^Cancelling the guard’s resting orders failed: exchange unreachable\. Any still open stay on Hyperliquid/);
  });
  it('wipe', () => {
    expect(describeResult('wipe', { cancelled: { cancelled: 1, error: null }, wiped: 1 })).toBe('The guard cancelled 1 resting order of its own. 1 key wiped.');
  });
  it('unwind', () => {
    expect(describeResult('unwind', { steps: [{ coin: 'xyz:GOLD', type: 'order', ok: true, error: null }, { coin: 'xyz:CL', type: 'order', ok: false, error: 'min size' }] })).toBe('Sent 2 reduce-only orders: 1 accepted, 1 refused (CL: min size).');
  });
  it('no result yet', () => {
    expect(describeResult('stop', null)).toBe('The guard has not reported a result yet.');
  });
});

describe('waiting for a command', () => {
  it('returns the record once the worker has done it', async () => {
    let n = 0;
    const rec = await waitForCommand(7, { everyMs: 1, timeoutMs: 1000, sleep: async () => {}, get: async (id) => ({ id, command: 'stop', doneAt: ++n >= 3 ? 5 : null, result: { cancelled: 0, error: null } }) });
    expect(rec?.doneAt).toBe(5);
  });
  it('gives up after the timeout', async () => {
    const rec = await waitForCommand(7, { everyMs: 1, timeoutMs: 30, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), get: async (id) => ({ id, command: 'stop', doneAt: null, result: null }) });
    expect(rec).toBeNull();
  });
});
