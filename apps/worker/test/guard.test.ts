import { readFileSync } from 'node:fs';
import { CommandSigner, GuardedSigner } from '@bulwarkxyz/executor';
import { buildAssetIndex, dexCollateral, maintenanceMargin, policyHash, type Policy, type RawClearinghouseState } from '@bulwarkxyz/guard-core';
import { NonceManager, parseExchangeResponse, type Hex, type SignedRequest } from '@bulwarkxyz/hyperliquid';
import { LocalDigestSigner } from '@bulwarkxyz/signer';
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyChain } from '@bulwarkxyz/store';
import { BACKSTOP_EVERY_MS, EXCHANGE_DOWN_HOLD_MS, GuardEngine, KEY_CHECK_EVERY_MS, STATUS_WRITE_EVERY_MS } from '../src/guard.js';
import { RETRY_ALERT_AFTER } from '@bulwarkxyz/guard-core';
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
/** Replies for the next guard IOC orders (default: filled). */
let orderReplies: Array<() => unknown>;
let agents: Array<{ address: string; validUntil?: number | null }>;
const AGENT = '0x00000000000000000000000000000000000a6e47';
const MISS = () => ({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Order could not immediately match against any resting orders. asset=110000' }] } } });

function setup(user: Partial<GuardUser> = {}) {
  store = new MemoryStore();
  notifier = new ConsoleNotifier();
  sent = [];
  orderReplies = [];
  agents = [{ address: AGENT, validUntil: null }];
  store.putUser({ account: ACCOUNT, agentKeyRef: 'local:test', agentAddress: AGENT, region: 'allowed', telegramChatId: '42', killSwitch: false, builderApproved: false, ...user });
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
        if (a.type === 'order' && orderReplies.length) return parseExchangeResponse(orderReplies.shift()!());
        if (a.type === 'order') return parseExchangeResponse({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: (a.orders![0] as unknown as { s: string }).s, avgPx: '89.9', oid: oid++ } }] } } });
        return parseExchangeResponse({ status: 'ok', response: { type: 'default' } });
      },
    },
    nonces: new NonceManager(() => t),
    openOrders: async () => [],
    abstraction: async () => 'default',
    signerFor: async () => new GuardedSigner(new LocalDigestSigner(`0x${'5a'.repeat(32)}`), false),
    commandSignerFor: async () => new CommandSigner(new LocalDigestSigner(`0x${'5a'.repeat(32)}`), false),
    builder: null,
    agents: async () => agents,
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


  it('kill switch command cancels only the guard’s own resting orders', async () => {
    await feed(91.5);
    const mine = await store.guardOrders(ACCOUNT);
    expect(mine).toHaveLength(1);
    (engine as unknown as { deps: { openOrders: unknown } }).deps.openOrders = async () => [{ coin: 'xyz:CL', oid: mine[0]!.oid, side: 'A', reduceOnly: true, isTrigger: true }, { coin: 'xyz:CL', oid: 999, side: 'A', reduceOnly: true, isTrigger: true }];
    sent = [];
    const r = await engine.command({ id: 1, account: ACCOUNT, command: 'stop', minutes: 0, issuedAt: t });
    expect(r).toMatchObject({ cancelled: 1 });
    expect(sent[0]!.action).toEqual({ type: 'cancel', cancels: [{ a: assets.get('xyz:CL')!.assetId, o: mine[0]!.oid }] });
    expect(await store.guardOrders(ACCOUNT)).toEqual([]);
  });

  it('panic unwind closes positions reduce-only', async () => {
    await feed(91.5);
    sent = [];
    const r = (await engine.command({ id: 2, account: ACCOUNT, command: 'unwind', minutes: 10, issuedAt: t })) as { steps: Array<{ ok: boolean }> };
    expect(r.steps).toHaveLength(1);
    expect(sent[0]!.action).toMatchObject({ type: 'order', orders: [{ b: false, r: true, s: '0.24' }] }); // $22 < $100 → IOC close
  });
});

