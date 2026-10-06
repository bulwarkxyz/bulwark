/**
 * What every testnet part shares: the wallet's own signatures (Hyperliquid user-signed actions, SIWE and the
 * Bulwark policy, exactly as apps/app/lib/signing.ts builds them), the trading key for the user's own orders
 * (agent "bulwark-web", as the app's browser key), the Bulwark API on the live site, and the account's risk
 * the way the API and the guard compute it.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { builderField } from '@bulwarkxyz/config';
import { POLICY_CONFIRMATION_TYPES, assessRisk, buildAssetIndex, buildSnapshot, dexCollateral, policyConfirmationDomain, policyHash, type Policy, type RawPerpDexs, type RawPerpMeta } from '@bulwarkxyz/guard-core';
import { ExchangeClient, InfoClient, WeightLimiter, l1ActionHash, limitedFetch, l1TypedData, userSignedTypedData, type ExchangeResult, type Hex, type L1Action, type UserSignedAction } from '@bulwarkxyz/hyperliquid';
import { parseSignature } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { RunLog, WALLET } from './guard.js';

export const NET = 'testnet' as const;
export const CHAIN = 'Testnet' as const;
/** The chain id the wallet signs with (Arbitrum One), as in the app. */
export const WALLET_CHAIN_ID = 42161;
export const SIGNATURE_CHAIN_ID = '0xa4b1' as Hex;
export const SITE = 'https://bulwark.0xo.in';
/** The test run's own trading key for testnet orders, in the Keychain (created by part 2). */
const TRADING_KEYCHAIN = { service: 'bulwark-testrun-trading-testnet', account: 'bulwark' } as const;

const rsv = (sig: Hex) => {
  const p = parseSignature(sig);
  return { r: p.r, s: p.s, v: Number(p.v ?? 27n + BigInt(p.yParity)) as 27 | 28 };
};

/**
 * Reads share one weight budget and wait out a 429 (testnet's limit is per IP, shared with the app open in a
 * browser on the same machine), so a busy moment delays the run instead of stopping it.
 */
