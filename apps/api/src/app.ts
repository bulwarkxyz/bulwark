import { randomBytes } from 'node:crypto';
import { BUILDER_ADDRESS, BUILDER_FEE_TENTHS_BPS, regionVerdict, strictestVerdict } from '@bulwarkxyz/config';
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
  /** Bytecode at an address (Arbitrum), used only to explain a failed signature from a smart-contract wallet. */
  codeAt?: (address: Hex) => Promise<Hex>;
  now: () => number;
}

/** Translator calls per account per hour (cost cap). */
export const DRAFTS_PER_HOUR = 30;

type Env = { Variables: { account: Hex } };

/** A command must be submitted within this long of the user signing it (engine constant). */
export const COMMAND_MAX_AGE_MS = 60_000;
/** The worker refreshes the status at least every 15 s; older than this, it has stopped reporting. */
export const STATUS_MAX_AGE_MS = 60_000;
const NONCE_TTL_MS = 10 * 60_000;
const SESSION_HOURS = 12;

export function createApp(deps: ApiDeps) {
  const app = new Hono<Env>();
  const nonces = new Map<string, { nonce: string; exp: number; domain: string }>();
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
    nonces.set(getAddress(address), { nonce, exp: deps.now() + NONCE_TTL_MS, domain });
    return c.json({ nonce, domain });
  });

  app.post('/auth/verify', async (c) => {
    const { message, signature } = await c.req.json<{ message: string; signature: Hex }>();
    const parsed = parseSiweMessage(message);
    const expected = parsed.address ? nonces.get(getAddress(parsed.address)) : undefined;
    if (!parsed.address || !parsed.domain || !siweDomains.has(parsed.domain) || (expected && expected.domain !== parsed.domain))
      return c.json({ error: 'This site is not allowed to sign in to Bulwark.', code: 'wrong_domain' }, 401);
    if (!expected || expected.nonce !== parsed.nonce || expected.exp < deps.now()) return c.json({ error: 'nonce expired' }, 401);
    if (isContractWalletSignature(signature) || !(await verifyMessage({ address: parsed.address, message, signature: normalizeSignature(signature) }).catch(() => false)))
      return refuseSignature(c, parsed.address, signature);
    nonces.delete(getAddress(parsed.address));
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(parsed.address.toLowerCase())
      .setIssuedAt()
      .setExpirationTime(`${SESSION_HOURS}h`)
      .sign(deps.jwtSecret);
    return c.json({ token });
  });

  // -------------------------------------------------------------- session
  app.use('/v1/*', async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    try {
      const { payload } = await jwtVerify(auth.replace(/^Bearer /, ''), deps.jwtSecret);
      c.set('account', payload.sub as Hex);
    } catch {
      return c.json({ error: 'sign in' }, 401);
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
      policy: confirmed ? { version: confirmed.policy.version, hash: confirmed.hash, confirmedAt: confirmed.confirmedAt, policy: confirmed.policy, needsRepeatChoice: needsRepeatChoice(confirmed.policy) } : null,
    });
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
    const user = await deps.store.user(account);
    if (!user) return c.json({ error: 'complete the region step first' }, 409);
    if (user.agentAddress && user.agentKeyRef !== 'pending') return c.json({ agentAddress: user.agentAddress });
    if (user.region !== 'allowed') return c.json({ error: 'the guard is off in your region' }, 403);
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
  });

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
      message: { account, version: BigInt(policy.version), policyHash: hash },
      signature: normalizeSignature(body.signature),
    }).catch(() => false));
    if (!ok) return refuseSignature(c, account, body.signature, 'signature does not match');
    const now = deps.now();
    await deps.store.confirmPolicy(account, { policy, hash, signature: body.signature, signatureVerified: true, confirmedAt: now });
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
    const recent = (draftTimes.get(account) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= DRAFTS_PER_HOUR) return c.json({ error: 'too many translations this hour; try again later' }, 429);
    draftTimes.set(account, [...recent, now]);

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
  app.get('/v1/audit', async (c) => c.json(await deps.store.audit.list(c.get('account'), Math.min(500, Number(c.req.query('limit') ?? 100)))));

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
      message: { account, command: body.command, minutes, issuedAt: BigInt(body.issuedAt) },
      signature: normalizeSignature(body.signature),
    }).catch(() => false));
    if (!ok) return refuseSignature(c, account, body.signature, 'signature does not match');
    // Stop (and wipe, which implies stop) take effect at once; the worker cancels guard orders, then wipes.
    if (body.command === 'stop' || body.command === 'wipe') await deps.store.setKillSwitch(account, true);
    if (body.command === 'resume') await deps.store.setKillSwitch(account, false);
    const id = body.command === 'resume' ? null : await deps.store.addCommand({ account, command: body.command, minutes, issuedAt: body.issuedAt, signature: body.signature }, deps.now());
    await deps.store.audit.append({ account, at: deps.now(), kind: 'command', why: 'You signed this command', what: body.command === 'unwind' ? `Panic unwind over ${minutes} min` : body.command === 'stop' ? 'Kill switch on' : body.command === 'wipe' ? 'Guard stopped; stored guard key to be wiped' : 'Guard resumed', proof: { signature: body.signature } });
    return c.json({ id, command: body.command });
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

  return app;
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
