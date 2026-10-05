/**
 * Bulwark guard worker. Runs on Railway (Southeast Asia, closest region to Hyperliquid's Tokyo servers).
 *
 * Env:
 *   NETWORK                         mainnet | testnet
 *   DATABASE_URL                    Postgres (Railway)
 *   TELEGRAM_BOT_TOKEN              optional; alerts and /link go to the console without it
 *   SIGNER_MASTER_KEYS              `id:base64` master keys, active first: enables encrypted-at-rest agent keys
 *   AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY   KMS signer (bulwark-signer IAM user)
 *   BUILDER_CODE_ENABLED_MAINNET    default false (decision D6)
 *   PORT                            health endpoint
 * Agent keys: `sealed:<address>` (AES-256-GCM under the master key; the active signer while KMS is
 * unavailable), `kms:<keyId>`, or `env:<VAR>` (a raw key in an env var, testnet only).
 */
import http from 'node:http';
import { builderField, type Network as ConfigNetwork } from '@bulwarkxyz/config';
import { CommandSigner, GuardedSigner } from '@bulwarkxyz/executor';
import { buildAssetIndex, dexCollateral, type AssetIndex, type OpenOrder, type RawPerpDexs, type RawPerpMeta } from '@bulwarkxyz/guard-core';
import { ExchangeClient, InfoClient, NonceManager, type Hex, type Network } from '@bulwarkxyz/hyperliquid';
import { AwsKmsBackend, KmsDigestSigner, LocalDigestSigner, SealedDigestSigner, parseMasterKeys, type DigestSigner } from '@bulwarkxyz/signer';
import postgres from 'postgres';
import { GuardEngine, STATUS_WRITE_EVERY_MS } from './guard.js';
import { KeyService, SEALED_PREFIX } from './keys.js';
import { ConsoleNotifier, TelegramNotifier } from './notify.js';
import { PgStore, migrate } from '@bulwarkxyz/store';
import { HyperliquidStream, MAX_USERS_PER_CONNECTION, marksFromCtxs } from './stream.js';
import { TelegramBot } from './telegram-bot.js';

const network = (process.env.NETWORK ?? 'testnet') as Network;
const WS_URL = network === 'mainnet' ? 'wss://api.hyperliquid.xyz/ws' : 'wss://api.hyperliquid-testnet.xyz/ws';
const info = new InfoClient(network);
const sql = postgres(process.env.DATABASE_URL as string, { onnotice: () => undefined, max: 5 });
const store = new PgStore(sql);
const notifier = process.env.TELEGRAM_BOT_TOKEN ? new TelegramNotifier(process.env.TELEGRAM_BOT_TOKEN) : new ConsoleNotifier();

// The master key is read once and removed from the environment so nothing later can print it.
const master = process.env.SIGNER_MASTER_KEYS ? parseMasterKeys(process.env.SIGNER_MASTER_KEYS) : null;
delete process.env.SIGNER_MASTER_KEYS;

const signers = new Map<string, Promise<DigestSigner>>();
let kms: AwsKmsBackend | null = null;
function digestSigner(account: string, ref: string): Promise<DigestSigner> {
  const cacheKey = `${account.toLowerCase()}|${ref}`;
  let s = signers.get(cacheKey);
  if (!s) {
    if (ref.startsWith(SEALED_PREFIX)) {
      if (!master) throw new Error('sealed agent keys need SIGNER_MASTER_KEYS on this service');
      const address = ref.slice(SEALED_PREFIX.length) as Hex;
      s = store.sealedKey(account, network, address).then((k) => {
        if (!k) throw new Error('no stored guard key for this account');
        return new SealedDigestSigner(master, account, network, k.sealed, address);
      });
    } else if (ref.startsWith('kms:')) {
      kms ??= AwsKmsBackend.fromEnv();
      s = KmsDigestSigner.load(kms, ref.slice(4));
    } else if (ref.startsWith('env:') && network === 'testnet') {
      const key = process.env[ref.slice(4)];
      if (!key) throw new Error(`missing ${ref}`);
      s = Promise.resolve(new LocalDigestSigner(key as Hex));
    } else {
      throw new Error(`agent key ref not allowed on ${network}: ${ref.split(':')[0]}`);
    }
    signers.set(cacheKey, s);
    s.catch(() => signers.delete(cacheKey));
  }
  return s;
}
const dropSigners = (account: string) => {
  for (const k of signers.keys()) if (k.startsWith(`${account.toLowerCase()}|`)) signers.delete(k);
};

async function loadAssets(): Promise<{ assets: AssetIndex; collateral: Map<string, number>; universe: Map<string, string[]> }> {
  const perpDexs = (await info.perpDexs()) as RawPerpDexs;
  const metas = (await info.allPerpMetas()) as RawPerpMeta[];
  return {
    assets: buildAssetIndex(perpDexs, metas),
    collateral: dexCollateral(perpDexs, metas),
    universe: new Map(metas.map((m, i) => [perpDexs[i] === null ? '' : (perpDexs[i] as { name: string }).name, m.universe.map((u) => u.name)])),
  };
}

/** Railway's private DNS can take a few seconds to come up after the container starts: retry. */
async function migrateWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate(sql);
      return;
    } catch (e) {
      if (attempt >= 12) throw e;
      console.error(JSON.stringify({ msg: 'database not reachable yet', attempt, error: String(e) }));
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
    }
  }
}