const limiter = new WeightLimiter(600);
const patientFetch: typeof fetch = async (input, init) => {
  // The caller's abort timer would run while we wait in the queue: each attempt gets its own, started after the wait.
  const { signal: _ignored, ...rest } = init ?? {};
  for (let attempt = 1; ; attempt++) {
    const res = await limitedFetch(limiter, (i, o) => fetch(i, { ...o, signal: AbortSignal.timeout(20_000) }), 120_000, 5_000)(input, rest);
    if (res.status !== 429 || attempt >= 6) return res;
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
};

export class Session {
  readonly info = new InfoClient(NET, patientFetch, 600_000);
  readonly exchange = new ExchangeClient(NET);
  private token: string | null = null;
  private lastNonce = 0;

  constructor(
    readonly log: RunLog,
    /** The wallet; null in a dry run, where nothing is signed. */
    readonly wallet: PrivateKeyAccount | null,
  ) {}

  private need(): PrivateKeyAccount {
    if (!this.wallet) throw new Error('dry run: nothing is signed');
    return this.wallet;
  }

  // ---------------------------------------------------------------- Hyperliquid, signed by the wallet

  /** A user-signed action (agent approval, transfers, account mode), signed by the wallet like the app does. */
  async userSigned(step: string, action: UserSignedAction): Promise<ExchangeResult> {
    const typed = userSignedTypedData(action);
    const sig = rsv(await this.need().signTypedData(typed as never));
    const nonce = 'nonce' in action ? action.nonce : action.time;
    const res = await this.exchange.send({ action, nonce, signature: sig });
    this.log.write(step, { network: NET, ok: res.ok, error: res.error ?? null, statuses: res.statuses, action: { ...action, signatureChainId: undefined } });
    return res;
  }

  // ---------------------------------------------------------------- the trading key (agent "bulwark-web")

  /** Reads the run's trading key from the Keychain, creating it when asked. Never printed. */
  tradingKey(create = false): PrivateKeyAccount | null {
    try {
      const key = execFileSync('security', ['find-generic-password', '-s', TRADING_KEYCHAIN.service, '-a', TRADING_KEYCHAIN.account, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      return privateKeyToAccount(key as Hex);
    } catch {
      if (!create) return null;
      const key = generatePrivateKey();
      execFileSync('security', ['add-generic-password', '-U', '-s', TRADING_KEYCHAIN.service, '-a', TRADING_KEYCHAIN.account, '-w', key], { stdio: 'ignore' });
      return privateKeyToAccount(key);
    }
  }

  /** An L1 action (orders, cancels, leverage) signed by the trading key, like the app's ticket. */
  async withTradingKey(step: string, action: L1Action): Promise<ExchangeResult> {
    const k = this.tradingKey();
    if (!k) throw new Error('No trading key yet: run part2 first.');
    const nonce = (this.lastNonce = Math.max(Date.now(), this.lastNonce + 1));
    const sig = rsv(await k.signTypedData(l1TypedData(l1ActionHash({ action, nonce }), false) as never));
    const res = await this.exchange.send({ action, nonce, signature: sig });
    this.log.write(step, { network: NET, ok: res.ok, error: res.error ?? null, statuses: res.statuses, action });
    return res;
  }

  // ---------------------------------------------------------------- Bulwark API on the live site

  async api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${SITE}/api/bw${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as T };
  }

  /** Sign-in with Ethereum on the live site, as the app does. It authorises nothing. */
  async signIn(): Promise<void> {
    const w = this.need();
    const n = (await this.api<{ nonce: string; domain: string }>('/auth/nonce', { body: { address: w.address } })).body;
    const message = createSiweMessage({ address: w.address, chainId: WALLET_CHAIN_ID, domain: n.domain, nonce: n.nonce, uri: `https://${n.domain}`, version: '1', issuedAt: new Date(), statement: 'Sign in to Bulwark. This signature does not authorise any transaction.' });
    const v = await this.api<{ token?: string; error?: string }>('/auth/verify', { body: { message, signature: await w.signMessage({ message }) } });
    if (!v.body.token) throw new Error(`sign-in refused: ${v.body.error ?? v.status}`);
    this.token = v.body.token;
    // For screen capture only: the session (not the key) lets a read-only browser show the signed-in screens.
    if (process.env.TESTRUN_SESSION_FILE) writeFileSync(process.env.TESTRUN_SESSION_FILE, this.token, { mode: 0o600 });
    this.log.write('signed in', { site: SITE });
  }

  /** Signs a policy version with the wallet (EIP-712 BulwarkPolicy) and saves it, as the app's Sign button does. */
  async signPolicy(policy: Policy): Promise<{ status: number; body: unknown }> {
    const signature = await this.need().signTypedData({ domain: policyConfirmationDomain(WALLET_CHAIN_ID), types: POLICY_CONFIRMATION_TYPES, primaryType: 'BulwarkPolicy', message: { account: WALLET, version: BigInt(policy.version), policyHash: policyHash(policy) } });
    const res = await this.api('/v1/policy', { body: { policy, signature, chainId: WALLET_CHAIN_ID } });
    this.log.write('policy signed', { version: policy.version, hash: policyHash(policy), status: res.status, response: res.body, rules: policy.rules });
    return res;
  }

  // ---------------------------------------------------------------- reading state

  async assets() {
    const perpDexs = (await this.info.perpDexs()) as RawPerpDexs;
    const metas = (await this.info.allPerpMetas()) as RawPerpMeta[];
    return { perpDexs, metas, index: buildAssetIndex(perpDexs, metas) };
  }

  /** The account's risk, computed as the guard computes it. */
  async risk() {
    const a = await this.assets();
    const dexStates: Record<string, never> = {};
    for (const d of ['', 'xyz']) dexStates[d] = (await this.info.clearinghouseState(WALLET, d)) as never;
    const abstraction = await this.info.userAbstraction(WALLET);
    const snapshot = buildSnapshot({ abstraction, dexStates, spot: (await this.info.spotClearinghouseState(WALLET)) as never, assets: a.index, dexCollateral: dexCollateral(a.perpDexs, a.metas) });
    return { abstraction, snapshot, risk: assessRisk(snapshot), assets: a.index };
  }

  async book(coin: string): Promise<{ bid: number | null; ask: number | null; bidDepth: number; askDepth: number }> {
    const b = (await this.info.request<{ levels: Array<Array<{ px: string; sz: string }>> }>({ type: 'l2Book', coin })).levels ?? [[], []];
    const depth = (ls: Array<{ px: string; sz: string }>) => ls.slice(0, 5).reduce((s, l) => s + Number(l.px) * Number(l.sz), 0);
    return { bid: b[0]?.[0] ? Number(b[0][0].px) : null, ask: b[1]?.[0] ? Number(b[1][0].px) : null, bidDepth: depth(b[0] ?? []), askDepth: depth(b[1] ?? []) };
  }

  openOrders(dex = 'xyz') {
    return this.info.frontendOpenOrders(WALLET, dex) as Promise<Array<{ coin: string; oid: number; side: string; sz: string; reduceOnly: boolean; isTrigger: boolean; triggerPx: string; orderType: string }>>;
  }

  /** Bulwark's builder field for testnet orders, when the builder code is on there (as the app attaches it). */
  builder() {
    return builderField('testnet') as { b: Hex; f: number } | null;
  }
}

/** Audit entries after a given seq, from the live API (the user's own, signed in). */
export async function auditSince(s: Session, afterSeq: number) {
  const r = await s.api<Array<{ seq: number; at: number; kind: string; why: string; what: string; proof?: Record<string, unknown> }>>('/v1/audit?limit=200');
  return (r.body ?? []).filter((e) => e.seq > afterSeq).sort((a, b) => a.seq - b.seq);
}
