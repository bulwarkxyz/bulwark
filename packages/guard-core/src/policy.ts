import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { FIXED_WINDOWS } from './windows.js';

/**
 * Guard policy: what the plain-language layer compiles to and what the evaluator runs.
 * Every number in a policy is one the user typed (decision D5); the schema carries no defaults.
 */

const Market = z.string().min(1).describe('Coin as the API names it, e.g. "xyz:CL" or "BTC".');

export const Target = z.union([
  z.object({ kind: z.literal('first_position') }).describe('Position using the most maintenance margin in the pool; ties → worst unrealised PnL.'),
  z.object({ kind: z.literal('worst_pnl') }),
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('market'), market: Market }),
]);
export type Target = z.infer<typeof Target>;

export const Action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reduce'), target: Target, fraction: z.number().gt(0).lte(1) }),
  z.object({ kind: z.literal('close'), target: Target }),
  z.object({ kind: z.literal('reduceToBuffer'), buffer: z.number().gt(1) }).describe('Trim the pool until its buffer is back at this line.'),
  z.object({ kind: z.literal('reduceToLeverage'), market: Market, leverage: z.number().gt(0) }),
  z.object({ kind: z.literal('topUp'), maxUsdc: z.number().gt(0) }),
  z.object({ kind: z.literal('cancelOpeningOrders') }),
  z.object({ kind: z.literal('alert') }),
]);
export type Action = z.infer<typeof Action>;

export const Trigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('buffer'), below: z.number().gt(1) }).describe('Pool buffer (equity ÷ maintenance) below this line.'),
  z.object({ kind: z.literal('drawdown'), atLeastPct: z.number().gt(0).lt(100), baseline: z.enum(['window_start', 'rule_confirmed']) }),
  z.object({
    kind: z.literal('priceMove'),
    market: Market,
    direction: z.enum(['down', 'up']),
    movePct: z.number().gt(0).lt(100),
    from: z.enum(['window_start', 'rule_confirmed']),
  }),
  z.object({ kind: z.literal('leverageAbove'), market: Market, leverage: z.number().gt(0) }),
]);
export type Trigger = z.infer<typeof Trigger>;

const windowNames = Object.keys(FIXED_WINDOWS) as [keyof typeof FIXED_WINDOWS, ...Array<keyof typeof FIXED_WINDOWS>];

export const Rule = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,48}$/),
  /** The sentence the user typed, when the rule came from the plain-language layer. */
  source: z.object({ text: z.string().max(500), compiler: z.string() }).optional(),
  window: z.enum(windowNames).optional(),
  when: Trigger,
  then: z.array(Action).min(1).max(6),
});
export type Rule = z.infer<typeof Rule>;

export const Execution = z.object({
  /** Max distance from mark for a guard IOC order, in percent. Typed by the user. */
  maxSlippagePct: z.number().gt(0).lte(10),
});
export type Execution = z.infer<typeof Execution>;

export const Policy = z.object({
  version: z.number().int().positive(),
  account: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  rules: z.array(Rule).max(32),
  execution: Execution,
});
export type Policy = z.infer<typeof Policy>;

/** JSON Schema for structured output from the plain-language layer (a single rule). */
export const ruleJsonSchema = (): unknown => z.toJSONSchema(Rule);

/** Deterministic JSON: sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/** keccak256 of the canonical JSON, 0x-prefixed. This is what the user signs to confirm a policy. */
export function policyHash(policy: Policy): `0x${string}` {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(canonicalJson(Policy.parse(policy)))))}`;
}

/**
 * EIP-712 typed data the user's wallet signs to confirm a policy version (stored as their
 * "specific authorization" for every guard action under it).
 */
export const POLICY_CONFIRMATION_TYPES = {
  BulwarkPolicy: [
    { name: 'account', type: 'address' },
    { name: 'version', type: 'uint64' },
    { name: 'policyHash', type: 'bytes32' },
  ],
} as const;

export function policyConfirmationDomain(chainId: number) {
  return { name: 'Bulwark', version: '1', chainId } as const;
}

/**
 * EIP-712 typed data for the user's direct commands (panic unwind, kill switch, resume).
 * `minutes` is 0 for commands that take none.
 */
export const COMMAND_TYPES = {
  BulwarkCommand: [
    { name: 'account', type: 'address' },
    { name: 'command', type: 'string' },
    { name: 'minutes', type: 'uint32' },
    { name: 'issuedAt', type: 'uint64' },
  ],
} as const;

export type CommandName = 'unwind' | 'stop' | 'resume';

/** Ordered stage lines (buffer triggers) for display and validation: must be strictly decreasing. */
export function stageLines(policy: Policy): number[] {
  return policy.rules
    .filter((r): r is Rule & { when: { kind: 'buffer'; below: number } } => r.when.kind === 'buffer')
    .map((r) => r.when.below)
    .sort((a, b) => b - a);
}
