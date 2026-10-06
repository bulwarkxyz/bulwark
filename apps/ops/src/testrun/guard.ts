/**
 * Safety rails for the funded test run (reports/B11-runbook.md). The user starts each part; nothing here
 * runs on its own. Every action is described in plain words, with its amount and the limit, and runs
 * only after the user types "yes". The run refuses:
 *  - any wallet other than the one test wallet (the key must derive to WALLET);
 *  - any real-money outflow that would take the total above LIMIT_USDC;
 *  - any destination other than the Hyperliquid bridge (deposits) or the wallet itself (withdrawals, transfers).
 * The private key is read from this Mac's Keychain at run time, kept in memory, and never printed or logged.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

/** The one funded test wallet (standard mode first, then unified). */
export const WALLET = getAddress('0x9959260F1aA229F8A70E0C495ca9b251106C1A86');
/** Keychain item that holds its key (set up in block D6; see apps/ops/src/lib.ts). */
export const KEYCHAIN = { service: 'bulwark-test-standard', account: 'bulwark' } as const;
/** All real money the run may move out of the wallet, in USDC. */
export const LIMIT_USDC = 13;
/** Hyperliquid's bridge on Arbitrum One: native USDC sent here is credited to the sender (minimum 5 USDC). */
export const BRIDGE = getAddress('0x2df1c51e09aecf9cacb7bc98cb1742757f163df7');
export const MIN_DEPOSIT_USDC = 5;
/** Native USDC on Arbitrum One (6 decimals). */
export const USDC_ARBITRUM = getAddress('0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
export const ARBITRUM_CHAIN_ID = 42161;

/** Where the run log and the spend ledger live (private evidence folder, outside the public repo). */
export const RUN_DIR = new URL('../../../../../phase1-evidence/test-run-2026-10/', import.meta.url);

export class Refused extends Error {}

/** Reads the key from the Keychain and returns the account, refusing any key that isn't the test wallet's. */
export function loadWallet(read: () => string = () => execFileSync('security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w']).toString().trim()): PrivateKeyAccount {
  let key: string;
  try {
    key = read();
  } catch {
    throw new Refused(`The test wallet's key is not in this Mac's Keychain (service "${KEYCHAIN.service}", account "${KEYCHAIN.account}").`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Refused(`The Keychain item "${KEYCHAIN.service}" does not hold a private key.`);
  const account = privateKeyToAccount(key as Hex);
  if (getAddress(account.address) !== WALLET) throw new Refused(`The Keychain key belongs to ${account.address}, not the test wallet ${WALLET}. Nothing was done.`);
  return account;
}

/** Real money moved out of the wallet so far, across every part of the run. */
export class Ledger {
  constructor(private readonly file = new URL('ledger.json', RUN_DIR)) {}
  private read(): { spentUsdc: number; entries: Array<{ at: string; what: string; usdc: number; ref: string }> } {
    return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { spentUsdc: 0, entries: [] };
  }
  spent(): number {
    return this.read().spentUsdc;
  }
  remaining(): number {
    return Math.max(0, +(LIMIT_USDC - this.spent()).toFixed(6));
  }
  /** Throws unless `usdc` fits inside what is left of the limit. */
  check(usdc: number): void {
    if (!(usdc > 0)) throw new Refused(`Amount must be above 0 (got ${usdc}).`);
    if (usdc > this.remaining() + 1e-9) throw new Refused(`${usdc} USDC is above what is left of the ${LIMIT_USDC} USDC limit (${this.remaining()} left). Nothing was done.`);
  }
  add(what: string, usdc: number, ref: string): void {
    const d = this.read();
    d.spentUsdc = +(d.spentUsdc + usdc).toFixed(6);
    d.entries.push({ at: new Date().toISOString(), what, usdc, ref });
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(this.file, JSON.stringify(d, null, 1));
  }
}

/** Append-only run log: every transaction hash, order id and result, one JSON object per line. Never a key. */
export class RunLog {
  constructor(
    readonly part: string,
    private readonly file = new URL('run-log.jsonl', RUN_DIR),
  ) {}
  write(step: string, data: Record<string, unknown>): void {
    mkdirSync(RUN_DIR, { recursive: true });
    appendFileSync(this.file, `${JSON.stringify({ at: new Date().toISOString(), part: this.part, step, ...data })}\n`);
  }
}

/** Destinations the run may send to: the bridge for deposits, the wallet itself for everything else. */
export function checkDestination(kind: 'deposit' | 'self', to: string): void {
  const want = kind === 'deposit' ? BRIDGE : WALLET;
  if (getAddress(to) !== want) throw new Refused(`Destination ${to} is not ${kind === 'deposit' ? 'the Hyperliquid bridge' : 'the test wallet itself'}. Nothing was done.`);
}

export interface Plan {
  /** One plain sentence: what will happen. */
  what: string;
  /** The exact amount, in words with units. */
  amount: string;
  /** The limit it stays within, in words. */
  limit: string;
  /** Anything else worth knowing before typing yes. */
  notes?: string[];
}

/** Shows the plan and waits for the user to type exactly "yes". Refuses when there is no person at a terminal. */
export async function confirm(plan: Plan, io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; isTTY: boolean } = { input: process.stdin, output: process.stdout, isTTY: Boolean(process.stdin.isTTY) }): Promise<boolean> {
  if (!io.isTTY) throw new Refused('This step needs a person to type "yes" at a terminal; it will not run from a script or a pipe.');
  const lines = ['', `  What:   ${plan.what}`, `  Amount: ${plan.amount}`, `  Limit:  ${plan.limit}`, ...(plan.notes ?? []).map((n) => `          ${n}`), ''];
  io.output.write(`${lines.join('\n')}\n`);
  const rl = createInterface({ input: io.input, output: io.output });
  const answer = (await rl.question('  Type yes to do this, anything else to stop: ')).trim();
  rl.close();
  return answer === 'yes';
}

export const usdc = (n: number) => `${n.toFixed(2)} USDC`;
