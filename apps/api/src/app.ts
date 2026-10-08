import { randomBytes } from 'node:crypto';
import { BUILDER_ADDRESS, BUILDER_FEE_TENTHS_BPS, currentVerdict, regionVerdict, strictestVerdict } from '@bulwarkxyz/config';
import {
  COMMAND_TYPES,
  Execution,
  POLICY_CONFIRMATION_TYPES,
  Policy,
  assessRisk,
  buildAssetIndex,
  buildSnapshot,
  dexCollateral,
  needsRepeatChoice,
  policyConfirmationDomain,
  policyHash,
  type CommandName,
  type RawPerpDexs,
  type RawPerpMeta,
} from '@bulwarkxyz/guard-core';
import { compileRule, describeRule, type MarketRef, type TranslatorProvider } from '@bulwarkxyz/compiler';
import type { Hex, InfoClient } from '@bulwarkxyz/hyperliquid';
import type { ApiStore, GuardState, PausedReason } from '@bulwarkxyz/store';
import { Hono, type Context } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import { getAddress, verifyMessage, verifyTypedData } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { MAX_COINS, marketActivity } from './market-activity.js';
import { CONTRACT_WALLET_ERROR, isContractCode, isContractWalletSignature, normalizeSignature } from './signatures.js';

export interface ApiDeps {
  store: ApiStore;
  /** When set, only these accounts (lowercase) can sign in: a closed mainnet canary (mainnet prerequisites). Unset: anyone. */
  signupAllowlist?: Set<string> | undefined;
  info: Pick<InfoClient, 'extraAgents' | 'maxBuilderFee' | 'userAbstraction' | 'clearinghouseState' | 'spotClearinghouseState' | 'perpDexs' | 'allPerpMetas' | 'metaAndAssetCtxs' | 'candleSnapshot'>;
  jwtSecret: Uint8Array;
  /** The web app's server proxy proves itself with this; only then are its location headers trusted. */
  proxySecret: string;
  siweDomain: string;
  /**
   * Other sites of ours that may also ask for a sign-in (the review link). The production domain stays the
   * default; a nonce is bound to one domain and sign-in must use exactly that one.
   */
  siweExtraDomains?: string[];
  /** Creates a per-user KMS key; absent until AWS access exists. */
  provisionAgent?: (account: Hex) => Promise<{ keyId: string; address: Hex }>;
  /** Disables a KMS key and schedules its deletion (provisioner role). */
  retireKmsKey?: (keyId: string) => Promise<void>;
  /**
   * Where new agent keys live. 'kms' (active): a per-user, non-exportable AWS KMS key created through
   * provisionAgent; the private key never leaves KMS. 'sealed' (fallback): generated and stored
   * encrypted by the signing service; the API only files a request and never sees key material.
   */
  keyCustody: 'sealed' | 'kms';
  network: 'mainnet' | 'testnet';
  /**
   * Whether new policy versions must carry the per-stage repeat choice. Off until the app sends it;
   * while off, a rule without it runs as "every time", exactly as before the choice existed.
   */
  repeatChoiceRequired?: boolean;
  /**
   * The plain-language translator's model provider (OpenAI by default); absent while the translator is
   * off. It is switched on only after the eval's adversarial set passes in full.
   */
  translator?: TranslatorProvider;
  /** The Telegram bot's username (public), for the one-tap link the app shows next to a link code. */
  telegramBot?: string;
  /** Cost caps (security review F6); defaults below. */
  limits?: { keysPerAccountPerDay?: number; keysPerDay?: number; draftsPerHour?: number };
  /** Sends an alert to the operator (Telegram), for /health/guard failures; absent until the operator links a chat. */
  operatorAlert?: (text: string) => Promise<void>;
  /** Bytecode at an address (Arbitrum), used only to explain a failed signature from a smart-contract wallet. */
  codeAt?: (address: Hex) => Promise<Hex>;
  now: () => number;
}

/** Translator calls per account per hour (cost cap). */
export const DRAFTS_PER_HOUR = 30;
/** Translator calls per hour across all accounts (F6: fresh wallets would otherwise bypass the per-account cap). */
export const DRAFTS_PER_HOUR_ALL = 300;
/** Guard keys (each an AWS KMS key, about $1 a month) per account per day, and across all accounts per day (F6). */
export const KEYS_PER_ACCOUNT_PER_DAY = 3;
export const KEYS_PER_DAY = 50;
/** The worker's heartbeat older than this, or its newest price older than MARK_STALE_MS: /health/guard fails. */
export const HEARTBEAT_STALE_MS = 60_000;
export const MARK_STALE_MS = 30_000;

type Env = { Variables: { account: Hex } };

/** A command must be submitted within this long of the user signing it (engine constant). */
/** Sign-in nonces kept at most (expired ones are swept first, then the oldest dropped). */
export const NONCE_MAX = 50_000;
export const COMMAND_MAX_AGE_MS = 60_000;
/** The worker refreshes the status at least every 15 s; older than this, it has stopped reporting. */
export const STATUS_MAX_AGE_MS = 60_000;
const NONCE_TTL_MS = 10 * 60_000;
const SESSION_HOURS = 12;

