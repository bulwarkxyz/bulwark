import { readFileSync } from 'node:fs';
import {
  buildAssetIndex,
  buildSnapshot,
  dexCollateral,
  evaluate,
  maintenanceMargin,
  planBackstops,
  policyHash,
  type ExecutionContext,
  type GuardAction,
  type Policy,
  type RawClearinghouseState,
} from '@bulwarkxyz/guard-core';
import { NonceManager, l1ActionHash, l1TypedData, type ExchangeResult, type Hex, type L1Action, type SignedRequest } from '@bulwarkxyz/hyperliquid';
import { LocalDigestSigner } from '@bulwarkxyz/signer';
import { recoverTypedDataAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { GuardedSigner, InvariantViolation, executeActions, toWireAction } from '../src/index.js';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../../guard-core/test/fixtures/${name}`, import.meta.url), 'utf8'));
const perpDexs = fx('perpDexs.json');
const allPerpMetas = fx('allPerpMetas.json');
const assets = buildAssetIndex(perpDexs, allPerpMetas);
const collateral = dexCollateral(perpDexs, allPerpMetas);

const ACCOUNT = '0x9959260f1aa229f8a70e0c495ca9b251106c1a86' as Hex;
const AGENT_KEY = `0x${'5a'.repeat(32)}` as Hex; // test key standing in for the per-user KMS key
const BUILDER = { b: '0x813843cf39a4d312182af6c5b85cff9290c42981' as Hex, f: 30 };

function state(positions: Array<{ coin: string; size: number; mark: number; iso?: number }>, equity: number): RawClearinghouseState {
  const cross = positions.filter((p) => p.iso === undefined);
  const mm = cross.reduce((s, p) => s + maintenanceMargin(assets.get(p.coin)!.tiers, Math.abs(p.size) * p.mark), 0);
  const sum = (av: number, raw: number) => ({ accountValue: String(av), totalNtlPos: '0', totalRawUsd: String(raw), totalMarginUsed: '0' });
  return {
    marginSummary: sum(equity, 0),
    crossMarginSummary: sum(equity, equity - cross.reduce((s, p) => s + p.size * p.mark, 0)),
    crossMaintenanceMarginUsed: String(mm),
    withdrawable: '0',
    assetPositions: positions.map((p) => ({
      type: 'oneWay',
      position: {
        coin: p.coin,
        szi: String(p.size),
        leverage: p.iso === undefined ? { type: 'cross' as const, value: 5 } : { type: 'isolated' as const, value: 5, rawUsd: String(p.iso - p.size * p.mark) },
        entryPx: String(p.mark),
        positionValue: String(Math.abs(p.size) * p.mark),
        unrealizedPnl: '0',
        liquidationPx: null,
        marginUsed: String(p.iso ?? 0),
        maxLeverage: assets.get(p.coin)!.maxLeverage,
      },
    })),
    time: 0,
  };
}

const snapshot = buildSnapshot({
  abstraction: 'default',
  dexStates: { xyz: state([{ coin: 'xyz:CL', size: 0.24, mark: 91.5 }, { coin: 'xyz:COIN', size: 0.06, mark: 186, iso: 1.5 }], 1) },
  spot: { balances: [{ coin: 'USDC', token: 0, total: '30', hold: '0', entryNtl: '0' }] },
  assets,
  dexCollateral: collateral,
});

// Numbers stand in for what a user typed.
const policy: Policy = {
  version: 1,
  account: ACCOUNT,
  rules: [
    { id: 'stage-1', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'reduce', target: { kind: 'market', market: 'xyz:CL' }, fraction: 0.5 }, { kind: 'topUp', maxUsdc: 5 }] },
    { id: 'stage-3', when: { kind: 'buffer', below: 1.2 }, then: [{ kind: 'alert' }] },
  ],
  execution: { maxSlippagePct: 1 },
};

const ctx = (over: Partial<ExecutionContext> = {}): ExecutionContext => ({
  now: 1_791_150_000_000,
  baselines: {},
  openOrders: [],
  latched: new Set(),
  automationAllowed: true,
  confirmation: { policyHash: policyHash(policy), signatureVerified: true },
  killSwitch: false,
  recentActions: [],
  builder: { enabled: true, approvedMaxTenthsBps: 50, feeTenthsBps: 30 },
  ...over,
});

function mockExchange(responses: Array<(req: SignedRequest) => unknown>) {
  const sent: SignedRequest[] = [];
  return {
    sent,
    async send(req: SignedRequest): Promise<ExchangeResult> {
      sent.push(req);
      const r = (responses.shift() ?? (() => ({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.12', avgPx: '91.4', oid: 1 } }] } } })))(req);
      const { parseExchangeResponse } = await import('@bulwarkxyz/hyperliquid');
      return parseExchangeResponse(r);
    },
  };
}

const signer = new GuardedSigner(new LocalDigestSigner(AGENT_KEY), false);
const deps = (exchange: ReturnType<typeof mockExchange>, builder = BUILDER) => ({
  network: 'testnet' as const,
  account: ACCOUNT,
  signer,
  exchange,
  nonces: new NonceManager(() => 1_791_150_000_000),
  assets,
  builder,
  now: () => 1_791_150_000_000,
  newCloid: () => `0xb17a${'00'.repeat(14)}` as Hex,
});

async function recovered(req: SignedRequest): Promise<string> {
  const typed = l1TypedData(l1ActionHash({ action: req.action as L1Action, nonce: req.nonce }), false);
  return (await recoverTypedDataAddress({ ...(typed as object), signature: { r: req.signature.r, s: req.signature.s, v: BigInt(req.signature.v) } } as never)).toLowerCase();
}

describe('executor', () => {
  const decision = evaluate(policy, snapshot, { 'xyz:CL': 90 }, ctx());

  it('evaluates, signs through the guard and sends reduce-only orders and top-ups', async () => {
    const ex = mockExchange([]);
    const records = await executeActions(decision.actions, { policy, snapshot, marks: { 'xyz:CL': 90 }, ctx: ctx() }, deps(ex));
    // at 90 the pool is also below the user's 1.2× line, so the stage-3 alert fires too
    expect(records.map((r) => [r.action.type, r.status])).toEqual([
      ['transfer', 'sent'],
      ['order', 'sent'],
      ['alert', 'alert'],
    ]);
    const order = ex.sent.find((r) => r.action.type === 'order')!;
    expect(order.action).toMatchObject({ type: 'order', grouping: 'na', builder: BUILDER, orders: [{ a: assets.get('xyz:CL')!.assetId, b: false, r: true, t: { limit: { tif: 'Ioc' } } }] });
    for (const req of ex.sent) expect(await recovered(req)).toBe(signer.address);
    const transfer = ex.sent.find((r) => r.action.type === 'agentSendAsset')!;
    expect(transfer.action).toMatchObject({ destination: ACCOUNT, sourceDex: 'spot', destinationDex: 'xyz', token: 'USDC:0xeb62eee3685fc4c43992febcd9e75443' });
    expect((transfer.action as { nonce: number }).nonce).toBe(transfer.nonce);
  });

  it('retries once without the builder code when the exchange rejects it (I7)', async () => {
    const ex = mockExchange([() => ({ status: 'err', response: 'Builder fee has not been approved.' })]);
    const orderOnly = decision.actions.filter((a) => a.type === 'order');
    const [rec] = await executeActions(orderOnly, { policy, snapshot, marks: { 'xyz:CL': 90 }, ctx: ctx() }, deps(ex));
    expect(rec).toMatchObject({ status: 'sent', builderRetried: true });
    expect('builder' in (ex.sent[0]!.action as object)).toBe(true);
    expect('builder' in (ex.sent[1]!.action as object)).toBe(false);
  });

  it('sends no builder code when the switch is off', async () => {
    const ex = mockExchange([]);
    await executeActions(decision.actions.filter((a) => a.type === 'order'), { policy, snapshot, marks: { 'xyz:CL': 90 }, ctx: ctx({ builder: null }) }, deps(ex, null as never));
    expect('builder' in (ex.sent[0]!.action as object)).toBe(false);
  });

  it('refuses to sign when the kill switch is on, and nothing reaches the exchange', async () => {
    const ex = mockExchange([]);
    const records = await executeActions(decision.actions, { policy, snapshot, marks: { 'xyz:CL': 90 }, ctx: ctx({ killSwitch: true }) }, deps(ex));
    const exchangeActions = records.filter((r) => r.action.type !== 'alert');
    expect(exchangeActions.length).toBeGreaterThan(0);
    expect(exchangeActions.every((r) => r.status === 'rejected' && r.violation?.invariant === 'I4')).toBe(true);
    expect(ex.sent).toEqual([]);
  });

  it('refuses an action that breaks an invariant even if the caller skipped the gate', async () => {
    const ex = mockExchange([]);
    const bad: GuardAction = { ...(decision.actions.find((a) => a.type === 'order') as Extract<GuardAction, { type: 'order' }>), isBuy: true };
    const [rec] = await executeActions([bad], { policy, snapshot, marks: { 'xyz:CL': 90 }, ctx: ctx() }, deps(ex));
    expect(rec).toMatchObject({ status: 'rejected', violation: { invariant: 'I1' } });
    expect(ex.sent).toEqual([]);
  });

  it('refuses to sign an exchange action that differs from the checked guard action', async () => {
    const action = decision.actions.find((a) => a.type === 'order')!;
    const params = { network: 'testnet' as const, account: ACCOUNT, nonce: 1, assets, snapshot, builder: null };
    const wire = toWireAction(action, params) as Extract<L1Action, { type: 'order' }>;
    const tampered = { ...wire, orders: [{ ...wire.orders[0]!, s: '0.24' }] };
    await expect(signer.sign(action, tampered, params, { policy, snapshot, marks: { 'xyz:CL': 90 }, ctx: ctx() })).rejects.toBeInstanceOf(InvariantViolation);
  });

  it('enforces the rate cap across one batch (I6)', async () => {
    const ex = mockExchange([]);
    const one = decision.actions.find((a) => a.type === 'order')!;
    const records = await executeActions(Array(22).fill(one), { policy, snapshot, marks: { 'xyz:CL': 90 }, ctx: ctx() }, deps(ex));
    expect(records.filter((r) => r.status === 'sent')).toHaveLength(20);
    expect(records.slice(20).every((r) => r.violation?.invariant === 'I6')).toBe(true);
  });

  it('builds backstops, isolated-margin adds and cancels with the right wire fields', () => {
    const plan = planBackstops(policy, snapshot, { 'xyz:CL': 91.5 }, []);
    const t = plan.place.find((p) => p.coin === 'xyz:CL')!;
    const w = toWireAction(t, { network: 'testnet', account: ACCOUNT, nonce: 1, assets, snapshot, cloid: `0xb17a${'00'.repeat(14)}` }) as Extract<L1Action, { type: 'order' }>;
    expect(w.orders[0]).toMatchObject({ b: false, r: true, t: { trigger: { isMarket: true, tpsl: 'sl' } }, c: `0xb17a${'00'.repeat(14)}` });
    const iso = toWireAction({ type: 'isolatedMargin', ruleId: 'stage-1', reason: 't', dex: 'xyz', coin: 'xyz:COIN', assetId: assets.get('xyz:COIN')!.assetId, amount: 0.5 }, { network: 'testnet', account: ACCOUNT, nonce: 1, assets, snapshot });
    expect(iso).toEqual({ type: 'updateIsolatedMargin', asset: assets.get('xyz:COIN')!.assetId, isBuy: true, ntli: 500000 });
    const c = toWireAction({ type: 'cancel', ruleId: 'stage-1', reason: 't', dex: 'xyz', coin: 'xyz:CL', oid: 42 }, { network: 'testnet', account: ACCOUNT, nonce: 1, assets, snapshot });
    expect(c).toEqual({ type: 'cancel', cancels: [{ a: assets.get('xyz:CL')!.assetId, o: 42 }] });
  });
});

import { CommandRejected, CommandSigner, planUnwind, stopCancels } from '../src/commands.js';

describe('user commands', () => {
  const cmdSigner = new CommandSigner(new LocalDigestSigner(AGENT_KEY), false);
  const now = 1_791_150_000_000;

  it('unwind: reduce-only TWAP for positions ≥ $100, reduce-only IOC below it', async () => {
    const big = buildSnapshot({
      abstraction: 'default',
      dexStates: { xyz: state([{ coin: 'xyz:CL', size: 2, mark: 91.5 }, { coin: 'xyz:NVDA', size: -0.05, mark: 234 }], 50) },
      spot: { balances: [] },
      assets,
      dexCollateral: collateral,
    });
    const cmd = { kind: 'unwind' as const, minutes: 10, issuedAt: now, verified: true };
    const steps = planUnwind(cmd, big, undefined, 1);
    expect(steps.map((s) => [s.coin, s.wire.type])).toEqual([
      ['xyz:CL', 'twapOrder'],
      ['xyz:NVDA', 'order'],
    ]);
    expect(steps[0]!.wire).toMatchObject({ twap: { b: false, r: true, s: '2', m: 10 } });
    for (const s of steps) await expect(cmdSigner.signUnwindStep(cmd, s, big, 1, now)).resolves.toBeDefined();
    // tampering with the side is refused at signing
    const flipped = { ...steps[0]!, wire: { ...(steps[0]!.wire as never as { twap: object }), type: 'twapOrder', twap: { ...(steps[0]!.wire as { twap: object }).twap, b: true } } } as never;
    await expect(cmdSigner.signUnwindStep(cmd, flipped, big, 2, now)).rejects.toBeInstanceOf(CommandRejected);
  });

  it('refuses stale or unverified commands, and unwind times outside 5 min – 7 days', async () => {
    const steps = planUnwind({ kind: 'unwind', minutes: 10, issuedAt: now, verified: true }, snapshot, undefined, 1);
    await expect(cmdSigner.signUnwindStep({ kind: 'unwind', minutes: 10, issuedAt: now - 120_000, verified: true }, steps[0]!, snapshot, 1, now)).rejects.toThrow(/expired/);
    await expect(cmdSigner.signUnwindStep({ kind: 'unwind', minutes: 10, issuedAt: now, verified: false }, steps[0]!, snapshot, 1, now)).rejects.toThrow(/not verified/);
    expect(() => planUnwind({ kind: 'unwind', minutes: 2, issuedAt: now, verified: true }, snapshot, undefined, 1)).toThrow(CommandRejected);
  });

  it('kill switch cancels only orders the guard placed', async () => {
    const cmd = { kind: 'stop' as const, issuedAt: now, verified: true };
    const wire = stopCancels([{ asset: 110029, oid: 5 }])!;
    await expect(cmdSigner.signStopCancel(cmd, wire, new Set([5]), 1, now)).resolves.toBeDefined();
    await expect(cmdSigner.signStopCancel(cmd, stopCancels([{ asset: 110029, oid: 6 }])!, new Set([5]), 1, now)).rejects.toThrow(/only cancels orders the guard placed/);
  });
});
