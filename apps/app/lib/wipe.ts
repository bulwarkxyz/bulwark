/**
 * Wiping the guard key: a command the user signs in their wallet (POST /v1/commands, command "wipe").
 * The API turns the kill switch on at once and queues the command; the worker then cancels the guard's
 * own resting orders while the key can still sign, and destroys the key (an encrypted key is destroyed;
 * a KMS key stops signing and is disabled, and AWS deletes it after 7 days). Each step lands in the
 * audit log. There is no endpoint for the command's result, so the app follows /v1/me (keyStatus) and
 * the audit log, and shows what they say.
 */
import type { AuditEntry } from '@bulwarkxyz/store/audit';

export type Custody = 'sealed' | 'kms';

/** What the confirmation step says, in order. Every line is true for the custody given. */
export function wipeConsequences(custody: Custody): string[] {
  return [
    'The guard stops at once. It will not act on any position until you set up a new key and resume.',
    'First, while your key can still sign, the guard cancels its own resting orders on Hyperliquid. Your positions and your own orders are not touched.',
    custody === 'kms'
      ? 'Then your key in AWS KMS stops signing for good and is disabled. AWS deletes it after 7 days.'
      : 'Then your encrypted key is destroyed on Bulwark’s server.',
    'This cannot be undone. To use the guard again you create a new key and approve it on Hyperliquid.',
    'The approval on Hyperliquid stays until it expires or you approve a different key under the same name. It cannot sign anything once the key is wiped.',
  ];
}

export interface WipeDeps {
  /** Signs the "wipe" command in the wallet and posts it; resolves with the API's answer. */
  send: () => Promise<{ id: number | null; command: string }>;
  me: () => Promise<{ keyStatus: string } | null>;
  audit: () => Promise<AuditEntry[]>;
  /** The command's own result (GET /v1/commands/:id), when the API has it. */
  result?: (id: number) => Promise<{ doneAt: number | null; result: Record<string, unknown> | null } | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type WipeStep =
  | { step: 'accepted'; id: number | null }
  | { step: 'cancelled'; text: string }
  | { step: 'wiped'; text: string }
  | { step: 'retired'; text: string };

export interface WipeOutcome {
  /** The API's answer to the signed command. */
  id: number | null;
  /** The worker's audit entry for cancelling the guard's orders, word for word, if it arrived. */
  cancelled: string | null;
  /** The worker's audit entry for the key, word for word, if it arrived. */
  wiped: string | null;
  /** The API's entry for disabling a KMS key in AWS, if it arrived in time. */
  retired: string | null;
  /** /v1/me reports the key as wiped. */
  done: boolean;
}

/** Entries the worker writes for a wipe, newest first, from `since` on. */
export function wipeEntries(entries: readonly AuditEntry[], since: number): { cancelled: string | null; wiped: string | null; retired: string | null } {
  const recent = [...entries].filter((e) => e.at >= since).sort((a, b) => b.seq - a.seq);
  const cancelled = recent.find((e) => e.kind === 'command' && /^Cancelled \d+ guard order/.test(e.what));
  const wiped = recent.find((e) => e.kind === 'key' && /^(Guard key wiped|No stored guard key to wipe)/.test(e.what));
  // KMS keys: the API disables the key in AWS shortly after (apps/api retireKmsKeys).
  const retired = recent.find((e) => e.kind === 'key' && /^AWS KMS key for .* disabled/.test(e.what));
  return { cancelled: cancelled?.what ?? null, wiped: wiped?.what ?? null, retired: retired?.what ?? null };
}

/**
 * Sends the signed wipe, then follows the API until the key is reported wiped (or `timeoutMs` passes;
 * the worker picks commands up every 2 s). Throws only if the command itself is refused.
 */
export async function wipeGuardKey(deps: WipeDeps, onStep: (s: WipeStep) => void = () => {}, { timeoutMs = 60_000, everyMs = 2_000 } = {}): Promise<WipeOutcome> {
  const since = deps.now() - 1_000;
  const res = await deps.send();
  onStep({ step: 'accepted', id: res.id });
  const out: WipeOutcome = { id: res.id, cancelled: null, wiped: null, retired: null, done: false };
  const until = deps.now() + timeoutMs;
  while (deps.now() < until) {
    await deps.sleep(everyMs);
    const [me, entries, rec] = await Promise.all([
      deps.me().catch(() => null),
      deps.audit().catch(() => [] as AuditEntry[]),
      res.id !== null && deps.result ? deps.result(res.id).catch(() => null) : Promise.resolve(null),
    ]);
    const seen = wipeEntries(entries, since);
    // The command's own result, once the worker has carried it out, is the first source; the audit entries
    // (same facts, same words) remain the fallback and carry the later AWS step.
    if (rec?.doneAt && rec.result) {
      const c = (rec.result.cancelled ?? {}) as { cancelled?: number; error?: string | null };
      const keys = Number(rec.result.wiped ?? 0);
      seen.cancelled ??= c.error ? `Cancelled ${c.cancelled ?? 0} guard order(s): ${c.error}` : c.cancelled ? `Cancelled ${c.cancelled} guard order(s)` : null;
      seen.wiped ??= keys ? `Guard key wiped (${keys} key${keys > 1 ? 's' : ''})` : 'No stored guard key to wipe';
    }
    if (seen.cancelled && !out.cancelled) onStep({ step: 'cancelled', text: seen.cancelled });
    if (seen.wiped && !out.wiped) onStep({ step: 'wiped', text: seen.wiped });
    if (seen.retired && !out.retired) onStep({ step: 'retired', text: seen.retired });
    out.cancelled = seen.cancelled ?? out.cancelled;
    out.wiped = seen.wiped ?? out.wiped;
    out.retired = seen.retired ?? out.retired;
    out.done = me?.keyStatus === 'wiped';
    if (out.done && out.wiped) break;
  }
  return out;
}