export function createApp(deps: ApiDeps) {
  const app = new Hono<Env>();
  // Keyed by the nonce itself (one per request), so asking for a nonce with someone else's address cannot replace
  // theirs; expired ones are swept and the map is capped, so unauthenticated requests cannot grow it without bound.
  const nonces = new Map<string, { address: string; exp: number; domain: string }>();
  /** Last recorded location per account (so the database is written only when it changes). */
  const lastSeen = new Map<string, string>();
  /** Key creation: one at a time per account, and how many were created in the last day (F6, F7). */
  const keyLocks = new Map<string, Promise<void>>();
  const keyTimes = new Map<string, number[]>();
  let allKeyTimes: number[] = [];
  /** Translator calls across all accounts in the last hour (F6). */
  let allDraftTimes: number[] = [];
  let watchdog: () => Promise<void> = async () => undefined;
  const putNonce = (nonce: string, v: { address: string; exp: number; domain: string }) => {
    if (nonces.size >= NONCE_MAX) {
      const now = deps.now();
      for (const [k, e] of nonces) if (e.exp < now) nonces.delete(k);
      while (nonces.size >= NONCE_MAX) nonces.delete(nonces.keys().next().value as string);
    }
    nonces.set(nonce, v);
  };
  const siweDomains = new Set([deps.siweDomain, ...(deps.siweExtraDomains ?? [])]);
  const draftTimes = new Map<string, number[]>();
  /** A refused signature: say "smart-contract wallet" when that's why, otherwise "bad signature". */
  const refuseSignature = async (c: Context, address: string, signature: Hex, otherwise = 'bad signature') => {
    const contract = isContractWalletSignature(signature) || (deps.codeAt ? isContractCode(await deps.codeAt(getAddress(address) as Hex)) : false);
    return contract ? c.json({ error: CONTRACT_WALLET_ERROR, code: 'contract_wallet' }, 400) : c.json({ error: otherwise }, 401);
  };
  let marketCache: { at: number; markets: MarketRef[] } | null = null;
  const markets = async (): Promise<MarketRef[]> => {
    if (marketCache && deps.now() - marketCache.at < 10 * 60_000) return marketCache.markets;
    const assets = buildAssetIndex((await deps.info.perpDexs()) as RawPerpDexs, (await deps.info.allPerpMetas()) as RawPerpMeta[]);
    const list = [...assets.values()].filter((a) => a.dex === 'xyz' && !a.delisted).map((a) => ({ coin: a.coin, name: a.coin.replace('xyz:', '') }));
    marketCache = { at: deps.now(), markets: list };
    return list;
  };

  // -------------------------------------------------------------- location (layered gate, layer 1)
  const location = (c: Context) => {
    const trusted = c.req.header('x-bulwark-proxy-secret') === deps.proxySecret && deps.proxySecret.length > 0;
    return trusted ? { country: c.req.header('x-bulwark-country') ?? null, subdivision: c.req.header('x-bulwark-subdivision') ?? null } : { country: null, subdivision: null };
  };

  // How long the API itself took, visible in the browser's network panel (Server-Timing), to tell API time from hosting hops.
  app.use('*', async (c, next) => {
    const t0 = performance.now();
    await next();
    c.res.headers.set('Server-Timing', `api;dur=${(performance.now() - t0).toFixed(1)}`);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  // The guard's health, from the worker's own heartbeat: fails when the worker is dead or its prices are stale.
  // Public, for an uptime monitor; the API also alerts the operator itself (watchdog, run by main every 30 s).
  const guardHealth = async () => {
    const hb = await deps.store.operatorState<{ network: string; lastMarkAt: number; staleAccounts: number; tracked: number }>('worker_heartbeat').catch(() => null);
    const stop = await deps.store.operatorState<{ on: boolean; reason?: string | null }>('global_stop').catch(() => null);
    const now = deps.now();
    const problems: string[] = [];
    if (!hb) problems.push('no worker heartbeat');
    else {
      if (now - hb.at > HEARTBEAT_STALE_MS) problems.push(`worker heartbeat ${Math.round((now - hb.at) / 1000)} s old`);
      if (!hb.value.lastMarkAt || now - hb.value.lastMarkAt > MARK_STALE_MS) problems.push('worker prices are stale');
      if (hb.value.network !== deps.network) problems.push(`worker is on ${hb.value.network}`);
    }
    return { ok: problems.length === 0, problems, network: deps.network, heartbeatAgeS: hb ? Math.round((now - hb.at) / 1000) : null, staleAccounts: hb?.value.staleAccounts ?? null, tracked: hb?.value.tracked ?? null, globalStop: Boolean(stop?.value.on) };
  };
  app.get('/health/guard', async (c) => {
    const h = await guardHealth();
    return c.json(h, h.ok ? 200 : 503);
  });
  let failing = 0;
  let alerted = false;
  /** One watchdog step: alerts the operator after two failed checks in a row, and once more on recovery. */
  watchdog = async () => {
    if (!deps.operatorAlert) return;
    const h = await guardHealth();
    failing = h.ok ? 0 : failing + 1;
    if (failing >= 2 && !alerted) {
      alerted = true;
      await deps.operatorAlert(`Bulwark ${deps.network}: the guard is unhealthy: ${h.problems.join('; ')}. Users' resting backstops stay on Hyperliquid.`).catch(() => (alerted = false));
    } else if (h.ok && alerted) {
      alerted = false;
      await deps.operatorAlert(`Bulwark ${deps.network}: the guard is healthy again.`).catch(() => undefined);
    }
  };

  // -------------------------------------------------------------- market activity (public, cached)
  const activity = marketActivity(deps.info, deps.now);
  app.get('/markets/activity', async (c) => {
    const coins = [...new Set((c.req.query('coins') ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
    if (coins.length === 0 || coins.length > MAX_COINS || coins.some((s) => !/^xyz:[A-Z0-9]{1,16}$/.test(s))) return c.json({ error: `coins: 1 to ${MAX_COINS} xyz markets, e.g. xyz:CL,xyz:GOLD` }, 400);
    try {
      const body = { network: deps.network, checkedAt: deps.now(), markets: await activity(coins) };
      // The same for every visitor: let the CDN keep it for a minute.
      c.header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
      return c.json(body);
    } catch {
      return c.json({ error: 'Hyperliquid unreachable' }, 503);
    }
  });

  // -------------------------------------------------------------- sign in with Ethereum (EIP-4361)
  app.post('/auth/nonce', async (c) => {
    const { address } = await c.req.json<{ address: string }>();
    const nonce = randomBytes(12).toString('hex');
    // The app's proxy names the site the request came from; only our own sites are used, else production's.
    const site = c.req.header('x-bulwark-site') ?? '';
    const domain = siweDomains.has(site) ? site : deps.siweDomain;
    putNonce(nonce, { address: getAddress(address), exp: deps.now() + NONCE_TTL_MS, domain });
    return c.json({ nonce, domain });
  });

  app.post('/auth/verify', async (c) => {
    const { message, signature } = await c.req.json<{ message: string; signature: Hex }>();
    const parsed = parseSiweMessage(message);
    const entry = parsed.nonce ? nonces.get(parsed.nonce) : undefined;
    const expected = entry && parsed.address && entry.address === getAddress(parsed.address) ? entry : undefined;
    if (!parsed.address || !parsed.domain || !siweDomains.has(parsed.domain) || (expected && expected.domain !== parsed.domain))
      return c.json({ error: 'This site is not allowed to sign in to Bulwark.', code: 'wrong_domain' }, 401);
    if (!expected || expected.exp < deps.now()) return c.json({ error: 'nonce expired' }, 401);
    if (isContractWalletSignature(signature) || !(await verifyMessage({ address: parsed.address, message, signature: normalizeSignature(signature) }).catch(() => false)))
      return refuseSignature(c, parsed.address, signature);
    nonces.delete(parsed.nonce as string);
    if (deps.signupAllowlist && !deps.signupAllowlist.has(parsed.address.toLowerCase()))
      return c.json({ error: 'Bulwark is open to invited accounts only on this network for now.', code: 'not_invited' }, 403);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(parsed.address.toLowerCase())
      // Sessions name their network (F5): a testnet session is refused by a mainnet API even if a secret were shared.
      .setAudience(`bulwark:${deps.network}`)
      .setIssuedAt()
      .setExpirationTime(`${SESSION_HOURS}h`)
      .sign(deps.jwtSecret);
    return c.json({ token });
  });

  // -------------------------------------------------------------- session
  app.use('/v1/*', async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    try {
      const { payload } = await jwtVerify(auth.replace(/^Bearer /, ''), deps.jwtSecret, { audience: `bulwark:${deps.network}` });
      c.set('account', payload.sub as Hex);
    } catch {
      return c.json({ error: 'sign in' }, 401);
    }
    // Where the user's latest request came from: regions are re-checked with it at every guard action.
    const loc = location(c);
    const acct = c.get('account');
    if (loc.country && lastSeen.get(acct) !== `${loc.country}|${loc.subdivision ?? ''}`) {
      lastSeen.set(acct, `${loc.country}|${loc.subdivision ?? ''}`);
      void deps.store.setLastSeen(acct, loc.country, loc.subdivision).catch(() => lastSeen.delete(acct));
    }
    await next();
  });

  app.get('/v1/me', async (c) => {
    const account = c.get('account');
    // Everything at once: the two Hyperliquid reads were sequential and made this the slowest call the app makes.
    const [user, confirmed, agents, maxFee, keyMeta] = await Promise.all([
      deps.store.user(account),
      deps.store.policy(account),
      deps.info.extraAgents(account).catch(() => []),
      deps.info.maxBuilderFee(account, BUILDER_ADDRESS).catch(() => 0),
      deps.store.agentKeys(account, deps.network),
    ]);
    const agent = user?.agentAddress ? agents.find((a) => a.address.toLowerCase() === user.agentAddress?.toLowerCase()) : undefined;
    const pending = keyMeta.find((k) => k.status === 'pending');
    return c.json({
      account,
      user,
      agent: user?.agentAddress ? { address: user.agentAddress, approved: Boolean(agent), validUntil: agent?.validUntil ?? null } : null,
      // Where this user's key actually lives (new keys use the service's mode), so the app describes it truthfully.
      keyCustody: user?.agentKeyRef.startsWith('kms:') ? 'kms' : user?.agentKeyRef.startsWith('sealed:') ? 'sealed' : deps.keyCustody,
      newKeyCustody: deps.keyCustody,
      // Which model provider the AI translator uses, so the app can name it next to the translator.
      translator: deps.translator ? { enabled: true, provider: deps.translator.label } : { enabled: false, provider: null },
      keyStatus: user?.agentKeyRef === 'wiped' ? 'wiped' : user?.agentAddress ? 'ready' : keyMeta.length || user?.agentKeyRef === 'requested' ? 'creating' : 'none',
      pendingAgent: pending ? { address: pending.address } : null,
      builder: { address: BUILDER_ADDRESS, feeTenthsBps: BUILDER_FEE_TENTHS_BPS, approvedMaxTenthsBps: maxFee },
      policy: confirmed ? { version: confirmed.policy.version, hash: confirmed.hash, confirmedAt: confirmed.confirmedAt, policy: confirmed.policy, needsRepeatChoice: needsRepeatChoice(confirmed.policy), needsResign: confirmed.signedNetwork !== deps.network } : null,
      regionNow: user ? currentVerdict(user) : null,
    });
  });

  // The region for this request: where it comes from now and what the user declared. The trade ticket asks this
  // before it offers to place orders. Orders are signed in the browser and sent to Hyperliquid directly, so this
  // gates Bulwark's own interface; it cannot stop anyone trading on Hyperliquid itself.
  app.get('/v1/region', async (c) => {
    const user = await deps.store.user(c.get('account'));
    const loc = location(c);
    const verdict = strictestVerdict(regionVerdict(loc.country, loc.subdivision), ...(user ? [currentVerdict(user)] : []));
    return c.json({ verdict, trading: verdict !== 'blocked', guard: verdict === 'allowed', country: loc.country });
  });

  // -------------------------------------------------------------- onboarding
  app.post('/v1/onboarding/attest', async (c) => {
    const account = c.get('account');
    const { residency, citizenship } = await c.req.json<{ residency: string; citizenship: string }>();
    const loc = location(c);
    const verdict = strictestVerdict(regionVerdict(loc.country, loc.subdivision), regionVerdict(residency), regionVerdict(citizenship));
    if (verdict === 'blocked') return c.json({ verdict, reason: 'Bulwark is not available where you are or for your citizenship.' }, 403);
    const existing = await deps.store.user(account);
    await deps.store.upsertUser(
      {
        account,
        agentKeyRef: existing?.agentKeyRef ?? 'pending',
        agentAddress: existing?.agentAddress ?? null,
        region: verdict,
        residency: residency.toUpperCase(),
        citizenship: citizenship.toUpperCase(),
        telegramChatId: existing?.telegramChatId ?? null,
        killSwitch: existing?.killSwitch ?? false,
        builderApproved: existing?.builderApproved ?? false,
      },
      deps.now(),
    );
    return c.json({ verdict, guard: verdict === 'allowed' ? 'on' : 'off: trading and alerts only in your region' });
  });

  app.post('/v1/onboarding/agent', async (c) => {
    const account = c.get('account');
    // One key creation per account at a time (F7: two requests at once created two KMS keys).
    const prior = keyLocks.get(account) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chain = prior.then(() => mine);
    keyLocks.set(account, chain);
    await prior;
    try {
      return await createKey(c, account);
    } finally {
      release();
      if (keyLocks.get(account) === chain) keyLocks.delete(account);
    }
  });
  /** A cost cap was reached (F6): which one, and when the oldest use in the window expires (also as Retry-After). */
  function limited(c: Context<Env>, limit: string, error: string, times: number[], windowMs: number) {
    const retryAfter = Math.max(1, Math.ceil((Math.min(...times) + windowMs - deps.now()) / 1000));
    c.header('Retry-After', String(retryAfter));
    return c.json({ error, limit, retryAfter }, 429);
  }
  async function createKey(c: Context<Env>, account: Hex) {
    const user = await deps.store.user(account);
    if (!user) return c.json({ error: 'complete the region step first' }, 409);
    if (user.agentAddress && user.agentKeyRef !== 'pending') return c.json({ agentAddress: user.agentAddress });
    if (currentVerdict(user) !== 'allowed') return c.json({ error: 'the guard is off in your region' }, 403);
    // Cost caps (F6): per account and across all accounts, per day. Kept in memory (one API instance).
    const day = deps.now() - 86_400_000;
    const mineToday = (keyTimes.get(account) ?? []).filter((t) => t > day);
    allKeyTimes = allKeyTimes.filter((t) => t > day);
    if (mineToday.length >= (deps.limits?.keysPerAccountPerDay ?? KEYS_PER_ACCOUNT_PER_DAY)) return limited(c, 'keys_account', 'too many guard keys created for this account today; try again tomorrow', mineToday, 86_400_000);
    if (allKeyTimes.length >= (deps.limits?.keysPerDay ?? KEYS_PER_DAY)) return limited(c, 'keys_all', 'Bulwark has reached its limit of new guard keys for today; please try again tomorrow', allKeyTimes, 86_400_000);
    keyTimes.set(account, [...mineToday, deps.now()]);
    allKeyTimes.push(deps.now());
    if (deps.keyCustody === 'sealed') {
      // The signing service creates the key; this only files the request (idempotent).
      await deps.store.requestAgentKey(account, deps.network, 'create', deps.now());
      return c.json({ status: 'creating' }, 202);
    }
    if (!deps.provisionAgent) return c.json({ error: 'guard keys are not available yet' }, 503);
    let key: { keyId: string; address: Hex };
    try {
      key = await deps.provisionAgent(account);
    } catch (e) {
      // AWS refusals carry the denied action, never credentials; keep them in the server log only.
      console.error(JSON.stringify({ msg: 'guard key provisioning failed', account, error: (e as Error).name, detail: (e as Error).message }));
      return c.json({ error: 'guard keys are not available yet; please try again later' }, 503);
    }
    const now = deps.now();
    await deps.store.putKmsKey({ account, network: deps.network, address: key.address, kmsKeyId: key.keyId, status: 'active', masterKeyId: null, createdAt: now, updatedAt: now });
    await deps.store.upsertUser({ ...user, agentKeyRef: `kms:${key.keyId}`, agentAddress: key.address }, now);
    await deps.store.audit.append({ account, at: now, kind: 'key', why: 'You asked for a guard key', what: `Guard key created in AWS KMS (address ${key.address}); its private key cannot leave KMS`, proof: { address: key.address, kmsKeyId: key.keyId } });
    return c.json({ agentAddress: key.address });
  }

  // Replace the guard key. The new key takes over once the user approves it on Hyperliquid; the old one
  // is then wiped (encrypted) or disabled and scheduled for deletion (KMS).
  app.post('/v1/guard-key/rotate', async (c) => {
    const account = c.get('account');
    const user = await deps.store.user(account);
    if (!user?.agentAddress) return c.json({ error: 'no guard key yet' }, 409);
    if (deps.keyCustody === 'sealed') {
      await deps.store.requestAgentKey(account, deps.network, 'rotate', deps.now());
      return c.json({ status: 'creating', pendingAgent: null }, 202);
    }
    const pending = (await deps.store.agentKeys(account, deps.network)).find((k) => k.status === 'pending');
    if (pending) return c.json({ status: 'pending', pendingAgent: { address: pending.address } });
    if (!deps.provisionAgent) return c.json({ error: 'guard keys are not available yet' }, 503);
    let key: { keyId: string; address: Hex };
    try {
      key = await deps.provisionAgent(account);
    } catch (e) {
      console.error(JSON.stringify({ msg: 'guard key provisioning failed', account, error: (e as Error).name, detail: (e as Error).message }));
      return c.json({ error: 'guard keys are not available yet; please try again later' }, 503);
    }
    const now = deps.now();
    await deps.store.putKmsKey({ account, network: deps.network, address: key.address, kmsKeyId: key.keyId, status: 'pending', masterKeyId: null, createdAt: now, updatedAt: now });
    await deps.store.audit.append({ account, at: now, kind: 'key', why: 'You asked to replace your guard key', what: `Replacement guard key created in AWS KMS (address ${key.address}); it takes over once you approve it on Hyperliquid`, proof: { address: key.address, kmsKeyId: key.keyId } });
    return c.json({ status: 'pending', pendingAgent: { address: key.address } });
  });

  // -------------------------------------------------------------- policy
  app.get('/v1/policy', async (c) => c.json((await deps.store.policy(c.get('account'))) ?? null));

  app.post('/v1/policy', async (c) => {
    const account = c.get('account');
    const body = await c.req.json<{ policy: unknown; signature: Hex; chainId: number }>();
    const parsed = Policy.safeParse(body.policy);
    if (!parsed.success) return c.json({ error: 'invalid policy', issues: parsed.error.issues }, 400);
    const policy = parsed.data;
    if (policy.account.toLowerCase() !== account) return c.json({ error: 'policy is for another account' }, 403);
    // Every stage carries the user's own repeat choice; there is no default.
    const unchosen = needsRepeatChoice(policy);
    if (deps.repeatChoiceRequired && unchosen.length) return c.json({ error: 'choose for each stage: act once per fall, or every time the line is crossed', needsChoice: unchosen }, 400);
    const current = await deps.store.policy(account);
    if (policy.version !== (current?.policy.version ?? 0) + 1) return c.json({ error: 'stale version' }, 409);
    const hash = policyHash(policy);
    const ok = !isContractWalletSignature(body.signature) && (await verifyTypedData({
      address: account,
      domain: policyConfirmationDomain(body.chainId),
      types: POLICY_CONFIRMATION_TYPES,
      primaryType: 'BulwarkPolicy',
      // The network is the API's own, never the request's (F5).
      message: { account, network: deps.network, version: BigInt(policy.version), policyHash: hash },
      signature: normalizeSignature(body.signature),
    }).catch(() => false));
    if (!ok) return refuseSignature(c, account, body.signature, 'signature does not match');
    const now = deps.now();
    // Stored with what it was signed with, so the worker verifies it itself (F3).
    await deps.store.confirmPolicy(account, { policy, hash, signature: body.signature, signatureVerified: true, confirmedAt: now, chainId: body.chainId, signedNetwork: deps.network });
    // Baselines for rules measured from the moment of confirmation.
    const fromConfirm = policy.rules.filter((r) => (r.when.kind === 'drawdown' && r.when.baseline === 'rule_confirmed') || (r.when.kind === 'priceMove' && r.when.from === 'rule_confirmed'));
    if (fromConfirm.length) {
      const risk = await accountNow(deps, account);
      for (const r of fromConfirm) await deps.store.setBaseline(account, r.id, { accountValue: risk.accountValue, prices: risk.marks });
    }
    await deps.store.audit.append({ account, at: now, kind: 'rule_confirmed', why: 'You signed this policy', what: `Policy v${policy.version}: ${policy.rules.length} rule(s)`, proof: { hash, signature: body.signature } });
    return c.json({ version: policy.version, hash });
  });

  // -------------------------------------------------------------- plain-language translator (I5 gate inside)
  app.post('/v1/rules/draft', async (c) => {
    const account = c.get('account');
    if (!deps.translator) return c.json({ error: 'the AI translator is not available yet' }, 503);
    const { text, maxSlippagePct } = await c.req.json<{ text: string; maxSlippagePct?: number }>();
    if (typeof text !== 'string') return c.json({ error: 'text required' }, 400);
    const signed = await deps.store.policy(account);
    // A first policy: the user types their slippage limit in the form; the draft becomes version 1.
    let base = signed?.policy;
    if (!base) {
      const slip = Execution.safeParse({ maxSlippagePct });
      if (!slip.success) return c.json({ error: 'for your first rules, type your slippage limit (above 0, at most 10%)' }, 400);
      base = { version: 0, account, rules: [], execution: slip.data };
    }
    const current = { policy: base };
    const now = deps.now();
    // Only for onboarded users in a region where Bulwark is offered (F6: no free calls for fresh wallets).
    const user = await deps.store.user(account);
    if (!user) return c.json({ error: 'complete the region step first' }, 409);
    if (currentVerdict(user) === 'blocked') return c.json({ error: 'Bulwark is not available in your region' }, 403);
    const recent = (draftTimes.get(account) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= (deps.limits?.draftsPerHour ?? DRAFTS_PER_HOUR)) return limited(c, 'drafts_account', 'too many translations this hour; try again later', recent, 3_600_000);
    allDraftTimes = allDraftTimes.filter((t) => now - t < 3_600_000);
    if (allDraftTimes.length >= DRAFTS_PER_HOUR_ALL) return limited(c, 'drafts_all', 'the translator is busy for everyone this hour; use the stage editor, or try again later', allDraftTimes, 3_600_000);
    draftTimes.set(account, [...recent, now]);
    allDraftTimes.push(now);

    const r = await compileRule(deps.translator, { text, policy: current.policy, markets: await markets() });
    if (r.kind === 'clarify') return c.json({ kind: 'clarify', question: r.question });
    if (r.kind === 'refuse') return c.json({ kind: 'refuse', reason: r.reason });
    if (!r.check.ok) {
      await deps.store.audit.append({ account, at: now, kind: 'rule_draft_rejected', why: 'The AI draft failed the safety checks, so it was never shown as a rule', what: `"${text.slice(0, 200)}"`, proof: { violations: r.check.violations } });
      return c.json({ kind: 'rejected', violations: r.check.violations });
    }
    return c.json({ kind: 'draft', rule: r.check.rule, description: describeRule(r.check.rule!), provenance: r.check.provenance, policy: r.check.policy });
  });

  // -------------------------------------------------------------- command results
  // A command's result, once the worker has carried it out (doneAt null until then). Own account only.
  app.get('/v1/commands/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'not found' }, 404);
    const cmd = await deps.store.command(c.get('account'), id);
    return cmd ? c.json(cmd) : c.json({ error: 'not found' }, 404);
  });

  // -------------------------------------------------------------- alerts (in-app, alongside Telegram)
  app.get('/v1/settings/alerts', async (c) => {
    const account = c.get('account');
    const [s, user] = await Promise.all([deps.store.alertSettings(account), deps.store.user(account)]);
    return c.json({ inApp: s.inApp, telegram: { linked: Boolean(user?.telegramChatId) } });
  });
  app.put('/v1/settings/alerts', async (c) => {
    const account = c.get('account');
    const body = await c.req.json<{ inApp?: unknown }>();
    if (typeof body.inApp !== 'boolean') return c.json({ error: 'inApp must be true or false' }, 400);
    if (!(await deps.store.user(account))) return c.json({ error: 'complete onboarding first' }, 409);
    await deps.store.setAlertSettings(account, { inApp: body.inApp });
    return c.json({ inApp: body.inApp });
  });
  /** The user's recent alerts for the in-app feed: what the guard said to them (also sent to Telegram when linked). */
  app.get('/v1/alerts', async (c) => {
    const account = c.get('account');
    const since = Number(c.req.query('since') ?? 0);
    const limit = Math.min(200, Number(c.req.query('limit') ?? 50));
    const entries = await deps.store.audit.list(account, 500);
    // Each entry also carries what it is about, when known: the rule (stage) and the market.
    const about = (e: (typeof entries)[number]) => {
      const p = (e.proof ?? {}) as { ruleId?: unknown; ruleIds?: unknown; coin?: unknown; fill?: { coin?: unknown } };
      const ruleId = typeof p.ruleId === 'string' ? p.ruleId : Array.isArray(p.ruleIds) && typeof p.ruleIds[0] === 'string' ? p.ruleIds[0] : null;
      const coin = typeof p.coin === 'string' ? p.coin : typeof p.fill?.coin === 'string' ? p.fill.coin : null;
      return { ruleId, coin };
    };
    return c.json(entries.filter((e) => (e.kind === 'alert' || e.kind === 'degraded') && e.at > since).slice(0, limit).map((e) => ({ ...e, ...about(e) })));
  });

  // Read state on the server, so it follows the user across devices. The marker only moves forward.
  app.get('/v1/alerts/seen', async (c) => {
    const account = c.get('account');
    const upTo = await deps.store.alertsSeen(account);
    const entries = await deps.store.audit.list(account, 500);
    const unread = entries.filter((e) => (e.kind === 'alert' || e.kind === 'degraded') && e.seq > upTo).length;
    return c.json({ upTo, unread });
  });
  app.post('/v1/alerts/seen', async (c) => {
    const account = c.get('account');
    if (!(await deps.store.user(account))) return c.json({ error: 'complete onboarding first' }, 409);
    const { upTo } = await c.req.json<{ upTo: unknown }>().catch(() => ({ upTo: null }));
    if (typeof upTo !== 'number' || !Number.isInteger(upTo) || upTo < 0) return c.json({ error: 'upTo must be an alert seq (a whole number)' }, 400);
    return c.json({ upTo: await deps.store.markAlertsSeen(account, upTo) });
  });

  // -------------------------------------------------------------- guard status
  // The worker judges the state on every evaluation and writes it here. The API overrides it only to
  // be more cautious: what it knows first (kill switch, no rules), and a status the worker has stopped
  // refreshing, or one written before the user's latest change, is shown as paused (stale_data).
  app.get('/v1/guard/status', async (c) => {
    const account = c.get('account');
    const [user, confirmed, s] = await Promise.all([deps.store.user(account), deps.store.policy(account), deps.store.guardStatus(account)]);
    const times = { lastEvaluatedAt: s?.lastEvaluatedAt ?? null, updatedAt: s?.updatedAt ?? null };
    const out = (state: GuardState, reason: PausedReason | null = null) => c.json({ state, reason, ...times });
    if (user?.killSwitch) return out('stopped');
    if (!user || !confirmed || confirmed.policy.rules.length === 0) return out('no_rules');
    if (!s || deps.now() - s.updatedAt > STATUS_MAX_AGE_MS) return out('paused', 'stale_data');
    if (s.state === 'stopped' || s.state === 'no_rules') return out('paused', 'stale_data'); // the worker has not seen the change yet
    return out(s.state, s.reason);
  });

  // -------------------------------------------------------------- guard orders (the guard's own resting backstops)
  app.get('/v1/guard-orders', async (c) => c.json(await deps.store.guardOrders(c.get('account'))));

  // -------------------------------------------------------------- audit
  // Newest first; `before` pages back through the whole chain (F8: the app verifies all of it, not only 500 entries).
  app.get('/v1/audit', async (c) => {
    const limit = Math.max(1, Math.min(500, Math.floor(Number(c.req.query('limit') ?? 100)) || 100));
    const before = c.req.query('before') !== undefined ? Math.floor(Number(c.req.query('before'))) : undefined;
    if (before !== undefined && !(before > 0)) return c.json({ error: 'before must be a positive sequence number' }, 400);
    return c.json(await deps.store.audit.list(c.get('account'), limit, before));
  });

  // -------------------------------------------------------------- commands (each signed by the user)
  app.post('/v1/commands', async (c) => {
    const account = c.get('account');
    const body = await c.req.json<{ command: CommandName; minutes?: number; issuedAt: number; signature: Hex; chainId: number }>();
    const minutes = body.minutes ?? 0;
    if (!['unwind', 'stop', 'resume', 'wipe'].includes(body.command)) return c.json({ error: 'unknown command' }, 400);
    if (Math.abs(deps.now() - body.issuedAt) > COMMAND_MAX_AGE_MS) return c.json({ error: 'command expired; sign again' }, 400);
    if (body.command === 'unwind' && (minutes < 5 || minutes > 7 * 24 * 60)) return c.json({ error: 'unwind time must be 5 minutes to 7 days' }, 400);
    const ok = !isContractWalletSignature(body.signature) && (await verifyTypedData({
      address: account,
      domain: policyConfirmationDomain(body.chainId),
      types: COMMAND_TYPES,
      primaryType: 'BulwarkCommand',
      message: { account, network: deps.network, command: body.command, minutes, issuedAt: BigInt(body.issuedAt) },
      signature: normalizeSignature(body.signature),
    }).catch(() => false));
    if (!ok) return refuseSignature(c, account, body.signature, 'signature does not match');
    // Every command is recorded, resume too, and a signature is used once (F5: no replay within its 60 s).
    let id: number;
    try {
      id = await deps.store.addCommand({ account, command: body.command, minutes, issuedAt: body.issuedAt, signature: body.signature, chainId: body.chainId, network: deps.network }, deps.now());
    } catch (e) {
      if (/commands_signature_once|duplicate key/.test(String((e as Error).message))) return c.json({ error: 'this signed command was already used; sign it again' }, 409);
      throw e;
    }
    if (body.command === 'resume') await deps.store.finishCommand(id, { resumed: true }, deps.now());
    // Stop (and wipe, which implies stop) take effect at once; the worker cancels guard orders, then wipes.
    if (body.command === 'stop' || body.command === 'wipe') await deps.store.setKillSwitch(account, true);
    if (body.command === 'resume') await deps.store.setKillSwitch(account, false);
    await deps.store.audit.append({ account, at: deps.now(), kind: 'command', why: 'You signed this command', what: body.command === 'unwind' ? `Panic unwind over ${minutes} min` : body.command === 'stop' ? 'Kill switch on' : body.command === 'wipe' ? 'Guard stopped; stored guard key to be wiped' : 'Guard resumed', proof: { signature: body.signature } });
    return c.json({ id: body.command === 'resume' ? null : id, command: body.command });
  });

  // -------------------------------------------------------------- telegram linking
  // The signed-in owner's own link, with the chat id: a guard run outside the hosted worker (the funded mainnet
  // canary, run on the owner's machine) sends its alerts to the same chat through the same bot.
  app.get('/v1/telegram', async (c) => {
    const user = await deps.store.user(c.get('account'));
    return c.json({ linked: Boolean(user?.telegramChatId), chatId: user?.telegramChatId ?? null });
  });
  // Unlink: the chat id is removed; alerts then show in the app only.
  app.delete('/v1/telegram', async (c) => {
    const account = c.get('account');
    const user = await deps.store.user(account);
    if (!user) return c.json({ error: 'complete onboarding first' }, 409);
    await deps.store.upsertUser({ ...user, telegramChatId: null }, deps.now());
    await deps.store.audit.append({ account, at: deps.now(), kind: 'command', why: 'You unlinked Telegram', what: 'Telegram alerts off; your chat id was removed' });
    return c.json({ linked: false });
  });

  app.post('/v1/telegram/code', async (c) => {
    const account = c.get('account');
    if (!(await deps.store.user(account))) return c.json({ error: 'complete onboarding first' }, 409);
    const code = randomBytes(5).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 7);
    await deps.store.createTelegramCode(code, account, deps.now() + 15 * 60_000);
    const bot = deps.telegramBot;
    return c.json({ code, expiresInMinutes: 15, bot: bot ? `@${bot}` : null, link: bot ? `https://t.me/${bot}?start=${code}` : null });
  });

  return Object.assign(app, { watchdog: () => watchdog() });
}

/** Current account value and marks, from Hyperliquid's own state. */
async function accountNow(deps: ApiDeps, account: Hex) {
  const perpDexs = (await deps.info.perpDexs()) as RawPerpDexs;
  const metas = (await deps.info.allPerpMetas()) as RawPerpMeta[];
  const assets = buildAssetIndex(perpDexs, metas);
  const dexStates: Record<string, never> = {};
  for (const d of ['', 'xyz']) dexStates[d] = (await deps.info.clearinghouseState(account, d)) as never;
  const snapshot = buildSnapshot({
    abstraction: await deps.info.userAbstraction(account),
    dexStates,
    spot: (await deps.info.spotClearinghouseState(account)) as never,
    assets,
    dexCollateral: dexCollateral(perpDexs, metas),
  });
  const risk = assessRisk(snapshot);
  return { accountValue: risk.accountValue, marks: Object.fromEntries(snapshot.positions.map((p) => [p.coin, p.markAtSnapshot])) };
}

/**
 * Disables, and schedules for deletion, every KMS key that was wiped or replaced. Runs on the API because
 * only the provisioner role may do this; the signing role can only sign. AWS deletes a scheduled key after
 * 7 days; until then it is disabled and cannot sign. Safe to repeat.
 */
export async function retireKmsKeys(deps: Pick<ApiDeps, 'store' | 'network' | 'retireKmsKey' | 'now'>): Promise<{ retired: number; failed: number }> {
  if (!deps.retireKmsKey) return { retired: 0, failed: 0 };
  let retired = 0;
  let failed = 0;
  for (const k of await deps.store.kmsKeysToRetire(deps.network)) {
    try {
      await deps.retireKmsKey(k.kmsKeyId);
    } catch (e) {
      // Already pending deletion, or gone: nothing left to do. Anything else is retried next round.
      const name = (e as Error).name;
      if (name !== 'KMSInvalidStateException' && name !== 'NotFoundException') {
        failed++;
        console.error(JSON.stringify({ msg: 'kms key retirement failed', account: k.account, error: name, detail: (e as Error).message }));
        continue;
      }
    }
    const now = deps.now();
    await deps.store.markKmsRetired(k.account, k.network, k.address, now);
    await deps.store.audit.append({ account: k.account, at: now, kind: 'key', why: 'Your guard key was wiped or replaced', what: `AWS KMS key for ${k.address} disabled; AWS deletes it after 7 days`, proof: { address: k.address, kmsKeyId: k.kmsKeyId } });
    retired++;
  }
  return { retired, failed };
}
