import { randomBytes } from 'node:crypto';
import { BUILDER_ADDRESS, BUILDER_FEE_TENTHS_BPS, regionVerdict, strictestVerdict } from '@bulwarkxyz/config';
import {
  COMMAND_TYPES,
  POLICY_CONFIRMATION_TYPES,
  Policy,
  assessRisk,
  buildAssetIndex,
  buildSnapshot,
  dexCollateral,
  policyConfirmationDomain,
  policyHash,
  type CommandName,
  type RawPerpDexs,
  type RawPerpMeta,
} from '@bulwarkxyz/guard-core';
import { compileRule, describeRule, type MarketRef, type MessagesClient } from '@bulwarkxyz/compiler';
import type { Hex, InfoClient } from '@bulwarkxyz/hyperliquid';
import type { ApiStore } from '@bulwarkxyz/store';
import { Hono, type Context } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import { getAddress, verifyMessage, verifyTypedData } from 'viem';
import { parseSiweMessage } from 'viem/siwe';

export interface ApiDeps {
  store: ApiStore;
  info: Pick<InfoClient, 'extraAgents' | 'maxBuilderFee' | 'userAbstraction' | 'clearinghouseState' | 'spotClearinghouseState' | 'perpDexs' | 'allPerpMetas'>;
  jwtSecret: Uint8Array;
  /** The web app's server proxy proves itself with this; only then are its location headers trusted. */
  proxySecret: string;
  siweDomain: string;
  /** Creates a per-user KMS key; absent until AWS access exists. */
  provisionAgent?: (account: Hex) => Promise<{ keyId: string; address: Hex }>;
  /** Claude client for the plain-language translator; absent without ANTHROPIC_API_KEY. */
  translator?: MessagesClient;
  now: () => number;
}

/** Translator calls per account per hour (cost cap). */
export const DRAFTS_PER_HOUR = 30;

type Env = { Variables: { account: Hex } };

/** A command must be submitted within this long of the user signing it (engine constant). */
export const COMMAND_MAX_AGE_MS = 60_000;
const NONCE_TTL_MS = 10 * 60_000;
const SESSION_HOURS = 12;

