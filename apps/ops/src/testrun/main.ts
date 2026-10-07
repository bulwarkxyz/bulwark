/**
 * The funded test run, one command per part of reports/B11-runbook.md. The user starts it; it asks before
 * every action. See guard.ts for the limits it enforces.
 *
 *   pnpm --filter @bulwarkxyz/ops testrun part1|part2|part3|part3tight|part4 [--dry-run]
 */
import { Refused } from './guard.js';
import { part1 } from './part1.js';
import { part2 } from './part2.js';
import { part3 } from './part3.js';
import { part3tight } from './part3tight.js';
import { part3multi } from './part3multi.js';
import { part4 } from './part4.js';
import { part5 } from './part5.js';

const [part, ...rest] = process.argv.slice(2);
const dryRun = rest.includes('--dry-run');
const amountArg = rest.indexOf('--amount');
const amount = amountArg >= 0 ? Number(rest[amountArg + 1]) : undefined;

// The owner's advance approval of every step (testnet parts only), quoted into the run log with each plan.
const approvedArg = rest.indexOf('--owner-approved');
const ownerApproved = approvedArg >= 0 ? rest[approvedArg + 1] : undefined;
if (ownerApproved !== undefined && (!ownerApproved || part === 'part1' || (part === 'part5' && !rest.includes('--rehearse')))) {
  console.error('--owner-approved needs a note, and is for the testnet parts only; parts 1 and 5 move real money and always ask.');
  process.exit(2);
}
const approval = ownerApproved ? { ownerApproved } : {};
const flag = (name: string, key: string) => (rest.indexOf(name) >= 0 ? { [key]: rest[rest.indexOf(name) + 1] } : {});

const parts: Record<string, () => Promise<void>> = {
  part1: () => part1({ dryRun, ...(amount !== undefined ? { amount } : {}) }),
  part2: () => part2({ dryRun, ...approval, ...flag('--residency', 'residency'), ...flag('--citizenship', 'citizenship') }),
  part3: () => part3({ dryRun, ...approval }),
  part3tight: () => part3tight({ dryRun, ...approval }),
  part3multi: () => part3multi({ dryRun, ...approval }),
  part4: () => part4({ dryRun, switchMode: !rest.includes('--no-switch'), ...approval }),
  part5: () => part5({ dryRun, rehearse: rest.includes('--rehearse'), ...approval }),
};

const run = part ? parts[part] : undefined;
if (!run) {
  console.error(`Usage: pnpm --filter @bulwarkxyz/ops testrun <${Object.keys(parts).join('|')}> [--dry-run]`);
  process.exit(2);
}
run().catch((e) => {
  if (e instanceof Refused) {
    console.error(`\nRefused: ${e.message}`);
    process.exit(3);
  }
  // Never print anything that could carry key material: errors are reduced to their message.
  console.error(`\nStopped: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  process.exit(1);
});
