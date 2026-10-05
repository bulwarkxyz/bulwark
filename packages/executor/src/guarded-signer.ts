import { canonicalJson, checkAction, type AccountSnapshot, type ExecutionContext, type GuardAction, type Marks, type Policy, type Violation } from '@bulwarkxyz/guard-core';
import { digestOf, l1ActionHash, l1TypedData, type L1Action, type Signature } from '@bulwarkxyz/hyperliquid';
import type { DigestSigner } from '@bulwarkxyz/signer';
import { toWireAction, type WireParams } from './wire.js';

export class InvariantViolation extends Error {
  constructor(readonly violation: Violation) {
    super(`${violation.invariant}: ${violation.message}`);
  }
}

export interface GuardCheck {
  policy: Policy;
  snapshot: AccountSnapshot;
  marks: Marks | undefined;
  ctx: ExecutionContext;
}

/**
 * The only path to the agent key. Before every signature it
 *  1. re-runs invariants I1–I7 on the guard action (with its builder field),
 *  2. rebuilds the exchange action from the guard action and refuses if the one it was given differs,
 *  3. hashes and signs the L1 action.
 * The agent key can technically sign any order on Hyperliquid; this is where Bulwark limits it.
 */
export class GuardedSigner {
  constructor(
    private readonly signer: DigestSigner,
    private readonly isMainnet: boolean,
  ) {}

  get address() {
    return this.signer.address;
  }

  async sign(action: GuardAction, wire: L1Action, params: WireParams, check: GuardCheck): Promise<Signature> {
    const builder = 'orders' in wire ? (wire.builder ?? null) : null;
    const violation = checkAction({ ...action, builder }, check.policy, check.snapshot, check.marks, check.ctx);
    if (violation) throw new InvariantViolation(violation);
    const expected = toWireAction(action, params);
    if (canonicalJson(expected) !== canonicalJson(wire) || JSON.stringify(expected) !== JSON.stringify(wire)) {
      throw new InvariantViolation({ invariant: 'I1', message: 'exchange action does not match the checked guard action' });
    }
    const digest = digestOf(l1TypedData(l1ActionHash({ action: wire, nonce: params.nonce }), this.isMainnet));
    return this.signer.signDigest(digest);
  }
}