const ioc = (r: SignedRequest) => (r.action as { type: string; orders?: Array<{ p: string; s: string; t: { limit?: unknown } }> }).type === 'order' && (r.action as { orders: Array<{ t: { limit?: unknown } }> }).orders[0]!.t.limit !== undefined;
const iocs = () => sent.filter(ioc).map((r) => (r.action as { orders: Array<{ p: string; s: string }> }).orders[0]!);
/** A later tick: the price, then fresh account state (same position: the order missed). */
async function tick(mark: number, dt = 3000) {
  t += dt;
  await engine.onMarks(new Map([['xyz:CL', mark]]), t);
  await engine.onUserState(ACCOUNT, [['', emptyMain], ['xyz', xyzState(0.24, 91.5, 6)]], t);
}

describe('guard retry', () => {
  beforeEach(() => setup());

  it('before the fix the stage would stop after a miss; now it retries at the new mark while the stage holds, and stops once filled', async () => {
    await feed(91.5);
    sent = [];
    orderReplies = [MISS];
    t += 1000;
    await engine.onMarks(new Map([['xyz:CL', 69]]), t);
    expect(iocs()).toHaveLength(1);
    expect(await store.retries(ACCOUNT)).toMatchObject([{ coin: 'xyz:CL', remaining: 0.145, failures: 1 }]);

    // Same state, new price: the miss may not be visible yet, so no retry from stale state.
    t += 500;
    await engine.onMarks(new Map([['xyz:CL', 68.8]]), t);
    expect(iocs()).toHaveLength(1);

    await tick(68.5); // fresh state: retry, re-priced from 68.5 within the 1% slippage
    const [, retry] = iocs();
    expect(retry).toMatchObject({ s: '0.146' }); // the unfilled 0.145, raised again to the $10 minimum at the lower price
    expect(Number(retry!.p)).toBeGreaterThanOrEqual(68.5 * 0.99 - 1e-9);
    expect(Number(retry!.p)).toBeLessThan(68.5);
    expect(await store.retries(ACCOUNT)).toEqual([]); // filled
    const entries = store.audit.raw(ACCOUNT).filter((e) => e.kind === 'guard_action' && /^order/.test(e.what));
    expect(entries.map((e) => e.what)).toEqual(['order failed, filled 0 of 0.145: Order could not immediately match against any resting orders. asset=110000', 'order sent, filled 0.146 of 0.146 (attempt 2)']);
    expect(entries[1]!.why).toMatch(/retry 1: the last order did not fully fill/);

    await tick(68.4);
    expect(iocs()).toHaveLength(2); // done: no more orders while the stage stays latched
  });

  it(`after ${RETRY_ALERT_AFTER} misses: a critical alert saying it cannot fill within the slippage, and it keeps trying`, async () => {
    await feed(91.5);
    sent = [];
    orderReplies = Array.from({ length: 10 }, () => MISS);
    t += 1000;
    await engine.onMarks(new Map([['xyz:CL', 69]]), t);
    for (let i = 0; i < RETRY_ALERT_AFTER + 1; i++) await tick(69 - 0.1 * i);
    expect(iocs().length).toBe(RETRY_ALERT_AFTER + 2);
    const alerts = store.audit.raw(ACCOUNT).filter((e) => e.kind === 'alert' && /cannot fill xyz:CL within your 1% slippage/.test(e.why));
    expect(alerts).toHaveLength(1);
    expect(notifier.sent.some((m) => /cannot fill xyz:CL within your 1% slippage/.test(m.text))).toBe(true);
    // Misses after the first are logged but not each sent to Telegram.
    expect(notifier.sent.filter((m) => /retry \d/.test(m.text))).toEqual([]);
    expect((await store.guardStatus(ACCOUNT))?.state).toBe('acting');
  });

  it('stops retrying once the stage condition clears', async () => {
    await feed(91.5);
    sent = [];
    orderReplies = [MISS];
    t += 1000;
    await engine.onMarks(new Map([['xyz:CL', 69]]), t);
    await tick(91);
    expect(iocs()).toHaveLength(1);
    expect(await store.retries(ACCOUNT)).toEqual([]);
  });

  it('a retry held back by the rate cap (I6) is logged and tried again later', async () => {
    await feed(91.5);
    sent = [];
    orderReplies = [MISS];
    t += 1000;
    await engine.onMarks(new Map([['xyz:CL', 69]]), t);
    for (let i = 0; i < 20; i++) await store.addAction(ACCOUNT, t);
    await tick(68.9, 1000);
    expect(iocs()).toHaveLength(1);
    expect(store.audit.raw(ACCOUNT).at(-1)).toMatchObject({ kind: 'rejected' });
    expect(store.audit.raw(ACCOUNT).some((e) => e.kind === 'rejected' && /I6.*\(attempt 2\)/.test(e.what))).toBe(true);
    await tick(68.8, 61_000);
    expect(iocs()).toHaveLength(2);
  });
});

