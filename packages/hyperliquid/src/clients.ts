import type { Hex, L1Action, UserSignedAction } from './actions.js';
import type { Signature } from './signing.js';

export type Network = 'mainnet' | 'testnet';

export const API_URL: Record<Network, string> = {
  mainnet: 'https://api.hyperliquid.xyz',
  testnet: 'https://api.hyperliquid-testnet.xyz',
};

/** USDC as `name:tokenId` per network (from spotMeta), used by agentSendAsset / sendAsset. */
export const USDC_TOKEN: Record<Network, string> = {
  mainnet: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054',
  testnet: 'USDC:0xeb62eee3685fc4c43992febcd9e75443',
};

export type Fetch = typeof fetch;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

async function post<T>(fetchImpl: Fetch, url: string, body: unknown, timeoutMs: number): Promise<T> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text);
  return JSON.parse(text) as T;
}

/** Read-only info endpoint. https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint */
export class InfoClient {
  constructor(
    readonly network: Network,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 5000,
  ) {}

  request<T>(body: Record<string, unknown>): Promise<T> {
    return post<T>(this.fetchImpl, `${API_URL[this.network]}/info`, body, this.timeoutMs);
  }

  perpDexs = () => this.request<unknown[]>({ type: 'perpDexs' });
  allPerpMetas = () => this.request<unknown[]>({ type: 'allPerpMetas' });
  userAbstraction = (user: Hex) => this.request<string>({ type: 'userAbstraction', user });
  clearinghouseState = (user: Hex, dex = '') => this.request<unknown>({ type: 'clearinghouseState', user, dex });
  spotClearinghouseState = (user: Hex) => this.request<unknown>({ type: 'spotClearinghouseState', user });
  frontendOpenOrders = (user: Hex, dex = '') => this.request<unknown[]>({ type: 'frontendOpenOrders', user, dex });
  extraAgents = (user: Hex) => this.request<Array<{ name: string; address: Hex; validUntil: number }>>({ type: 'extraAgents', user });
  maxBuilderFee = (user: Hex, builder: Hex) => this.request<number>({ type: 'maxBuilderFee', user, builder });
  referral = (user: Hex) => this.request<Record<string, unknown>>({ type: 'referral', user });
  userRole = (user: Hex) => this.request<{ role: string }>({ type: 'userRole', user });
  allMids = (dex = '') => this.request<Record<string, string>>({ type: 'allMids', dex });
  metaAndAssetCtxs = (dex = '') => this.request<[unknown, unknown[]]>({ type: 'metaAndAssetCtxs', dex });
  candleSnapshot = (coin: string, interval: string, startTime: number, endTime: number) =>
    this.request<Array<{ t: number; T: number; o: string; h: string; l: string; c: string; v: string; n: number }>>({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } });
}

export type OrderStatus =
  | { kind: 'resting'; oid: number; cloid?: Hex }
  | { kind: 'filled'; oid: number; totalSz: string; avgPx: string; cloid?: Hex }
  | { kind: 'waiting'; detail: string }
  | { kind: 'twap'; twapId: number }
  | { kind: 'success' }
  | { kind: 'error'; error: string };

export interface ExchangeResult {
  ok: boolean;
  /** Whole-request error (pre-validation, signature, rate limit). */
  error?: string;
  statuses: OrderStatus[];
  raw: unknown;
}

function parseStatus(s: unknown): OrderStatus {
  if (s === 'success') return { kind: 'success' };
  if (typeof s === 'string') return { kind: 'waiting', detail: s };
  const o = s as Record<string, Record<string, unknown> | string>;
  if (o.resting && typeof o.resting === 'object') return { kind: 'resting', oid: Number(o.resting.oid), ...(o.resting.cloid ? { cloid: o.resting.cloid as Hex } : {}) };
  if (o.filled && typeof o.filled === 'object')
    return { kind: 'filled', oid: Number(o.filled.oid), totalSz: String(o.filled.totalSz), avgPx: String(o.filled.avgPx), ...(o.filled.cloid ? { cloid: o.filled.cloid as Hex } : {}) };
  if (o.running && typeof o.running === 'object') return { kind: 'twap', twapId: Number(o.running.twapId) };
  if (typeof o.error === 'string') return { kind: 'error', error: o.error };
  return { kind: 'error', error: JSON.stringify(s) };
}

export function parseExchangeResponse(raw: unknown): ExchangeResult {
  const r = raw as { status?: string; response?: unknown };
  if (r.status !== 'ok') return { ok: false, error: typeof r.response === 'string' ? r.response : JSON.stringify(r.response), statuses: [], raw };
  const resp = r.response as { type?: string; data?: { statuses?: unknown[]; status?: unknown } } | undefined;
  const statuses = resp?.data?.statuses?.map(parseStatus) ?? (resp?.data?.status !== undefined ? [parseStatus(resp.data.status)] : []);
  const ok = statuses.every((s) => s.kind !== 'error');
  const firstError = statuses.find((s): s is Extract<OrderStatus, { kind: 'error' }> => s.kind === 'error')?.error;
  return { ok, ...(firstError ? { error: firstError } : {}), statuses, raw };
}

export interface SignedRequest {
  action: L1Action | UserSignedAction;
  nonce: number;
  signature: Signature;
  vaultAddress?: Hex;
  expiresAfter?: number;
}

/** Exchange endpoint. Sends already-signed requests only; never holds keys. */
export class ExchangeClient {
  constructor(
    readonly network: Network,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 8000,
  ) {}

  async send(req: SignedRequest): Promise<ExchangeResult> {
    const body: Record<string, unknown> = { action: req.action, nonce: req.nonce, signature: req.signature };
    if (req.vaultAddress) body.vaultAddress = req.vaultAddress;
    if (req.expiresAfter !== undefined) body.expiresAfter = req.expiresAfter;
    const raw = await post<unknown>(this.fetchImpl, `${API_URL[this.network]}/exchange`, body, this.timeoutMs);
    return parseExchangeResponse(raw);
  }
}

/**
 * Nonces: per signer, strictly increasing millisecond timestamps. The exchange keeps the 100 highest and
 * accepts values within (T − 2 days, T + 1 day). https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
 */
export class NonceManager {
  private last = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  next(signer: string): number {
    const key = signer.toLowerCase();
    const n = Math.max(this.now(), (this.last.get(key) ?? 0) + 1);
    this.last.set(key, n);
    return n;
  }
}
