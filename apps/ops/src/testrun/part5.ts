/**
 * Test run, part 5: the funded mainnet canary (REAL MONEY, inside the 13 USDC already on Hyperliquid). The wallet
 * owner runs it at a terminal and types "yes" before every step; it never runs from a script, a pipe or with an
 * advance approval.
 *
 * Bulwark's hosted guard runs on testnet only, so the guard for the canary runs here, in this process: the same
 * engine code as the hosted worker (apps/worker/src/guard.ts, its seven checks and its signer), against Hyperliquid
 * mainnet, with a guard key made for this run, approved by the wallet as agent "bulwark-canary" for 24 hours, and
 * deleted from this Mac at the end. Its alerts go to the Telegram chat linked to the test wallet in the app.
 *
 * Steps: approve the guard key; move 12 USDC into the xyz pool; buy about $24 of CL; place your own stop-loss
 * 2.5% below; sign one rule (trim 50% when the buffer is below a line just above it, once per fall); the guard trims
 * 50% at once; watch 60 s for anything more; close everything; move the balance back. The most it can lose is shown
 * before the first step, and the run closes everything if the open loss reaches that amount.
 *
 *   pnpm --filter @bulwarkxyz/ops testrun part5 [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { CommandSigner, GuardedSigner } from '@bulwarkxyz/executor';
import { POLICY_CONFIRMATION_TYPES, buildAssetIndex, ceilSize, dexCollateral, policyConfirmationDomain, policyHash, roundPrice, toWire, type OpenOrder, type Policy, type RawPerpDexs, type RawPerpMeta } from '@bulwarkxyz/guard-core';
import { ExchangeClient, InfoClient, NonceManager, USDC_TOKEN, agentName, approveAgentAction, cancelAction, l1ActionHash, l1TypedData, orderAction, orderWire, sendAssetAction, updateLeverageAction, userSignedTypedData, type ExchangeResult, type Hex, type L1Action, type UserSignedAction } from '@bulwarkxyz/hyperliquid';
import { LocalDigestSigner } from '@bulwarkxyz/signer';
import { parseSignature, verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { LIMIT_USDC, RUN_DIR, Refused, RunLog, WALLET, approveTestnetStepsInAdvance, checkDestination, confirm, loadWallet } from './guard.js';
import { Session } from './session.js';

export const CANARY = { coin: 'xyz:CL', rehearsalCoin: 'xyz:GOLD', positionUsd: 24, poolUsdc: 12, leverage: 5, trimFraction: 0.5, stopBelowPct: 2.5, slippagePct: 1, openSlippagePct: 0.5, feeRateAssumed: 0.001, agent: 'bulwark-canary', agentHours: 24, watchAfterTrimMs: 60_000 };
const GUARD_KEYCHAIN = { service: 'bulwark-canary-guard', account: 'bulwark' } as const;
const REAL_MONEY = `Real money on Hyperliquid mainnet, inside the ${LIMIT_USDC} USDC already deposited. Nothing new is deposited.`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rsv = (sig: Hex) => {
  const p = parseSignature(sig);
  return { r: p.r, s: p.s, v: Number(p.v ?? 27n + BigInt(p.yParity)) as 27 | 28 };
};

/** The most the canary can lose, from its own numbers (shown before the first yes, enforced while it runs). */
export function maxLoss(c = CANARY): { total: number; parts: Record<string, number> } {
  const fills = c.positionUsd * 2; // open, then trim and close (or the stop) of the same size in total
  const parts = {
    fees: fills * c.feeRateAssumed,
    open: (c.positionUsd * c.openSlippagePct) / 100,
    toStop: (c.positionUsd * c.stopBelowPct) / 100,
    stopFill: (c.positionUsd * c.slippagePct) / 100,
  };
  return { total: Math.round(Object.values(parts).reduce((a, b) => a + b, 0) * 100) / 100, parts };
}

