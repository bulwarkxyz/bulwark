/**
 * Testnet only, nothing traded: the signed-command path end to end on the live API and worker (security review F3 and
 * F5, 8 Oct 2026). Stop, wait for the worker's result, resume, wait again; then the same signed resume again, which
 * must be refused. The kill switch is on for a few seconds; backstops stay on Hyperliquid throughout.
 *
 *   pnpm --filter @bulwarkxyz/ops testrun commands-check --owner-approved "note"
 */
import { RunLog, approveTestnetStepsInAdvance, loadWallet } from './guard.js';
import { Session } from './session.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function commandsCheck(opts: { ownerApproved?: string }): Promise<void> {
  if (!opts.ownerApproved) throw new Error('commands-check flips the test wallet\'s kill switch for a few seconds: pass --owner-approved "note"');
  const log = new RunLog('commands-check');
  approveTestnetStepsInAdvance(opts.ownerApproved, log);
  const s = new Session(log, loadWallet());
  await s.signIn();
  const result = async (id: number) => {
    for (let i = 0; i < 30; i++) {
      const r = (await s.api<{ doneAt: number | null; result: Record<string, unknown> | null }>(`/v1/commands/${id}`)).body;
      if (r.doneAt) return r.result;
      await sleep(1000);
    }
    return 'no result in 30 s';
  };
  for (const cmd of ['stop', 'resume'] as const) {
    const issuedAt = Date.now();
    const r = await s.command(cmd, 0, issuedAt);
    console.log(`${cmd}: HTTP ${r.status}${r.body.error ? ` ${r.body.error}` : ''}`);
    if (r.status !== 200) return;
    console.log(`  worker: ${JSON.stringify(typeof r.body.id === 'number' ? await result(r.body.id) : 'recorded, no worker step')}`);
    if (cmd === 'resume') {
      const again = await s.resend('resume', issuedAt, r.signature);
      console.log(`the same signed resume again: HTTP ${again.status} ${again.body.error ?? ''}`);
    }
  }
  const me = (await s.api<{ killSwitch?: boolean }>('/v1/me')).body;
  console.log(`kill switch now: ${me.killSwitch ?? '(not in /v1/me)'}`);
}
