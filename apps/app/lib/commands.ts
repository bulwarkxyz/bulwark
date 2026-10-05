'use client';

import type { CommandName } from '@bulwarkxyz/guard-core';
import type { Hex } from '@bulwarkxyz/hyperliquid';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, useChainId, useSignTypedData } from 'wagmi';
import { api } from './api';
import { signCommand, type SignTypedData } from './signing';

/** Signs a Bulwark command (stop, resume, unwind) in the user's wallet and sends it to the API. */
export function useCommand() {
  const { address } = useAccount();
  const chainId = useChainId();
  const { signTypedDataAsync } = useSignTypedData();
  const qc = useQueryClient();
  return async (command: CommandName, minutes = 0) => {
    if (!address) throw new Error('connect a wallet first');
    const issuedAt = Date.now();
    const signature = await signCommand(signTypedDataAsync as unknown as SignTypedData, chainId, address.toLowerCase() as Hex, command, minutes, issuedAt);
    const res = await api<{ id: number | null; command: CommandName }>('/v1/commands', { body: { command, minutes, issuedAt, signature, chainId } });
    await qc.invalidateQueries({ queryKey: ['me'] });
    return res;
  };
}

/** A command as the API records it (GET /v1/commands/:id, apps/api/CONTRACT.md). */
export interface CommandRecord {
  id: number;
  command: CommandName;
  doneAt: number | null;
  result: Record<string, unknown> | null;
}

/**
 * Follows a queued command until the worker has carried it out (`doneAt`), about 2 s after it is sent.
 * Resolves with the record, or null if it hasn't finished within `timeoutMs`.
 */
export async function waitForCommand(
  id: number,
  { timeoutMs = 20_000, everyMs = 1_000, get = (i: number) => api<CommandRecord>(`/v1/commands/${i}`), sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<CommandRecord | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(everyMs);
    const rec = await get(id).catch(() => null);
    if (rec?.doneAt) return rec;
  }
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The worker's result in words, from the fields the contract lists for each command. */
export function describeResult(command: CommandName, result: Record<string, unknown> | null): string {
  if (!result) return 'The guard has not reported a result yet.';
  if (command === 'stop') {
    const n = Number(result.cancelled ?? 0);
    const err = typeof result.error === 'string' && result.error ? result.error : null;
    if (err) return `Cancelling the guard’s resting orders failed: ${err}. Any still open stay on Hyperliquid as reduce-only stops until you cancel them.`;
    return n ? `The guard cancelled ${plural(n, 'resting order')} of its own.` : 'The guard had no resting orders to cancel.';
  }
  if (command === 'wipe') {
    const c = (result.cancelled ?? {}) as { cancelled?: number; error?: string | null };
    const keys = Number(result.wiped ?? 0);
    const first = c.error ? `Cancelling the guard’s resting orders failed: ${c.error}.` : c.cancelled ? `The guard cancelled ${plural(Number(c.cancelled), 'resting order')} of its own.` : 'The guard had no resting orders to cancel.';
    return `${first} ${keys ? `${plural(keys, 'key')} wiped.` : 'No stored key was left to wipe.'}`;
  }
  if (command === 'unwind') {
    const steps = (result.steps ?? []) as Array<{ coin: string; ok: boolean; error: string | null }>;
    if (!steps.length) return typeof result.error === 'string' ? `The unwind did not start: ${result.error}.` : 'No positions to close.';
    const failed = steps.filter((s) => !s.ok);
    return `Sent ${plural(steps.length, 'reduce-only order')}: ${steps.length - failed.length} accepted${failed.length ? `, ${failed.length} refused (${failed.map((f) => `${f.coin.replace(/^[a-z]+:/, '')}: ${f.error ?? 'refused'}`).join('; ')})` : ''}.`;
  }
  return 'Done.';
}