export async function part5(opts: { dryRun: boolean; rehearse?: boolean; ownerApproved?: string }): Promise<void> {
  // --rehearse: the identical flow on testnet with mock USDC, to prove the wiring before the real run.
  const net = opts.rehearse ? ('testnet' as const) : ('mainnet' as const);
  const chain = opts.rehearse ? ('Testnet' as const) : ('Mainnet' as const);
  const isMainnet = !opts.rehearse;
  const usdcToken = USDC_TOKEN[net];
  const MONEY = opts.rehearse ? 'REHEARSAL on testnet: mock USDC, no real money.' : REAL_MONEY;
  const log = new RunLog(opts.rehearse ? 'part5-rehearsal-testnet' : 'part5-mainnet-canary');
  // Testnet's CL is isolated-only with an empty book, so the rehearsal trades GOLD (cross, two-sided); mainnet CL.
  const COIN = opts.rehearse ? CANARY.rehearsalCoin : CANARY.coin;
  const ticker = COIN.replace(/^xyz:/, '');
  if (opts.rehearse && opts.ownerApproved) approveTestnetStepsInAdvance(opts.ownerApproved, log);
  // Reads wait out Hyperliquid's per-IP rate limit (429) instead of stopping the run (7 Oct rehearsal: a 429 right
  // after the buy left the position open).
  const patientFetch: typeof fetch = async (input, init) => {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(input, init);
      if (res.status !== 429 || attempt >= 8) return res;
      await sleep(1500 * attempt);
    }
  };
  const info = new InfoClient(net, patientFetch, 20_000);
  const exchange = new ExchangeClient(net);
  const evidence: Record<string, unknown> = { wallet: WALLET, network: net, canary: CANARY, steps: [] as unknown[] };
  const step = (name: string, data: unknown) => {
    (evidence.steps as unknown[]).push({ at: new Date().toISOString(), name, data });
    log.write(name, { network: net, data });
  };
  const loss = maxLoss();

  // Preflight (read-only).
  const perpDexs = (await info.perpDexs()) as RawPerpDexs;
  const metas = (await info.allPerpMetas()) as RawPerpMeta[];
  const assets = buildAssetIndex(perpDexs, metas);
  const collateral = dexCollateral(perpDexs, metas);
  const asset = assets.get(COIN)!;
  const value = async (dex: string) => Number(((await info.clearinghouseState(WALLET, dex)) as { marginSummary: { accountValue: string } }).marginSummary.accountValue);
  const positionsNow = async () => {
    const out: Array<{ coin: string; szi: number }> = [];
    for (const dex of ['', 'xyz']) for (const p of ((await info.clearinghouseState(WALLET, dex)) as { assetPositions: Array<{ position: { coin: string; szi: string } }> }).assetPositions) out.push({ coin: p.position.coin, szi: Number(p.position.szi) });
    return out.filter((p) => p.szi !== 0);
  };
  const book = async () => {
    const b = (await info.request<{ levels: Array<Array<{ px: string }>> }>({ type: 'l2Book', coin: COIN })).levels;
    const bid = Number(b[0]?.[0]?.px), ask = Number(b[1]?.[0]?.px);
    if (!(bid > 0 && ask > 0)) throw new Refused(`${COIN}'s book on ${net} has no ${bid > 0 ? 'asks' : 'bids'} right now; nothing more was done.`);
    return { bid, ask };
  };
  const mode = await info.userAbstraction(WALLET);
  const [mainValue, xyzValue] = [await value(''), await value('xyz')];
  const b0 = await book();
  const size = ceilSize(CANARY.positionUsd / b0.ask, asset.szDecimals);
  console.log(`\n${opts.rehearse ? 'REHEARSAL ON TESTNET (mock USDC) of the' : 'MAINNET'} CANARY, test wallet ${WALLET}
  Balances now: main perps ${mainValue.toFixed(2)} USDC, xyz pool ${xyzValue.toFixed(2)} USDC; account mode ${mode}; open positions: ${(await positionsNow()).length}.
  ${ticker} book: bid ${b0.bid} / ask ${b0.ask}.

  The plan (each step asks for "yes" first):
   1. Approve a guard key made for this run as agent "${CANARY.agent}" for ${CANARY.agentHours} hours. It can trade but never withdraw. No money moves.
   2. Move ${CANARY.poolUsdc} USDC from your main perps balance into the xyz pool, to yourself.
   3. ${CANARY.leverage}x cross on ${ticker}; buy ${size} ${ticker} (about $${(size * b0.ask).toFixed(2)}), at most ${CANARY.openSlippagePct}% above the ask, immediate-or-cancel.
   4. Your own stop-loss: a reduce-only stop that sells all of it if ${ticker}'s mark falls ${CANARY.stopBelowPct}% (limit ${CANARY.slippagePct}% below that).
   5. Sign one rule with your wallet: "when the xyz pool's buffer is below <a line just above where it is>, trim the position by 50%, once per fall".
   6. The guard (Bulwark's engine, running here) trims about half (about $12, reduce-only, at most ${CANARY.slippagePct}% from the book) and sends the Telegram alert. Then 60 seconds of watching: it must not act again.
   7. Close: cancel the open stops, sell what is left (reduce-only), move the xyz pool's balance back to main perps.
   8. The guard key is deleted from this Mac; its approval on Hyperliquid expires within ${CANARY.agentHours} hours.

  Fees: about ${(CANARY.feeRateAssumed * 100).toFixed(2)}% per fill assumed (your account's base rate is lower), on about $${(CANARY.positionUsd * 2).toFixed(0)} of fills.
  The most the canary can lose: $${loss.total.toFixed(2)} (fees $${loss.parts.fees!.toFixed(2)}, buying above the ask $${loss.parts.open!.toFixed(2)}, a fall to your stop $${loss.parts.toStop!.toFixed(2)}, the stop filling ${CANARY.slippagePct}% lower $${loss.parts.stopFill!.toFixed(2)}).
  If the open loss reaches $${loss.total.toFixed(2)} at any check, the run goes straight to closing.
  After it, about $${(mainValue + xyzValue - loss.total).toFixed(2)} or more stays for the withdrawal (less Hyperliquid's $1 withdrawal fee).
  ${MONEY}`);
  if (opts.dryRun) return;
  if (mode === 'unifiedAccount') throw new Refused(`The test wallet is in unified mode on ${net}; this plan is for standard mode.`);
  if ((await positionsNow()).length) throw new Refused(`The test wallet has open positions on ${net}; close them first.`);
  if (mainValue + xyzValue < CANARY.poolUsdc + 0.5) throw new Refused(`Not enough USDC on ${net} (${(mainValue + xyzValue).toFixed(2)}).`);
  if (loss.total > 1.5) throw new Refused(`The plan's worst case ($${loss.total}) is above $1.50.`);

  const wallet = loadWallet();
  const userSigned = async (name: string, action: UserSignedAction): Promise<ExchangeResult> => {
    const sig = rsv(await wallet.signTypedData(userSignedTypedData(action) as never));
    const res = await exchange.send({ action, nonce: 'nonce' in action ? action.nonce : (action as { time: number }).time, signature: sig });
    step(name, { ok: res.ok, error: res.error ?? null, statuses: res.statuses });
    return res;
  };
  let lastNonce = 0;
  const walletL1 = async (name: string, action: L1Action): Promise<ExchangeResult> => {
    const nonce = (lastNonce = Math.max(Date.now(), lastNonce + 1));
    const sig = rsv(await wallet.signTypedData(l1TypedData(l1ActionHash({ action, nonce }), isMainnet) as never));
    const res = await exchange.send({ action, nonce, signature: sig });
    step(name, { ok: res.ok, error: res.error ?? null, statuses: res.statuses, action });
    return res;
  };
  const ask = (what: string, amount: string, notes?: string[]) => confirm({ what, amount, limit: MONEY, ...(notes ? { notes } : {}) });
  const start = { main: mainValue, xyz: xyzValue };
  evidence.start = start;

  // Telegram: the chat linked to the test wallet in the app (signed in to the hosted app's API; that signature
  // authorises nothing), and the bot's token from this Mac's secrets folder (never printed).
  let chatId: string | null = null;
  let botToken: string | null = null;
  try {
    const s = new Session(log, wallet);
    await s.signIn();
    chatId = (await s.api<{ chatId: string | null }>('/v1/telegram')).body.chatId ?? null;
    botToken = readFileSync(`${homedir()}/bulwark-secrets/telegram-token.txt`, 'utf8').trim() || null;
  } catch (e) {
    console.log(`  Telegram: not available (${e instanceof Error ? e.message.split('\n')[0] : String(e)}).`);
  }
  console.log(`  Telegram: ${chatId && botToken ? 'linked; the guard\'s alert will arrive in your chat with @BulwarkGuardBot' : 'NOT linked: the guard still acts, the alert is only printed here'}.`);
  if (!(await ask('Start the canary with the plan above.', `Up to $${loss.total.toFixed(2)} at risk; ${CANARY.poolUsdc} USDC moved into the xyz pool.`))) return void console.log('Stopped; nothing was done.');

  let retireKey = () => {};
  let validUntil = 0;
  // Anything that goes wrong after this point goes straight to closing (which still asks first).
  const body = async (): Promise<void> => {
    // 1. the guard key for this run.
    const guardKey = generatePrivateKey();
    execFileSync('security', ['add-generic-password', '-U', '-s', GUARD_KEYCHAIN.service, '-a', GUARD_KEYCHAIN.account, '-w', guardKey], { stdio: 'ignore' });
    const guardAddress = privateKeyToAccount(guardKey).address;
    retireKey = () => {
      try {
        execFileSync('security', ['delete-generic-password', '-s', GUARD_KEYCHAIN.service, '-a', GUARD_KEYCHAIN.account], { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    };
    process.on('exit', retireKey);
    validUntil = Date.now() + CANARY.agentHours * 3_600_000;
    if (!(await ask(`Approve the guard key ${guardAddress} on Hyperliquid ${net} as agent "${CANARY.agent}", valid for ${CANARY.agentHours} hours. Agents can trade but cannot withdraw.`, 'No money moves.'))) return;
    const ap = await userSigned('approve guard key', approveAgentAction({ chain, signatureChainId: '0xa4b1', agentAddress: guardAddress, agentName: agentName(CANARY.agent, validUntil), nonce: Date.now() }));
    if (!ap.ok) throw new Error(`approval refused: ${ap.error}`);

    // 2. margin into the xyz pool.
    checkDestination('self', WALLET);
    const need = Math.round((CANARY.poolUsdc - (await value('xyz'))) * 100) / 100;
    if (need > 0.01) {
      if (!(await ask(`Move ${need} USDC from your main perps balance into the xyz pool, to yourself (${WALLET}).`, `${need} USDC.`))) return;
      const mv = await userSigned('fund xyz pool', sendAssetAction({ chain, signatureChainId: '0xa4b1', destination: WALLET, sourceDex: '', destinationDex: 'xyz', token: usdcToken, amount: String(need), nonce: Date.now() }));
      if (!mv.ok) throw new Error(`transfer refused: ${mv.error}`);
    }
    await sleep(1500);

    // 3. the position.
    const b1 = await book();
    const limit = roundPrice(b1.ask * (1 + CANARY.openSlippagePct / 100), asset.szDecimals, 'up');
    if (!(await ask(`Set ${CANARY.leverage}x cross on ${ticker}, then buy ${size} ${ticker} at most ${limit} (ask ${b1.ask}), immediate-or-cancel.`, `About $${(size * b1.ask).toFixed(2)} of ${ticker}.`))) return closeAll('stopped before buying');
    await walletL1(`leverage ${ticker}`, updateLeverageAction(asset.assetId, true, CANARY.leverage));
    const op = await walletL1(`buy ${ticker}`, orderAction([orderWire({ asset: asset.assetId, isBuy: true, limitPx: toWire(limit), size: toWire(size), reduceOnly: false, orderType: { limit: { tif: 'Ioc' } } })]));
    console.log(`  Buy: ${JSON.stringify(op.statuses)}`);
    await sleep(1500);
    const held = (await positionsNow()).find((p) => p.coin === COIN);
    if (!held) return closeAll('the buy did not fill');

    // 4. your own stop-loss.
    const mark0 = await markOf();
    const trig = roundPrice(mark0 * (1 - CANARY.stopBelowPct / 100), asset.szDecimals, 'down');
    const stopLimit = roundPrice(trig * (1 - CANARY.slippagePct / 100), asset.szDecimals, 'down');
    if (await ask(`Place your own stop-loss: sell all ${held.szi} ${ticker}, reduce-only, if ${ticker}'s mark falls to ${trig} (limit ${stopLimit}).`, `${held.szi} ${ticker}; closes the position only.`)) {
      const sl = await walletL1('your stop-loss', orderAction([orderWire({ asset: asset.assetId, isBuy: false, limitPx: toWire(stopLimit), size: toWire(held.szi), reduceOnly: true, orderType: { trigger: { isMarket: true, triggerPx: toWire(trig), tpsl: 'sl' } } })]));
      console.log(`  Stop-loss: ${JSON.stringify(sl.statuses)}`);
    }

    // 5. the rule, signed by the wallet as the app's Sign button does.
    const { MemoryStore } = await importFromWorker<{ MemoryStore: new () => MemStore }>('@bulwarkxyz/store');
    const { GuardEngine } = await importWorkerSrc<{ GuardEngine: new (deps: unknown) => Engine }>('guard.ts');
    const { TelegramNotifier, ConsoleNotifier } = await importWorkerSrc<{ TelegramNotifier: new (t: string) => Notifier; ConsoleNotifier: new () => Notifier & { sent: unknown[] } }>('notify.ts');
    const { HyperliquidStream } = await importWorkerSrc<{ HyperliquidStream: new (url: string, h: { onCoinMark(coin: string, mark: number, at: number): void }) => { subscribeCoin(c: string): boolean; start(): void; stop(): void } }>('stream.ts');
    const xyzState = (await info.clearinghouseState(WALLET, 'xyz')) as { marginSummary: { accountValue: string }; crossMaintenanceMarginUsed: string };
    const buffer = Number(xyzState.marginSummary.accountValue) / Number(xyzState.crossMaintenanceMarginUsed);
    const line = Math.ceil(buffer * 1.15 * 100) / 100;
    const policy: Policy = { version: 1, account: WALLET.toLowerCase() as Hex, rules: [{ id: 'canary-trim', when: { kind: 'buffer', below: line }, then: [{ kind: 'reduce', target: { kind: 'first_position' }, fraction: CANARY.trimFraction }], repeat: { mode: 'oncePerBreach' } }], execution: { maxSlippagePct: CANARY.slippagePct } };
    if (!(await ask(`Sign the rule: "when the xyz pool's buffer is below ${line}x, trim the first position by 50%, once per fall". Your buffer is ${buffer.toFixed(2)}x, so the guard trims at once.`, `About half the ${ticker} position (about $${((Math.abs(held.szi) * mark0) / 2).toFixed(2)}).`))) return closeAll('stopped before the rule');
    const domain = policyConfirmationDomain(42161);
    const message = { account: WALLET, version: BigInt(policy.version), policyHash: policyHash(policy) };
    const signature = await wallet.signTypedData({ domain, types: POLICY_CONFIRMATION_TYPES, primaryType: 'BulwarkPolicy', message });
    const verified = await verifyTypedData({ address: WALLET, domain, types: POLICY_CONFIRMATION_TYPES, primaryType: 'BulwarkPolicy', message, signature });
    step('rule signed', { policy, hash: policyHash(policy), signature, verified });

    // 6. the guard, here: the hosted worker's engine against mainnet.
    const store = new MemoryStore();
    // Not linked: the alert the guard would send is still built, and printed here and kept in the evidence.
    store.putUser({ account: WALLET, agentKeyRef: 'local:canary', agentAddress: guardAddress.toLowerCase() as Hex, region: 'allowed', telegramChatId: chatId && botToken ? chatId : 'console', killSwitch: false, builderApproved: false });
    store.putPolicy(WALLET, { policy, hash: policyHash(policy), signature, signatureVerified: verified, confirmedAt: Date.now() });
    const notifier = chatId && botToken ? new TelegramNotifier(botToken) : new ConsoleNotifier();
    const alerts: Array<{ at: string; text: string }> = [];
    const engine = new GuardEngine({
      network: net,
      assets,
      collateral,
      store,
      notifier: { send: async (chat: string, text: string) => (alerts.push({ at: new Date().toISOString(), text }), console.log(`  Alert${chat === 'console' ? ' (not linked; printed only)' : ' sent to Telegram'}: ${text.replace(/\n/g, ' | ')}`), notifier.send(chat, text)) },
      exchange,
      nonces: new NonceManager(),
      openOrders: async (user: Hex, dex: string) => ((await info.frontendOpenOrders(user, dex)) as Array<{ coin: string; oid: number; side: 'B' | 'A'; reduceOnly: boolean; isTrigger: boolean; triggerPx?: string; sz: string }>).map((r): OpenOrder => ({ coin: r.coin, oid: r.oid, side: r.side, reduceOnly: r.reduceOnly, isTrigger: r.isTrigger, ...(r.triggerPx ? { triggerPx: Number(r.triggerPx) } : {}), size: Number(r.sz) })),
      abstraction: (user: Hex) => info.userAbstraction(user),
      signerFor: async () => new GuardedSigner(new LocalDigestSigner(guardKey), isMainnet),
      commandSignerFor: async () => new CommandSigner(new LocalDigestSigner(guardKey), isMainnet),
      builder: null,
      backstopPricing: 'single',
      agents: async (user: Hex) => (await info.extraAgents(user)) as Array<{ address: string; validUntil?: number | null }>,
    // As the hosted worker: an order sent without an answer back is looked up by its client order id before any retry.
    orderStatus: async (user: Hex, cloid: Hex) => {
      const r = await info.request<{ status: string; order?: { status: string; order: { origSz: string; sz: string } } }>({ type: 'orderStatus', user, oid: cloid });
      if (r.status !== 'order' || !r.order) return null;
      return { status: r.order.status, origSz: Number(r.order.order.origSz), sz: Number(r.order.order.sz) };
    },
      now: Date.now,
    });
    const stream = new HyperliquidStream(opts.rehearse ? 'wss://api.hyperliquid-testnet.xyz/ws' : 'wss://api.hyperliquid.xyz/ws', { onCoinMark: (coin, mark, at) => void engine.onMarks(new Map([[coin, mark]]), at) });
    stream.subscribeCoin(COIN);
    stream.start();
    let polling = true;
    const poll = (async () => {
      while (polling) {
        try {
          const at = Date.now();
          const [main, xyz, spot] = await Promise.all([info.clearinghouseState(WALLET, ''), info.clearinghouseState(WALLET, 'xyz'), info.spotClearinghouseState(WALLET)]);
          await engine.onSpotState(WALLET.toLowerCase(), spot as never, at);
          await engine.onUserState(WALLET.toLowerCase(), [['', main as never], ['xyz', xyz as never]], at);
        } catch (e) {
          console.log(`  (state read failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}; retrying)`);
        }
        await sleep(2000);
      }
    })();
    console.log('\n  The guard is running. Waiting for the trim (up to 2 minutes)…');
    const t0 = Date.now();
    const entries = () => store.audit.raw(WALLET.toLowerCase()) as Array<{ seq: number; at: number; kind: string; why: string; what: string; proof?: Record<string, unknown> }>;
    const trims = () => entries().filter((e) => e.kind === 'guard_action' && (e.proof as { ruleId?: string } | undefined)?.ruleId === 'canary-trim' && /^order/.test(e.what));
    let shown = 0;
    const show = () => {
      for (const e of entries().slice(shown)) console.log(`  [${new Date(e.at).toISOString().slice(11, 19)}] ${e.kind}: ${e.what}`);
      shown = entries().length;
    };
    const lossNow = async () => start.main + start.xyz - (await value('')) - (await value('xyz'));
    while (Date.now() - t0 < 120_000 && !trims().length) {
      await sleep(2000);
      show();
      if ((await lossNow()) >= loss.total) break;
    }
    const trimAt = Date.now();
    if (trims().length) {
      console.log(`  Trimmed ${((trimAt - t0) / 1000).toFixed(1)} s after the guard started. Watching 60 s for anything more…`);
      while (Date.now() - trimAt < CANARY.watchAfterTrimMs) {
        await sleep(3000);
        show();
        if ((await lossNow()) >= loss.total) break;
      }
    } else console.log('  No trim within 2 minutes (or the loss limit was reached).');
    polling = false;
    await poll;
    stream.stop();
    show();
    evidence.audit = entries();
    evidence.alerts = alerts;
    evidence.trims = trims().length;
    return closeAll(trims().length === 1 ? 'canary done' : `trims: ${trims().length}`);
  };
  try {
    return await body();
  } catch (e) {
    const why = e instanceof Error ? e.message.split('\n')[0] : String(e);
    console.log(`\n  Stopped by an error: ${why}`);
    step('error', { message: why });
    return closeAll(`after an error: ${why}`);
  }

  async function markOf(): Promise<number> {
    const [m, c] = (await info.metaAndAssetCtxs('xyz')) as [{ universe: Array<{ name: string }> }, Array<{ markPx: string }>];
    return Number(c[m.universe.findIndex((u) => u.name === COIN)]!.markPx);
  }

  // 7. close everything and move the balance back; 8. delete the guard key.
  async function closeAll(why: string): Promise<void> {
    console.log(`\n  Closing (${why}).`);
    const open = (await info.frontendOpenOrders(WALLET, 'xyz')) as Array<{ coin: string; oid: number }>;
    const pos = (await positionsNow()).find((p) => p.coin === COIN);
    if (open.length || pos) {
      const ok = await ask(`Cancel ${open.length} open order(s) on the xyz pool${pos ? ` and sell the remaining ${pos.szi} ${ticker} (reduce-only, at most ${CANARY.slippagePct}% below the bid)` : ''}.`, pos ? `${pos.szi} ${ticker}.` : 'No position.', ['If you type anything else, close it yourself on app.hyperliquid.xyz now.']);
      if (ok) {
        if (open.length) await walletL1('cancel open orders', cancelAction(open.map((o) => ({ asset: asset.assetId, oid: o.oid }))));
        // Sell until nothing is left (a thin book can fill part: 7 Oct rehearsal), at most 6 tries.
        for (let i = 0; i < 6; i++) {
          const left = (await positionsNow()).find((p) => p.coin === COIN);
          if (!left) break;
          let b: { bid: number; ask: number };
          try {
            b = await book();
          } catch {
            console.log(`  No bids for ${ticker} right now; trying again in 10 s.`);
            await sleep(10_000);
            continue;
          }
          const px = roundPrice(b.bid * (1 - CANARY.slippagePct / 100), asset.szDecimals, 'down');
          const r = await walletL1(`close ${ticker}`, orderAction([orderWire({ asset: asset.assetId, isBuy: false, limitPx: toWire(px), size: toWire(Math.abs(left.szi)), reduceOnly: true, orderType: { limit: { tif: 'Ioc' } } })]));
          console.log(`  Close: ${JSON.stringify(r.statuses)}`);
          await sleep(2000);
        }
        const still = (await positionsNow()).find((p) => p.coin === COIN);
        if (still) console.log(`\n  STILL OPEN: ${still.szi} ${ticker}. Close it yourself now on app.hyperliquid.xyz (Positions › Close), then tell Claude.`);
        await sleep(2000);
      }
    }
    const back = Math.floor((await value('xyz')) * 100) / 100;
    if (back > 0 && !(await positionsNow()).length && (await ask(`Move ${back} USDC from the xyz pool back to your main perps balance, to yourself.`, `${back} USDC.`))) {
      await userSigned('move balance back', sendAssetAction({ chain, signatureChainId: '0xa4b1', destination: WALLET, sourceDex: 'xyz', destinationDex: '', token: usdcToken, amount: String(back), nonce: Date.now() }));
      await sleep(1500);
    }
    retireKey();
    const end = { main: await value(''), xyz: await value('xyz'), positions: await positionsNow() };
    evidence.end = end;
    evidence.cost = Math.round((start.main + start.xyz - end.main - end.xyz) * 10000) / 10000;
    const file = new URL(`evidence-canary-${net}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, RUN_DIR);
    writeFileSync(file, JSON.stringify(evidence, null, 1));
    console.log(`\n  Done. Cost of the canary: $${evidence.cost} (start ${(start.main + start.xyz).toFixed(4)}, end ${(end.main + end.xyz).toFixed(4)} USDC). Open positions: ${end.positions.length}.
  The guard key is deleted from this Mac; its approval expires on ${new Date(validUntil).toISOString()}.
  Evidence: ${file.pathname}
  Tell Claude the canary is done.`);
  }
}

interface MemStore {
  putUser(u: Record<string, unknown>): void;
  putPolicy(account: string, cp: Record<string, unknown>): void;
  audit: { raw(account: string): unknown[] };
}
interface Engine {
  onMarks(m: ReadonlyMap<string, number>, at: number): Promise<unknown>;
  onUserState(a: string, s: unknown, at: number): Promise<void>;
  onSpotState(a: string, s: unknown, at: number): Promise<void>;
}
interface Notifier {
  send(chat: string, text: string): Promise<void>;
}
/** The hosted worker's own code, loaded from apps/worker (the same files the hosted guard runs). */
async function importWorkerSrc<T>(file: string): Promise<T> {
  return (await import(new URL(`../../../worker/src/${file}`, import.meta.url).href)) as T;
}
async function importFromWorker<T>(pkg: string): Promise<T> {
  // The workspace packages export ESM only ("import" in their exports map), which require.resolve cannot see:
  // read the package's own entry from its package.json under the worker's node_modules.
  const dir = new URL(`../../../worker/node_modules/${pkg}/`, import.meta.url);
  const meta = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8')) as { exports?: { '.'?: { import?: string } }; main?: string };
  const entry = meta.exports?.['.']?.import ?? meta.main ?? 'index.js';
  return (await import(new URL(entry, dir).href)) as T;
}