describe('guard status', () => {
  beforeEach(() => setup());
  const status = () => store.guardStatus(ACCOUNT);

  it('protected when calm, with the time of the last evaluation', async () => {
    await feed(91.5);
    expect(await status()).toEqual({ state: 'protected', reason: null, lastEvaluatedAt: t, updatedAt: t });
  });

  it('acting while it trims, at risk while the stage is done but the line is still crossed, protected once above it', async () => {
    await feed(91.5);
    t += 1000;
    await engine.onMarks(new Map([['xyz:CL', 69]]), t);
    expect((await status())?.state).toBe('acting');
    await tick(68.9);
    expect((await status())?.state).toBe('at_risk');
    await tick(91.5);
    expect((await status())?.state).toBe('protected');
  });

  it('paused (stale_data) on stale prices, keeping the last evaluation time', async () => {
    await feed(91.5);
    const evaluated = t;
    t += 60_000;
    await engine.onUserState(ACCOUNT, [['', emptyMain], ['xyz', xyzState(0.24, 91.5, 6)]], t);
    expect(await status()).toEqual({ state: 'paused', reason: 'stale_data', lastEvaluatedAt: evaluated, updatedAt: t });
  });

  it('paused (exchange_unreachable) when the exchange does not answer, until it does', async () => {
    await feed(91.5);
    orderReplies = [() => { throw new Error('fetch failed'); }];
    t += 1000;
    await engine.onMarks(new Map([['xyz:CL', 69]]), t);
    expect(await status()).toMatchObject({ state: 'paused', reason: 'exchange_unreachable' });
    t += EXCHANGE_DOWN_HOLD_MS;
    await tick(91.5);
    expect((await status())?.state).toBe('protected');
  });

  it('paused (signer_error) when the guard key cannot be loaded', async () => {
    setup();
    (engine as unknown as { deps: { signerFor: unknown } }).deps.signerFor = async () => { throw new Error('no stored guard key for this account'); };
    await feed(91.5);
    expect(await status()).toMatchObject({ state: 'paused', reason: 'signer_error' });
  });

  it('paused (agent_expired) when Hyperliquid no longer lists the key, or its approval has run out', async () => {
    agents = [];
    await feed(91.5);
    expect(await status()).toMatchObject({ state: 'paused', reason: 'agent_expired' });
    agents = [{ address: AGENT, validUntil: t + KEY_CHECK_EVERY_MS + 1 }];
    await tick(91.5, KEY_CHECK_EVERY_MS);
    expect((await status())?.state).toBe('protected');
    agents = [{ address: AGENT, validUntil: t + 1 }];
    await tick(91.5, KEY_CHECK_EVERY_MS);
    expect(await status()).toMatchObject({ state: 'paused', reason: 'agent_expired' });
  });

  it('stopped with the kill switch on; alerts_only where automatic action is off; no_rules without rules', async () => {
    setup({ killSwitch: true });
    await feed(69);
    expect(await status()).toMatchObject({ state: 'stopped', reason: null });
    setup({ region: 'guardOff' });
    await feed(91.5);
    expect(await status()).toMatchObject({ state: 'alerts_only' });
    setup();
    store.putPolicy(ACCOUNT, { policy: { ...policy, rules: [] }, hash: policyHash({ ...policy, rules: [] }), signature: '0x00', signatureVerified: true, confirmedAt: t });
    await feed(91.5);
    expect(await status()).toMatchObject({ state: 'no_rules', reason: null });
  });

  it('writes when the state changes and otherwise at most every 15 s; the heartbeat keeps it current', async () => {
    await feed(91.5);
    const first = (await status())!.updatedAt;
    t += 1000;
    await engine.onMarks(new Map([['xyz:CL', 91.4]]), t);
    expect((await status())!.updatedAt).toBe(first);
    t += STATUS_WRITE_EVERY_MS;
    await engine.onUserState(ACCOUNT, [['', emptyMain], ['xyz', xyzState(0.24, 91.5, 6)]], t);
    await engine.heartbeat();
    expect((await status())!.updatedAt).toBe(t);
  });
});