export function createApp(deps: ApiDeps) {
  const app = new Hono<Env>();
  const nonces = new Map<string, { nonce: string; exp: number }>();
  const draftTimes = new Map<string, number[]>();
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

  app.get('/health', (c) => c.json({ ok: true }));

  // -------------------------------------------------------------- sign in with Ethereum (EIP-4361)
  app.post('/auth/nonce', async (c) => {
    const { address } = await c.req.json<{ address: string }>();
    const nonce = randomBytes(12).toString('hex');
    nonces.set(getAddress(address), { nonce, exp: deps.now() + NONCE_TTL_MS });
    return c.json({ nonce, domain: deps.siweDomain });
  });

  app.post('/auth/verify', async (c) => {
    const { message, signature } = await c.req.json<{ message: string; signature: Hex }>();
    const parsed = parseSiweMessage(message);
    if (!parsed.address || parsed.domain !== deps.siweDomain) return c.json({ error: 'wrong domain' }, 401);
    const expected = nonces.get(getAddress(parsed.address));
    if (!expected || expected.nonce !== parsed.nonce || expected.exp < deps.now()) return c.json({ error: 'nonce expired' }, 401);
    if (!(await verifyMessage({ address: parsed.address, message, signature }))) return c.json({ error: 'bad signature' }, 401);
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
    const [user, confirmed] = await Promise.all([deps.store.user(account), deps.store.policy(account)]);
    const agents = user?.agentAddress ? await deps.info.extraAgents(account).catch(() => []) : [];
    const agent = user?.agentAddress ? agents.find((a) => a.address.toLowerCase() === user.agentAddress?.toLowerCase()) : undefined;
    const maxFee = await deps.info.maxBuilderFee(account, BUILDER_ADDRESS).catch(() => 0);
    return c.json({
      account,
      user,
      agent: user?.agentAddress ? { address: user.agentAddress, approved: Boolean(agent), validUntil: agent?.validUntil ?? null } : null,
      builder: { address: BUILDER_ADDRESS, feeTenthsBps: BUILDER_FEE_TENTHS_BPS, approvedMaxTenthsBps: maxFee },
      policy: confirmed ? { version: confirmed.policy.version, hash: confirmed.hash, confirmedAt: confirmed.confirmedAt, policy: confirmed.policy } : null,
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
    if (!deps.provisionAgent) return c.json({ error: 'guard keys are not available yet' }, 503);
    const { keyId, address } = await deps.provisionAgent(account);
    await deps.store.upsertUser({ ...user, agentKeyRef: `kms:${keyId}`, agentAddress: address }, deps.now());
    return c.json({ agentAddress: address });
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
    const current = await deps.store.policy(account);
    if (policy.version !== (current?.policy.version ?? 0) + 1) return c.json({ error: 'stale version' }, 409);
    const hash = policyHash(policy);
    const ok = await verifyTypedData({
      address: account,
      domain: policyConfirmationDomain(body.chainId),
      types: POLICY_CONFIRMATION_TYPES,
      primaryType: 'BulwarkPolicy',
      message: { account, version: BigInt(policy.version), policyHash: hash },
      signature: body.signature,
    });
    if (!ok) return c.json({ error: 'signature does not match' }, 401);
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
    const { text } = await c.req.json<{ text: string }>();
    if (typeof text !== 'string') return c.json({ error: 'text required' }, 400);
    const current = await deps.store.policy(account);
    if (!current) return c.json({ error: 'sign your first rules (with your slippage limit) before using the translator' }, 409);
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

  // -------------------------------------------------------------- guard orders (the guard's own resting backstops)
  app.get('/v1/guard-orders', async (c) => c.json(await deps.store.guardOrders(c.get('account'))));

  // -------------------------------------------------------------- audit
  app.get('/v1/audit', async (c) => c.json(await deps.store.audit.list(c.get('account'), Math.min(500, Number(c.req.query('limit') ?? 100)))));

  // -------------------------------------------------------------- commands (each signed by the user)
  app.post('/v1/commands', async (c) => {
    const account = c.get('account');
    const body = await c.req.json<{ command: CommandName; minutes?: number; issuedAt: number; signature: Hex; chainId: number }>();
    const minutes = body.minutes ?? 0;
    if (!['unwind', 'stop', 'resume'].includes(body.command)) return c.json({ error: 'unknown command' }, 400);
    if (Math.abs(deps.now() - body.issuedAt) > COMMAND_MAX_AGE_MS) return c.json({ error: 'command expired; sign again' }, 400);
    if (body.command === 'unwind' && (minutes < 5 || minutes > 7 * 24 * 60)) return c.json({ error: 'unwind time must be 5 minutes to 7 days' }, 400);
    const ok = await verifyTypedData({
      address: account,
      domain: policyConfirmationDomain(body.chainId),
      types: COMMAND_TYPES,
      primaryType: 'BulwarkCommand',
      message: { account, command: body.command, minutes, issuedAt: BigInt(body.issuedAt) },
      signature: body.signature,
    });
    if (!ok) return c.json({ error: 'signature does not match' }, 401);
    if (body.command === 'stop') await deps.store.setKillSwitch(account, true); // effective at once; the worker cancels guard orders
    if (body.command === 'resume') await deps.store.setKillSwitch(account, false);
    const id = body.command === 'resume' ? null : await deps.store.addCommand({ account, command: body.command, minutes, issuedAt: body.issuedAt, signature: body.signature }, deps.now());
    await deps.store.audit.append({ account, at: deps.now(), kind: 'command', why: 'You signed this command', what: body.command === 'unwind' ? `Panic unwind over ${minutes} min` : body.command === 'stop' ? 'Kill switch on' : 'Guard resumed', proof: { signature: body.signature } });
    return c.json({ id, command: body.command });
  });

  // -------------------------------------------------------------- telegram linking
  app.post('/v1/telegram/code', async (c) => {
    const account = c.get('account');
    if (!(await deps.store.user(account))) return c.json({ error: 'complete onboarding first' }, 409);
    const code = randomBytes(5).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 7);
    await deps.store.createTelegramCode(code, account, deps.now() + 15 * 60_000);
    return c.json({ code, expiresInMinutes: 15 });
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
