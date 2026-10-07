import { readFileSync } from 'node:fs';
import { CommandSigner, GuardedSigner } from '@bulwarkxyz/executor';
import { buildAssetIndex, dexCollateral, policyHash, type Policy, type RawClearinghouseState } from '@bulwarkxyz/guard-core';
import { NonceManager, parseExchangeResponse, type Hex, type SignedRequest } from '@bulwarkxyz/hyperliquid';
import { LocalDigestSigner } from '@bulwarkxyz/signer';
import { MemoryStore } from '@bulwarkxyz/store';
import { describe, expect, it } from 'vitest';
import { GuardEngine } from '../src/guard.js';
import { ConsoleNotifier } from '../src/notify.js';

// Recorded on testnet, 7 Oct 2026 (apps/ops testrun part3multi): BTC + ETH in the main pool, GOLD in the xyz pool,
// one line at 15×, then a 0.23 USDC deposit into the main pool. The live guard placed three backstops, then re-priced
// BTC's and ETH's once each and left GOLD's alone. The same engine, fed the same states, must do exactly that.
const fx = JSON.parse(readFileSync(new URL('../../../packages/guard-core/test/fixtures/multi-position-testnet-2026-10-07.json', import.meta.url), 'utf8'));
const ACCOUNT = '0x00000000000000000000000000000000000c0ffe' as Hex;
const policy: Policy = { version: 1, account: ACCOUNT, rules: [{ id: 'line', when: { kind: 'buffer', below: fx.line }, then: [{ kind: 'alert' }], repeat: { mode: 'everyCrossing' } }], execution: { maxSlippagePct: 1 } };
type State = { dexStates: Record<string, RawClearinghouseState & { assetPositions: Array<{ position: { coin: string; szi: string; positionValue: string } }> }>; spot: never };
const marksOf = (s: State) => new Map(Object.values(s.dexStates).flatMap((d) => d.assetPositions.map((p) => [p.position.coin, Number(p.position.positionValue) / Math.abs(Number(p.position.szi))] as [string, number])));

function setup() {
  let t = 1_791_370_400_000;
  const store = new MemoryStore();
  store.putUser({ account: ACCOUNT, agentKeyRef: 'local:test', agentAddress: '0x00000000000000000000000000000000000a6e47', region: 'allowed', telegramChatId: null, killSwitch: false, builderApproved: false });
  store.putPolicy(ACCOUNT, { policy, hash: policyHash(policy), signature: '0x00', signatureVerified: true, confirmedAt: t });
  // A fake exchange that keeps resting triggers, as Hyperliquid does, so the guard sees its own orders.
  const resting = new Map<number, { coin: string; triggerPx: number; size: number }>();
  const sent: SignedRequest[] = [];
  let oid = 1000;
  const engine = new GuardEngine({
    network: 'testnet',
    assets: buildAssetIndex(fx.perpDexs, fx.metas),
    collateral: dexCollateral(fx.perpDexs, fx.metas),
    store,
    notifier: new ConsoleNotifier(),
    exchange: {
      async send(req) {
        sent.push(req);
        const a = req.action as { type: string; orders?: Array<{ a: number; p: string; s: string; t: { trigger?: { triggerPx: string } } }>; cancels?: Array<{ o: number }> };
        if (a.type === 'order' && a.orders?.[0]?.t.trigger) {
          const id = oid++;
          resting.set(id, { coin: '', triggerPx: Number(a.orders[0].t.trigger.triggerPx), size: Number(a.orders[0].s) });
          return parseExchangeResponse({ status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: id } }] } } });
        }
        if (a.type === 'cancel') {
          for (const c of a.cancels ?? []) resting.delete(c.o);
          return parseExchangeResponse({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } });
        }
        return parseExchangeResponse({ status: 'ok', response: { type: 'default' } });
      },
    },
    nonces: new NonceManager(() => t),
    openOrders: async (_user, dex) => {
      const mine = await store.guardOrders(ACCOUNT);
      return mine.filter((o) => resting.has(o.oid) && (dex === 'xyz') === o.coin.startsWith('xyz:')).map((o) => ({ coin: o.coin, oid: o.oid, side: 'A' as const, reduceOnly: true, isTrigger: true, triggerPx: o.triggerPx, size: o.size }));
    },
    abstraction: async () => 'disabled',
    signerFor: async () => new GuardedSigner(new LocalDigestSigner(`0x${'5a'.repeat(32)}`), false),
    commandSignerFor: async () => new CommandSigner(new LocalDigestSigner(`0x${'5a'.repeat(32)}`), false),
    builder: null,
    backstopPricing: 'together',
    agents: async () => [{ address: '0x00000000000000000000000000000000000a6e47', validUntil: null }],
    now: () => t,
  });
  const feed = async (s: State) => {
    await engine.onSpotState(ACCOUNT, s.spot, t);
    await engine.onUserState(ACCOUNT, Object.entries(s.dexStates) as never, t);
    await engine.onMarks(marksOf(s), t);
  };
  const flat = async (s: State, minutes: number) => {
    for (let i = 0; i < (minutes * 60) / 5; i++) {
      t += 5000;
      await feed(s);
    }
  };
  return { store, sent, feed, flat, advance: (ms: number) => (t += ms) };
}

const triggersIn = (reqs: SignedRequest[]) =>
  reqs.flatMap((r) => ((r.action as { type: string }).type === 'order' ? (r.action as { orders: Array<{ t: { trigger?: { triggerPx: string } } }> }).orders.filter((o) => o.t.trigger).map((o) => Number(o.t.trigger!.triggerPx)) : []));
const cancelsIn = (reqs: SignedRequest[]) => reqs.filter((r) => (r.action as { type: string }).type === 'cancel').length;

describe('the guard on recorded testnet state: several positions in one pool', () => {
  it('places what the live guard placed, re-prices BTC and ETH once after the deposit, and does nothing more on a flat market', async () => {
    const g = setup();
    await g.feed(fx.states.marginsSet);
    const placed = await g.store.guardOrders(ACCOUNT);
    expect(placed.map((o) => o.coin).sort()).toEqual(['BTC', 'ETH', 'xyz:GOLD']);
    for (const o of placed) expect(Math.abs(o.triggerPx - fx.live.marginsSet[o.coin]) / fx.live.marginsSet[o.coin], o.coin).toBeLessThan(0.005);
    expect(placed.filter((o) => o.coin !== 'xyz:GOLD').every((o) => o.pricing === 'together')).toBe(true);

    let n = g.sent.length;
    await g.flat(fx.states.marginsSet, 3);
    expect(g.sent.length - n).toBe(0); // flat market: nothing

    n = g.sent.length;
    g.advance(5000);
    await g.feed(fx.states.afterDeposit);
    const after = g.sent.slice(n);
    expect(cancelsIn(after)).toBe(2);
    expect(triggersIn(after)).toHaveLength(2);
    const now = await g.store.guardOrders(ACCOUNT);
    for (const o of now) expect(Math.abs(o.triggerPx - fx.live.afterDeposit[o.coin]) / fx.live.afterDeposit[o.coin], o.coin).toBeLessThan(0.005);
    expect(now.find((o) => o.coin === 'xyz:GOLD')!.oid).toBe(placed.find((o) => o.coin === 'xyz:GOLD')!.oid); // GOLD untouched

    n = g.sent.length;
    await g.flat(fx.states.afterDeposit, 3);
    expect(g.sent.length - n).toBe(0);
  });
});
