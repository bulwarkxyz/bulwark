import { isBuilderRejection, type AssetIndex, type GuardAction, type Violation } from '@bulwarkxyz/guard-core';
import type { BuilderWire, ExchangeResult, Hex, L1Action, Network, NonceManager, SignedRequest, Signature } from '@bulwarkxyz/hyperliquid';
import { randomBytes } from 'node:crypto';
import { GuardedSigner, InvariantViolation, type GuardCheck } from './guarded-signer.js';
import { toWireAction } from './wire.js';

export interface Exchange {
  send(req: SignedRequest): Promise<ExchangeResult>;
}

export interface ExecutorDeps {
  network: Network;
  account: Hex;
  signer: GuardedSigner;
  exchange: Exchange;
  nonces: NonceManager;
  assets: AssetIndex;
  /** Builder to attach, or null (config switch off, or the user has not approved it). */
  builder: BuilderWire | null;
  now?: () => number;
  newCloid?: () => Hex;
}

export type ExecutionStatus = 'sent' | 'rejected' | 'failed' | 'alert';

/** One entry for the audit log. */
export interface ExecutionRecord {
  action: GuardAction;
  status: ExecutionStatus;
  wire?: L1Action;
  nonce?: number;
  cloid?: Hex;
  signature?: Signature;
  result?: ExchangeResult;
  violation?: Violation;
  error?: string;
  /** True when the order was retried without the builder code after the exchange rejected it (I7). */
  builderRetried: boolean;
  /** Sign + send, milliseconds. */
  latencyMs: number;
  /** For `failed`: whether signing failed or the exchange could not be reached (no response). */
  failedAt?: 'sign' | 'send';
  /**
   * For an order sent without an answer back: how much it filled as far as the guard can tell (looked up by its
   * client order id, or the whole order when that lookup fails). A retry is sized from this, never from zero.
   */
  assumedFilled?: number;
}

/** Bulwark client order ids start with these bytes so they are recognisable in the user's order history. */
export const CLOID_PREFIX = 'b17a';
export const newGuardCloid = (): Hex => `0x${CLOID_PREFIX}${randomBytes(14).toString('hex')}` as Hex;

/**
 * Sends approved guard actions in order (cancels, margin, then reduce-only orders, as the evaluator
 * sorted them). Every signature goes through the guarded signer, which re-runs the invariants. Each
 * action counts toward the I6 rate cap for the ones after it.
 */
export async function executeActions(actions: readonly GuardAction[], check: GuardCheck, deps: ExecutorDeps): Promise<ExecutionRecord[]> {
  const now = deps.now ?? Date.now;
  const records: ExecutionRecord[] = [];
  const recent = [...check.ctx.recentActions];

  for (const action of actions) {
    if (action.type === 'alert') {
      records.push({ action, status: 'alert', builderRetried: false, latencyMs: 0 });
      continue;
    }
    const isOrder = action.type === 'order' || action.type === 'trigger';
    const cloid = isOrder ? (deps.newCloid ?? newGuardCloid)() : undefined;
    let leg: 'sign' | 'send' = 'sign';
    const attempt = async (builder: BuilderWire | null) => {
      leg = 'sign';
      const nonce = deps.nonces.next(deps.signer.address);
      const params = { network: deps.network, account: deps.account, nonce, assets: deps.assets, snapshot: check.snapshot, builder, ...(cloid ? { cloid } : {}) };
      const wire = toWireAction(action, params);
      const ctx = { ...check.ctx, now: now(), recentActions: recent };
      const signature = await deps.signer.sign(action, wire, params, { ...check, ctx });
      leg = 'send';
      const result = await deps.exchange.send({ action: wire, nonce, signature });
      return { wire, nonce, signature, result };
    };

    const started = now();
    try {
      const builder = isOrder ? deps.builder : null;
      let out = await attempt(builder);
      let builderRetried = false;
      // I7: protection before revenue — a builder rejection is retried without the builder code.
      if (builder && !out.result.ok && isBuilderRejection(out.result.error ?? '')) {
        out = await attempt(null);
        builderRetried = true;
      }
      recent.push(now());
      records.push({
        action,
        status: out.result.ok ? 'sent' : 'failed',
        wire: out.wire,
        nonce: out.nonce,
        ...(cloid ? { cloid } : {}),
        signature: out.signature,
        result: out.result,
        ...(out.result.ok ? {} : { error: out.result.error ?? 'exchange error' }),
        builderRetried,
        latencyMs: now() - started,
      });
    } catch (e) {
      if (e instanceof InvariantViolation) {
        records.push({ action, status: 'rejected', violation: e.violation, builderRetried: false, latencyMs: now() - started });
      } else {
        records.push({ action, status: 'failed', error: e instanceof Error ? e.message : String(e), builderRetried: false, latencyMs: now() - started, failedAt: leg, ...(cloid && (leg as 'sign' | 'send') === 'send' ? { cloid } : {}) });
      }
    }
  }
  return records;
}
