/**
 * Testnet only: sign the test wallet's current rules again, unchanged, as the next version. Rules signed before
 * 8 Oct 2026 did not name the network; the guard pauses them as resign_required until they are signed again.
 *
 *   pnpm --filter @bulwarkxyz/ops testrun resign
 */
import type { Policy } from '@bulwarkxyz/guard-core';
import { RunLog, loadWallet } from './guard.js';
import { Session } from './session.js';

export async function resign(): Promise<void> {
  const log = new RunLog('resign');
  const s = new Session(log, loadWallet());
  await s.signIn();
  const me = (await s.api<{ policy: { policy: Policy; needsResign?: boolean } | null }>('/v1/me')).body;
  if (!me.policy) return void console.log('no rules to sign again');
  console.log(`version ${me.policy.policy.version}, needs a new signature: ${me.policy.needsResign ?? false}`);
  const next = { ...me.policy.policy, version: me.policy.policy.version + 1 };
  const res = await s.signPolicy(next);
  console.log(`signed as version ${next.version}: HTTP ${res.status}`);
  const after = (await s.api<{ policy: { needsResign?: boolean } | null }>('/v1/me')).body;
  console.log(`needs a new signature now: ${after.policy?.needsResign ?? false}`);
}
