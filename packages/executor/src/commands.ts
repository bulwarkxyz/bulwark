import { assessRisk, roundPrice, toWire as num, type AccountSnapshot, type Marks } from '@bulwarkxyz/guard-core';
import {
  cancelAction,
  digestOf,
  l1ActionHash,
  l1TypedData,
  orderAction,
  orderWire,
  twapOrderAction,
  type CancelAction,
  type Hex,
  type L1Action,
  type OrderAction,
  type Signature,
  type TwapOrderAction,
} from '@bulwarkxyz/hyperliquid';
import type { DigestSigner } from '@bulwarkxyz/signer';

/**
 * Commands the user gives directly (not rules): panic unwind and the kill switch. Each arrives with the
 * user's own wallet signature, verified by the API before it reaches here.
 *
 * - unwind: close every position with reduce-only TWAPs over the minutes the user chose. Positions
 *   below the exchange's $100 TWAP minimum close with a reduce-only IOC at the user's slippage instead.
 *   https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types (TWAP: 5 min – 7 days, $100 min)
 * - stop: cancel every order the guard placed (backstops included), nothing else.
 */
/** `acceptedAt`: when the API verified the signature and queued it (server clock); absent for direct use. */
export type UserCommand =
  | { kind: 'unwind'; minutes: number; issuedAt: number; verified: boolean; acceptedAt?: number }
  | { kind: 'stop'; issuedAt: number; verified: boolean; acceptedAt?: number };

export const TWAP_MIN_NOTIONAL = 100;
export const TWAP_MIN_MINUTES = 5;
export const TWAP_MAX_MINUTES = 7 * 24 * 60;
/** A command must be used within this long of the user signing it (engine constant). */
export const COMMAND_MAX_AGE_MS = 60_000;
/**
 * A command the API accepted (signature verified, signed within COMMAND_MAX_AGE_MS of the API's clock) may wait in the
 * queue this long before the worker carries it out. Measured on the servers' clocks: until 8 Oct 2026 the worker
 * measured the browser's signing time against its own clock with 60 s and a 5 s skew allowance, so a kill switch
 * could be accepted and then dropped during a deploy or with a browser clock a few seconds fast.
 */
export const COMMAND_QUEUE_MAX_MS = 15 * 60_000;

export class CommandRejected extends Error {}

function checkFresh(cmd: UserCommand, now: number) {
  if (!cmd.verified) throw new CommandRejected('command signature not verified');
  if (cmd.acceptedAt !== undefined) {
    if (now - cmd.acceptedAt > COMMAND_QUEUE_MAX_MS) throw new CommandRejected('command expired');
    return;
  }
  if (now - cmd.issuedAt > COMMAND_MAX_AGE_MS || cmd.issuedAt > now + 5_000) throw new CommandRejected('command expired');
}

export interface UnwindStep {
  coin: string;
  wire: TwapOrderAction | OrderAction;
}

/** Builds the reduce-only exchange actions for an unwind. Pure; signing checks them again. */
export function planUnwind(cmd: Extract<UserCommand, { kind: 'unwind' }>, snapshot: AccountSnapshot, marks: Marks | undefined, maxSlippagePct: number): UnwindStep[] {
  if (cmd.minutes < TWAP_MIN_MINUTES || cmd.minutes > TWAP_MAX_MINUTES) throw new CommandRejected('unwind time outside 5 minutes to 7 days');
  const risk = assessRisk(snapshot, marks);
  return risk.pools.flatMap((pool) =>
    pool.positions.map((row): UnwindStep => {
      const p = row.position;
      const isBuy = p.size < 0;
      const size = num(Math.abs(p.size));
      if (row.notional >= TWAP_MIN_NOTIONAL) {
        return { coin: p.coin, wire: twapOrderAction({ asset: p.asset.assetId, isBuy, size, reduceOnly: true, minutes: cmd.minutes, randomize: false }) };
      }
      const raw = isBuy ? row.mark * (1 + maxSlippagePct / 100) : row.mark * (1 - maxSlippagePct / 100);
      const px = num(roundPrice(raw, p.asset.szDecimals, isBuy ? 'up' : 'down'));
      return { coin: p.coin, wire: orderAction([orderWire({ asset: p.asset.assetId, isBuy, limitPx: px, size, reduceOnly: true, orderType: { limit: { tif: 'Ioc' } } })]) };
    }),
  );
}

/** Signs user commands. Checks run on every signature, like the guarded signer. */
export class CommandSigner {
  constructor(
    private readonly signer: DigestSigner,
    private readonly isMainnet: boolean,
  ) {}

  /** The agent key's address: nonces are tracked per signing key. */
  get address(): Hex {
    return this.signer.address;
  }

  private async signL1(wire: L1Action, nonce: number): Promise<Signature> {
    return this.signer.signDigest(digestOf(l1TypedData(l1ActionHash({ action: wire, nonce }), this.isMainnet)));
  }

  /**
   * `price`: the mark the step was planned from and the user's slippage. An IOC close must be priced within that
   * slippage of the mark (plus one tick of rounding); security review F9.
   */
  async signUnwindStep(cmd: UserCommand, step: UnwindStep, snapshot: AccountSnapshot, nonce: number, now: number, price?: { mark: number; maxSlippagePct: number }): Promise<Signature> {
    checkFresh(cmd, now);
    if (cmd.kind !== 'unwind') throw new CommandRejected('not an unwind command');
    const pos = snapshot.positions.find((p) => p.coin === step.coin);
    if (!pos) throw new CommandRejected(`no position on ${step.coin}`);
    const isBuy = pos.size < 0;
    const w = step.wire;
    if (w.type === 'twapOrder') {
      if (!w.twap.r || w.twap.b !== isBuy || w.twap.a !== pos.asset.assetId || Number(w.twap.s) > Math.abs(pos.size) + 1e-12 || w.twap.m !== cmd.minutes) throw new CommandRejected('unwind TWAP is not a reduce-only close of this position');
    } else {
      const o = w.orders[0];
      if (w.orders.length !== 1 || !o || !o.r || o.b !== isBuy || o.a !== pos.asset.assetId || Number(o.s) > Math.abs(pos.size) + 1e-12 || w.builder) throw new CommandRejected('unwind order is not a reduce-only close of this position');
      if (!price || !(price.mark > 0)) throw new CommandRejected('unwind order has no mark to check its price against');
      const away = Math.abs(Number(o.p) - price.mark) / price.mark;
      if (away > price.maxSlippagePct / 100 + 1e-3) throw new CommandRejected(`unwind price ${o.p} is ${(away * 100).toFixed(2)}% from the mark, beyond your ${price.maxSlippagePct}% slippage`);
    }
    return this.signL1(w, nonce);
  }

  async signStopCancel(cmd: UserCommand, wire: CancelAction, guardOwnedOids: ReadonlySet<number>, nonce: number, now: number): Promise<Signature> {
    checkFresh(cmd, now);
    if (cmd.kind !== 'stop') throw new CommandRejected('not a stop command');
    if (wire.cancels.length === 0 || wire.cancels.some((c) => !guardOwnedOids.has(c.o))) throw new CommandRejected('the kill switch only cancels orders the guard placed');
    return this.signL1(wire, nonce);
  }
}

/** One cancel action for every guard-placed order, grouped as the exchange accepts. */
export function stopCancels(guardOrders: ReadonlyArray<{ asset: number; oid: number }>): CancelAction | null {
  return guardOrders.length ? cancelAction(guardOrders.map((o) => ({ asset: o.asset, oid: o.oid }))) : null;
}

export type { Hex };
