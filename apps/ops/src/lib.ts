import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  ExchangeClient,
  InfoClient,
  NonceManager,
  digestOf,
  l1ActionHash,
  l1TypedData,
  userSignedTypedData,
  type ExchangeResult,
  type Hex,
  type L1Action,
  type Network,
  type UserSignedAction,
} from '@bulwarkxyz/hyperliquid';
import { LocalDigestSigner, type DigestSigner } from '@bulwarkxyz/signer';

/**
 * Keys for the D6 test wallets live only in this Mac's Keychain. They are read here and never printed,
 * logged or written anywhere else.
 */
export function keychainSigner(service: string): LocalDigestSigner {
  const key = execFileSync('security', ['find-generic-password', '-s', service, '-a', 'bulwark', '-w']).toString().trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`keychain item ${service} is not a private key`);
  return new LocalDigestSigner(key as Hex);
}

export const WALLETS = {
  standard: 'bulwark-test-standard',
  unified: 'bulwark-test-unified',
  builder: 'bulwark-builder',
  testnetAgent: 'bulwark-testnet-agent',
} as const;

/** Signature chain id for user-signed actions sent by scripts (any chain id is accepted; B0 testnet check). */
export const SCRIPT_CHAIN_ID: Hex = '0x66eee';

export class Session {
  readonly info: InfoClient;
  readonly exchange: ExchangeClient;
  readonly nonces = new NonceManager();
  readonly log: Array<Record<string, unknown>> = [];
  constructor(readonly network: Network) {
    this.info = new InfoClient(network);
    this.exchange = new ExchangeClient(network);
  }

  get chain() {
    return this.network === 'mainnet' ? ('Mainnet' as const) : ('Testnet' as const);
  }

  async l1(signer: DigestSigner, action: L1Action, step: string, vaultAddress?: Hex): Promise<ExchangeResult> {
    const nonce = 'nonce' in action && typeof action.nonce === 'number' ? action.nonce : this.nonces.next(signer.address);
    const sig = await signer.signDigest(digestOf(l1TypedData(l1ActionHash({ action, nonce, ...(vaultAddress ? { vaultAddress } : {}) }), this.network === 'mainnet')));
    const t = performance.now();
    const res = await this.exchange.send({ action, nonce, signature: sig, ...(vaultAddress ? { vaultAddress } : {}) });
    this.record(step, action, res, performance.now() - t);
    return res;
  }

  async user(signer: DigestSigner, action: UserSignedAction, step: string): Promise<ExchangeResult> {
    const sig = await signer.signDigest(digestOf(userSignedTypedData(action)));
    const nonce = 'nonce' in action ? action.nonce : action.time;
    const t = performance.now();
    const res = await this.exchange.send({ action, nonce, signature: sig });
    this.record(step, action, res, performance.now() - t);
    return res;
  }

  record(step: string, action: unknown, res: ExchangeResult, ms: number) {
    const entry = { step, at: new Date().toISOString(), ok: res.ok, error: res.error ?? null, statuses: res.statuses, ms: Math.round(ms), action };
    this.log.push(entry);
    console.log(`${res.ok ? 'ok  ' : 'FAIL'} ${step}${res.error ? ` — ${res.error}` : ''}`);
  }

  note(step: string, detail: unknown) {
    this.log.push({ step, at: new Date().toISOString(), detail });
    console.log(`note ${step}: ${JSON.stringify(detail)}`);
  }

  save(name: string): string {
    const dir = new URL('../../../evidence/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    const file = new URL(`${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, dir);
    writeFileSync(file, JSON.stringify({ network: this.network, steps: this.log }, null, 1));
    return file.pathname;
  }
}

export async function perpUsdc(info: InfoClient, user: Hex, dex = ''): Promise<number> {
  const st = (await info.clearinghouseState(user, dex)) as { marginSummary: { accountValue: string }; withdrawable: string };
  return Number(st.withdrawable);
}

export async function spotUsdc(info: InfoClient, user: Hex): Promise<number> {
  const st = (await info.spotClearinghouseState(user)) as { balances: Array<{ coin: string; total: string; hold: string }> };
  const b = st.balances.find((x) => x.coin === 'USDC');
  return b ? Number(b.total) - Number(b.hold) : 0;
}
