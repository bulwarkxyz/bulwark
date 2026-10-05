import { readFileSync } from 'node:fs';
import { GuardedSigner } from '@bulwarkxyz/executor';
import { buildAssetIndex, dexCollateral, maintenanceMargin, policyHash, type Policy, type RawClearinghouseState } from '@bulwarkxyz/guard-core';
import { NonceManager, parseExchangeResponse, type Hex, type SignedRequest } from '@bulwarkxyz/hyperliquid';
import { LocalDigestSigner } from '@bulwarkxyz/signer';
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyChain } from '@bulwarkxyz/store';
import { BACKSTOP_EVERY_MS, GuardEngine } from '../src/guard.js';
import { ConsoleNotifier } from '../src/notify.js';
import { MemoryStore, type GuardUser } from '@bulwarkxyz/store';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`../../../packages/guard-core/test/fixtures/${n}`, import.meta.url), 'utf8'));
const assets = buildAssetIndex(fx('perpDexs.json'), fx('allPerpMetas.json'));
const collateral = dexCollateral(fx('perpDexs.json'), fx('allPerpMetas.json'));
const ACCOUNT = '0x9959260f1aa229f8a70e0c495ca9b251106c1a86' as Hex;

function xyzState(size: number, mark: number, equity: number): RawClearinghouseState {
  const mm = maintenanceMargin(assets.get('xyz:CL')!.tiers, size * mark);
  const sum = (av: number, raw: number) => ({ accountValue: String(av), totalNtlPos: '0', totalRawUsd: String(raw), totalMarginUsed: '0' });
  return {
    marginSummary: sum(equity, equity - size * mark),
    crossMarginSummary: sum(equity, equity - size * mark),
    crossMaintenanceMarginUsed: String(mm),
    withdrawable: '0',
    assetPositions: size ? [{ type: 'oneWay', position: { coin: 'xyz:CL', szi: String(size), leverage: { type: 'cross', value: 5 }, entryPx: String(mark), positionValue: String(size * mark), unrealizedPnl: '0', liquidationPx: null, marginUsed: '0', maxLeverage: 20 } }] : [],
    time: 0,
  };
}
const emptyMain: RawClearinghouseState = { ...xyzState(0, 1, 0) };

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

let t = 1_791_150_000_000;
let store: MemoryStore;
let notifier: ConsoleNotifier;
let sent: SignedRequest[];
let engine: GuardEngine;

function setup(user: Partial<GuardUser> = {}) {
  store = new MemoryStore();
  notifier = new ConsoleNotifier();
  sent = [];
  store.putUser({ account: ACCOUNT, agentKeyRef: 'local:test', region: 'allowed', telegramChatId: '42', killSwitch: false, builderApproved: false, ...user });
  store.putPolicy(ACCOUNT, { policy, hash: policyHash(policy), signature: '0x00', signatureVerified: true, confirmedAt: t });
  let oid = 100;
  engine = new GuardEngine({
    network: 'testnet',
    assets,
    collateral,
    store,
    notifier,
    exchange: {
      async send(req) {
        sent.push(req);
        const a = req.action as { type: string; orders?: Array<{ t: Record<string, unknown> }> };
        if (a.type === 'order' && a.orders?.[0]?.t.trigger) return parseExchangeResponse({ status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: oid++ } }] } } });
        if (a.type === 'order') return parseExchangeResponse({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.12', avgPx: '89.9', oid: oid++ } }] } } });
        return parseExchangeResponse({ status: 'ok', response: { type: 'default' } });
      },
    },
    nonces: new NonceManager(() => t),
    openOrders: async () => [],
    abstraction: async () => 'default',
    signerFor: async () => new GuardedSigner(new LocalDigestSigner(`0x${'5a'.repeat(32)}`), false),
    builder: null,
    now: () => t,
  });
}

async function feed(mark: number, equity = 6) {
  await engine.onUserState(ACCOUNT, [['', emptyMain], ['xyz', xyzState(0.24, 91.5, equity)]], t);
  await engine.onSpotState(ACCOUNT, { balances: [{ coin: 'USDC', token: 0, total: '20', hold: '0', entryNtl: '0' }] }, t);
  await engine.onMarks(new Map([['xyz:CL', mark]]), t);
}

describe('guard engine', () => {
  beforeEach(() => setup());

  it('places backstops when calm, then trims and tops up when the buffer crosses the line', async () => {
    await feed(91.5, 6); // buffer 6/0.549 ≈ 10.9: calm
    const backstops = sent.filter((r) => (r.action as { orders?: Array<{ t: { trigger?: unknown } }> }).orders?.[0]?.t.trigger);
    expect(backstops).toHaveLength(1);
    expect(await store.guardOrders(ACCOUNT)).toHaveLength(1);
    sent = [];

    t += 1000;
    await engine.onMarks(new Map([['xyz:CL', 69]]), t); // equity 6 − 0.24·22.5 = 0.6; maintenance 0.414 → buffer 1.45 < 2
    const types = sent.map((r) => r.action.type);
    expect(types).toContain('order');
    expect(types).toContain('agentSendAsset');
    const chain = store.audit.raw(ACCOUNT);
    expect(chain.some((e) => e.kind === 'degraded')).toBe(false);
    expect(chain.some((e) => e.kind === 'guard_action')).toBe(true);
    expect(verifyChain(chain)).toBeNull();
    expect(notifier.sent.at(-1)?.text).toMatch(/Bulwark guard: buffer .* below your 2× line/);
  });

  it('does not fire twice for the same breach (latch persisted in the store)', async () => {
    await feed(91.5);
    sent = [];
    t += 1000;
    await engine.onMarks(new Map([['xyz:CL', 69]]), t);
    const first = sent.length;
    t += 1000;
    await engine.onMarks(new Map([['xyz:CL', 68.9]]), t);
    expect(sent.length).toBe(first);
    expect([...(await store.latched(ACCOUNT))]).toContain('stage-1@dex:xyz');
  });

  it('keeps backstops in place without churn', async () => {
    await feed(91.5);
    const n = sent.length;
    t += BACKSTOP_EVERY_MS + 1;
    await engine.onMarks(new Map([['xyz:CL', 91.4]]), t);
    expect(sent.length).toBe(n);
  });

  it('holds off on stale prices and says so, sending nothing', async () => {
    await engine.onUserState(ACCOUNT, [['xyz', xyzState(0.24, 91.5, 1)]], t);
    await engine.onMarks(new Map([['xyz:CL', 69]]), t - 60_000); // the last price we have is 60 s old
    await engine.onUserState(ACCOUNT, [['xyz', xyzState(0.24, 91.5, 1)]], t);
    expect(sent).toEqual([]);
    expect(store.audit.raw(ACCOUNT).at(-1)?.kind).toBe('degraded');
    expect(notifier.sent.at(-1)?.text).toMatch(/holding off/);
  });

  it('EU (guard off): alerts only — no orders, no backstops', async () => {
    setup({ region: 'guardOff' });
    await feed(69);
    expect(sent).toEqual([]);
    expect(notifier.sent.at(-1)?.text).toMatch(/automatic action is off in your region/);
  });

  it('kill switch: nothing is signed and every refusal is logged', async () => {
    setup({ killSwitch: true });
    await feed(69);
    expect(sent).toEqual([]);
    expect(store.audit.raw(ACCOUNT).filter((e) => e.kind === 'rejected').every((e) => /I4/.test(e.what))).toBe(true);
    expect(store.audit.raw(ACCOUNT).some((e) => e.kind === 'rejected')).toBe(true);
  });
});
