/**
 * The guard engine's own cost with many accounts in one process: N accounts, each with a CL position and signed
 * rules (a trim stage and a backstop line), a fake exchange that answers at once. Times the first evaluation
 * (backstops placed), a calm price tick, and a crash tick where every account crosses its line at once.
 *
 *   npx tsx bench/engine-scale.ts
 */
import { readFileSync } from 'node:fs';
import { CommandSigner, GuardedSigner } from '@bulwarkxyz/executor';
import { buildAssetIndex, dexCollateral, maintenanceMargin, policyHash, type Policy, type RawClearinghouseState } from '@bulwarkxyz/guard-core';
import { NonceManager, parseExchangeResponse, type Hex } from '@bulwarkxyz/hyperliquid';
import { LocalDigestSigner } from '@bulwarkxyz/signer';
import { MemoryStore } from '@bulwarkxyz/store';
import { GuardEngine } from '../src/guard.js';
import { ConsoleNotifier } from '../src/notify.js';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`../../../packages/guard-core/test/fixtures/${n}`, import.meta.url), 'utf8'));
const assets = buildAssetIndex(fx('perpDexs.json'), fx('allPerpMetas.json'));
const collateral = dexCollateral(fx('perpDexs.json'), fx('allPerpMetas.json'));
function xyz(size: number, mark: number, equity: number): RawClearinghouseState {
  const mm = maintenanceMargin(assets.get('xyz:CL')!.tiers, size * mark);
  const sum = { accountValue: String(equity), totalNtlPos: '0', totalRawUsd: String(equity - size * mark), totalMarginUsed: '0' };
  return { marginSummary: sum, crossMarginSummary: sum, crossMaintenanceMarginUsed: String(mm), withdrawable: '0', assetPositions: [{ type: 'oneWay', position: { coin: 'xyz:CL', szi: String(size), leverage: { type: 'cross', value: 5 }, entryPx: String(mark), positionValue: String(size * mark), unrealizedPnl: '0', liquidationPx: null, marginUsed: '0', maxLeverage: 20 } }], time: 0 } as never;
}
const empty = { ...xyz(0.0001, 1, 0), assetPositions: [] } as never;

async function run(n: number) {
  let t = 1_791_400_000_000;
  const store = new MemoryStore();
  const accounts = Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Hex);
  for (const a of accounts) {
    const policy: Policy = { version: 1, account: a, rules: [{ id: 'trim', when: { kind: 'buffer', below: 2 }, then: [{ kind: 'reduce', target: { kind: 'market', market: 'xyz:CL' }, fraction: 0.5 }], repeat: { mode: 'oncePerBreach' } }, { id: 'line', when: { kind: 'buffer', below: 1.2 }, then: [{ kind: 'alert' }], repeat: { mode: 'everyCrossing' } }], execution: { maxSlippagePct: 1 } };
    store.putUser({ account: a, agentKeyRef: 'local:b', agentAddress: '0x00000000000000000000000000000000000a6e47', region: 'allowed', telegramChatId: null, killSwitch: false, builderApproved: false });
    store.putPolicy(a, { policy, hash: policyHash(policy), signature: '0x00', signatureVerified: true, confirmedAt: t });
  }
  let oid = 1, sends = 0;
  const resting = new Set<number>();
  const engine = new GuardEngine({
    network: 'testnet', assets, collateral, store, notifier: new ConsoleNotifier(),
    exchange: { async send(req) {
      sends++;
      const a = req.action as { type: string; orders?: Array<{ s: string; t: { trigger?: unknown } }>; cancels?: Array<{ o: number }> };
      if (a.type === 'order' && a.orders?.[0]?.t.trigger) { const id = oid++; resting.add(id); return parseExchangeResponse({ status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: id } }] } } }); }
      if (a.type === 'order') return parseExchangeResponse({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: a.orders![0]!.s, avgPx: '80', oid: oid++ } }] } } });
      if (a.type === 'cancel') { for (const c of a.cancels ?? []) resting.delete(c.o); return parseExchangeResponse({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } }); }
      return parseExchangeResponse({ status: 'ok', response: { type: 'default' } });
    } },
    nonces: new NonceManager(() => t),
    openOrders: async (u, dex) => (dex === 'xyz' ? (await store.guardOrders(u)).filter((o) => resting.has(o.oid)).map((o) => ({ coin: o.coin, oid: o.oid, side: 'A' as const, reduceOnly: true, isTrigger: true, triggerPx: o.triggerPx, size: o.size })) : []),
    abstraction: async () => 'default',
    signerFor: async () => new GuardedSigner(new LocalDigestSigner(`0x${'5a'.repeat(32)}`), false),
    commandSignerFor: async () => new CommandSigner(new LocalDigestSigner(`0x${'5a'.repeat(32)}`), false),
    builder: null,
    agents: async () => [{ address: '0x00000000000000000000000000000000000a6e47', validUntil: null }],
    now: () => t,
  });
  const time = async (f: () => Promise<unknown>) => { const s = performance.now(); await f(); return Math.round(performance.now() - s); };
  // Calm: buffer about 10.9 (equity 6 on 0.24 CL at 91.5).
  const first = await time(async () => { for (const a of accounts) { await engine.onUserState(a, [['', empty], ['xyz', xyz(0.24, 91.5, 6)]], t); } await engine.onMarks(new Map([['xyz:CL', 91.5]]), t); });
  const placed = sends;
  t += 1000;
  const calm = await time(() => engine.onMarks(new Map([['xyz:CL', 91.4]]), t));
  const calmSends = sends - placed;
  t += 1000;
  const before = sends;
  for (const a of accounts) await engine.onUserState(a, [['', empty], ['xyz', xyz(0.24, 70, 1)]], t);
  const crash = await time(() => engine.onMarks(new Map([['xyz:CL', 70]]), t));
  return { accounts: n, firstMs: first, placedOrders: placed, calmTickMs: calm, calmTickSends: calmSends, crashTickMs: crash, crashSends: sends - before, heapMB: Math.round(process.memoryUsage().heapUsed / 1e6) };
}
for (const n of [100, 500, 2000]) console.log(JSON.stringify(await run(n)));