async function main() {
  await migrateWithRetry();
  let meta = await loadAssets();
  const status = { network, startedAt: new Date().toISOString(), users: 0, lastMarkAt: 0, streams: 0 };

  const engine = new GuardEngine({
    network,
    get assets() {
      return meta.assets;
    },
    get collateral() {
      return meta.collateral;
    },
    store,
    notifier,
    exchange: new ExchangeClient(network),
    nonces: new NonceManager(),
    openOrders: async (user, dex) => {
      const rows = (await info.frontendOpenOrders(user, dex)) as Array<{ coin: string; oid: number; side: 'B' | 'A'; reduceOnly: boolean; isTrigger: boolean; triggerPx?: string; sz: string }>;
      return rows.map((r): OpenOrder => ({ coin: r.coin, oid: r.oid, side: r.side, reduceOnly: r.reduceOnly, isTrigger: r.isTrigger, ...(r.triggerPx ? { triggerPx: Number(r.triggerPx) } : {}), size: Number(r.sz) }));
    },
    abstraction: (user) => info.userAbstraction(user),
    signerFor: async (user) => {
      const u = await store.user(user);
      if (!u) throw new Error('unknown user');
      return new GuardedSigner(await digestSigner(user, u.agentKeyRef), network === 'mainnet');
    },
    commandSignerFor: async (user) => {
      const u = await store.user(user);
      if (!u) throw new Error('unknown user');
      return new CommandSigner(await digestSigner(user, u.agentKeyRef), network === 'mainnet');
    },
    builder: builderField(network as ConfigNetwork) as { b: Hex; f: number } | null,
    agents: async (user) => (await info.extraAgents(user)) as Array<{ address: string; validUntil?: number | null }>,
    now: Date.now,
  });

  // Marks for every dex on one connection; users on further connections, 10 per connection (per-IP limit).
  const markStream = new HyperliquidStream(WS_URL, {
    onMarks: (ctxs, at) => {
      status.lastMarkAt = at;
      void engine.onMarks(marksFromCtxs(ctxs, meta.universe), at);
    },
  });
  markStream.subscribeMarks();
  markStream.start();
  const userStreams: HyperliquidStream[] = [];
  const tracked = new Set<string>();
  const handlers = {
    onUserState: (u: string, states: Parameters<GuardEngine['onUserState']>[1], at: number) => void engine.onUserState(u, states, at),
    onSpotState: (u: string, spot: Parameters<GuardEngine['onSpotState']>[1], at: number) => void engine.onSpotState(u, spot, at),
  };
  async function syncUsers() {
    for (const u of await store.users()) {
      const k = u.account.toLowerCase();
      if (tracked.has(k)) continue;
      let s = userStreams.find((x) => x.userCount < MAX_USERS_PER_CONNECTION);
      if (!s) {
        s = new HyperliquidStream(WS_URL, handlers);
        s.start();
        userStreams.push(s);
      }
      s.subscribeUser(k);
      tracked.add(k);
    }
    status.users = tracked.size;
    status.streams = userStreams.length + 1;
  }
  await syncUsers();
  setInterval(() => void syncUsers().catch((e) => console.error('syncUsers', e)), 30_000);
  // Keeps every account's guard status current while prices and positions are still.
  setInterval(() => void engine.heartbeat().catch((e) => console.error('heartbeat', e)), STATUS_WRITE_EVERY_MS);
  setInterval(() => void loadAssets().then((m) => (meta = m)).catch((e) => console.error('loadAssets', e)), 10 * 60_000);

  const keys = new KeyService({
    vault: store,
    store,
    master,
    network,
    approvedAgents: async (account) => ((await info.extraAgents(account as Hex)) as Array<{ address: string }>).map((a) => a.address),
    onKeyChanged: dropSigners,
    now: Date.now,
  });
  const resealed = await keys.resealAll();
  console.log(JSON.stringify({ msg: 'agent keys', sealedSigner: Boolean(master), activeMasterKey: master?.activeId ?? null, resealed }));

  // Signed user commands and key requests queued by the API.
  setInterval(async () => {
    try {
      await keys.processRequests();
      for (const cmd of await store.pendingCommands()) {
        let result: Record<string, unknown>;
        if (cmd.command === 'wipe') {
          // Cancel the guard's own orders while the key still exists, then destroy the key.
          const cancelled = await engine.command({ ...cmd, command: 'stop' }).catch((e) => ({ error: String(e) }));
          const wiped = await keys.wipe(cmd.account, 'You signed a command to wipe your guard key');
          result = { cancelled, wiped };
        } else {
          result = await engine.command(cmd).catch((e) => ({ error: String(e) }));
        }
        await store.finishCommand(cmd.id, result, Date.now());
      }
    } catch (e) {
      console.error('commands', e);
    }
  }, 2_000);
  setInterval(async () => {
    try {
      await keys.promoteRotations((await store.users()).map((u) => u.account));
    } catch (e) {
      console.error('key rotation', e);
    }
  }, 30_000);

  if (process.env.TELEGRAM_BOT_TOKEN) void new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, store).start();

  http
    .createServer((_, res) => {
      const markAgeMs = status.lastMarkAt ? Date.now() - status.lastMarkAt : null;
      res.statusCode = markAgeMs !== null && markAgeMs < 15_000 ? 200 : 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...status, markAgeMs }));
    })
    .listen(Number(process.env.PORT ?? 8080));
  console.log(JSON.stringify({ msg: 'worker started', network }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
