import type { AuditEntry } from '@bulwarkxyz/store/audit';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WipeConfirm, WipeProgress } from '@/components/app/wipe-confirm';
import { wipeConsequences, wipeEntries, wipeGuardKey, type WipeDeps, type WipeStep } from '@/lib/wipe';

const T0 = Date.UTC(2026, 9, 5, 12, 0);
const entry = (seq: number, at: number, kind: string, what: string): AuditEntry => ({ seq, at, kind, what, why: '', account: '0xabc', hash: `h${seq}`, prevHash: `h${seq - 1}` }) as AuditEntry;

/** A fake API: the worker's entries appear after `afterPolls` polls, as they would after its 2 s loop. */
function fakeApi({ afterPolls = 2, cancelled = 2, kms = true, refuse }: { afterPolls?: number; cancelled?: number | null; kms?: boolean; refuse?: string } = {}) {
  let clock = T0;
  let polls = 0;
  const sent: string[] = [];
  const deps: WipeDeps = {
    send: vi.fn(async () => {
      if (refuse) throw new Error(refuse);
      sent.push('wipe');
      return { id: 41, command: 'wipe' };
    }),
    me: vi.fn(async () => ({ keyStatus: polls >= afterPolls ? 'wiped' : 'ready' })),
    audit: vi.fn(async () => {
      polls++;
      const out = [entry(1, T0 - 60_000, 'key', 'Guard key wiped (an older wipe)'), entry(2, T0 + 10, 'command', 'Guard stopped; stored guard key to be wiped')];
      if (polls >= afterPolls) {
        if (cancelled !== null) out.push(entry(3, T0 + 2_100, 'command', `Cancelled ${cancelled} guard order(s)`));
        out.push(entry(4, T0 + 2_200, 'key', kms ? 'Guard key wiped (1 AWS KMS key no longer used, to be disabled and deleted)' : 'Guard key wiped (1 encrypted key destroyed)'));
        if (kms) out.push(entry(5, T0 + 3_000, 'key', 'AWS KMS key for 0xdef disabled; AWS deletes it after 7 days'));
      }
      return out;
    }),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { deps, sent };
}

describe('wipe: the confirmation step', () => {
  it('says what is destroyed, that orders are cancelled first, that the guard stops, and that it cannot be undone', () => {
    for (const custody of ['kms', 'sealed'] as const) {
      const text = wipeConsequences(custody).join(' ');
      expect(text).toMatch(/guard stops at once/);
      expect(text).toMatch(/First, while your key can still sign, the guard cancels its own resting orders/);
      expect(text).toMatch(/cannot be undone/);
      expect(text).toMatch(/positions and your own orders are not touched/);
    }
    expect(wipeConsequences('kms').join(' ')).toMatch(/AWS KMS stops signing for good and is disabled\. AWS deletes it after 7 days/);
    expect(wipeConsequences('sealed').join(' ')).toMatch(/encrypted key is destroyed on Bulwark’s server/);
    expect(wipeConsequences('sealed').join(' ')).not.toMatch(/KMS/);
  });

  it('orders the steps: stop, cancel first, then destroy, then irreversible', () => {
    const lines = wipeConsequences('kms');
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    expect(at(/stops at once/)).toBeLessThan(at(/cancels its own resting orders/));
    expect(at(/cancels its own resting orders/)).toBeLessThan(at(/disabled/));
    expect(at(/disabled/)).toBeLessThan(at(/cannot be undone/));
  });

  it('keeps the wipe button disabled until the user ticks that they understand', () => {
    const props = { custody: 'kms' as const, busy: false, onAck: () => {}, onConfirm: () => {}, onCancel: () => {} };
    const before = renderToStaticMarkup(<WipeConfirm {...props} ack={false} />);
    const after = renderToStaticMarkup(<WipeConfirm {...props} ack />);
    expect(before).toMatch(/<button type="button" class="btn btn-crit" disabled="">Sign and wipe my guard key<\/button>/);
    expect(after).toMatch(/<button type="button" class="btn btn-crit">Sign and wipe my guard key<\/button>/);
    expect(before).toContain('Wipe your guard key?');
    expect(before).toContain('Keep my key');
    expect(before).toContain('role="alertdialog"');
  });

  it('shows every consequence in the dialog itself', () => {
    const html = renderToStaticMarkup(<WipeConfirm custody="sealed" ack={false} busy={false} onAck={() => {}} onConfirm={() => {}} onCancel={() => {}} />);
    for (const line of wipeConsequences('sealed')) expect(html).toContain(line);
  });
});

describe('wipe: the flow against the API', () => {
  it('sends one signed wipe and reports the API’s own words for each step', async () => {
    const { deps, sent } = fakeApi();
    const steps: WipeStep[] = [];
    const out = await wipeGuardKey(deps, (s) => steps.push(s));
    expect(sent).toEqual(['wipe']);
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(out).toEqual({
      id: 41,
      cancelled: 'Cancelled 2 guard order(s)',
      wiped: 'Guard key wiped (1 AWS KMS key no longer used, to be disabled and deleted)',
      retired: 'AWS KMS key for 0xdef disabled; AWS deletes it after 7 days',
      done: true,
    });
    expect(steps.map((s) => s.step)).toEqual(['accepted', 'cancelled', 'wiped', 'retired']);
  });

  it('ignores entries from before the wipe was sent', async () => {
    const { deps } = fakeApi({ afterPolls: 99 });
    const out = await wipeGuardKey(deps, () => {}, { timeoutMs: 6_000 });
    expect(out.wiped).toBeNull();
    expect(out.done).toBe(false);
  });

  it('works for an encrypted key, with no AWS step', async () => {
    const { deps } = fakeApi({ kms: false });
    const out = await wipeGuardKey(deps);
    expect(out.wiped).toBe('Guard key wiped (1 encrypted key destroyed)');
    expect(out.retired).toBeNull();
    expect(out.done).toBe(true);
  });

  it('stops following after the timeout and says the guard has not confirmed yet', async () => {
    const { deps } = fakeApi({ afterPolls: 99 });
    const out = await wipeGuardKey(deps, () => {}, { timeoutMs: 10_000, everyMs: 2_000 });
    expect(deps.audit).toHaveBeenCalledTimes(5);
    const html = renderToStaticMarkup(<WipeProgress steps={[{ step: 'accepted', id: out.id }]} done={out.done} timedOut />);
    expect(html).toContain('Wipe command accepted (#41). The guard is stopped.');
    expect(html).toContain('hasn’t confirmed the wipe yet');
  });

  it('when nothing was resting, says so instead of inventing a cancellation', async () => {
    const { deps } = fakeApi({ cancelled: null, kms: false });
    const steps: WipeStep[] = [];
    const out = await wipeGuardKey(deps, (s) => steps.push(s));
    expect(out.cancelled).toBeNull();
    const html = renderToStaticMarkup(<WipeProgress steps={steps} done={out.done} timedOut={false} />);
    expect(html).toContain('the guard had no resting orders to cancel');
    expect(html).toContain('Guard key wiped (1 encrypted key destroyed).');
  });

  it('throws when the command is refused, and follows nothing', async () => {
    const { deps } = fakeApi({ refuse: 'signature does not match' });
    await expect(wipeGuardKey(deps)).rejects.toThrow('signature does not match');
    expect(deps.audit).not.toHaveBeenCalled();
  });
});

describe('wipe: reading the audit log', () => {
  it('matches the worker’s and the API’s entries exactly as they are written', () => {
    const got = wipeEntries(
      [
        entry(9, T0, 'command', 'Cancelled 0 guard order(s): exchange timeout'),
        entry(10, T0, 'key', 'No stored guard key to wipe'),
        entry(11, T0, 'command', 'Kill switch on'),
      ],
      T0 - 1,
    );
    expect(got).toEqual({ cancelled: 'Cancelled 0 guard order(s): exchange timeout', wiped: 'No stored guard key to wipe', retired: null });
  });
});

describe('wipe: the texts it waits for are the ones the worker and API write', () => {
  // If the other side rewords an entry, this fails here instead of the card waiting forever.
  const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  it('worker: cancel and wipe entries; API: KMS retirement and the wipe command', () => {
    expect(src('worker/src/guard.ts')).toContain('what: `Cancelled ${mine.length} guard order(s)');
    expect(src('worker/src/keys.ts')).toContain("what: n ? `Guard key wiped (${parts.join('; ')})` : 'No stored guard key to wipe'");
    expect(src('api/src/app.ts')).toContain('what: `AWS KMS key for ${k.address} disabled; AWS deletes it after 7 days`');
    expect(src('api/src/app.ts')).toContain("['unwind', 'stop', 'resume', 'wipe'].includes(body.command)");
    expect(src('worker/src/main.ts')).toMatch(/Cancel the guard's own orders while the key still exists, then destroy the key/);
  });
});
