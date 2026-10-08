/**
 * Bulwark API (Railway). Env: DATABASE_URL, JWT_SECRET, PROXY_SECRET, SIWE_DOMAIN, NETWORK (required: testnet or mainnet), PORT,
 * SIGNUP_ALLOWLIST (optional, comma-separated accounts: only these can sign in).
 * KMS key provisioning turns on when AWS credentials for the bulwark-provisioner IAM user are set
 * (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION=ap-southeast-1). The AI translator turns on with
 * TRANSLATOR_ENABLED=1 and OPENAI_API_KEY (TRANSLATOR_PROVIDER=anthropic with ANTHROPIC_API_KEY to switch back).
 */
import { serve } from '@hono/node-server';
import Anthropic from '@anthropic-ai/sdk';
import { KMSClient } from '@aws-sdk/client-kms';
import { anthropicProvider, openAIProvider, type MessagesClient } from '@bulwarkxyz/compiler';
import { InfoClient, type Hex, type Network } from '@bulwarkxyz/hyperliquid';
import { ProvisionerKms, createGuardKey, retireGuardKey } from '@bulwarkxyz/signer';
import { PgStore, migrate, stampNetwork } from '@bulwarkxyz/store';
import { parseNetwork } from '@bulwarkxyz/config';
import postgres from 'postgres';
import { arbitrumCode } from './signatures.js';
import { createApp, retireKmsKeys } from './app.js';

const network = parseNetwork(process.env.NETWORK) as Network;
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k}`);
  return v;
};
const sql = postgres(need('DATABASE_URL'), { onnotice: () => undefined, max: 5 });

async function main() {
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate(sql);
      break;
    } catch (e) {
      if (attempt >= 12) throw e;
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
    }
  }
  const kms = process.env.AWS_ACCESS_KEY_ID ? new ProvisionerKms(new KMSClient({ region: process.env.AWS_REGION ?? 'ap-southeast-1' })) : null;
  const store = new PgStore(sql);
  await stampNetwork(store, network, Date.now());
  // The translator runs only when switched on (after the eval's adversarial set passed) and keyed.
  const translator =
    process.env.TRANSLATOR_ENABLED !== '1'
      ? null
      : (process.env.TRANSLATOR_PROVIDER ?? 'openai') === 'openai'
        ? process.env.OPENAI_API_KEY
          ? openAIProvider({ apiKey: process.env.OPENAI_API_KEY })
          : null
        : process.env.ANTHROPIC_API_KEY
          ? anthropicProvider(new Anthropic({ maxRetries: 2, timeout: 60_000 }) as unknown as MessagesClient)
          : null;
  const app = createApp({
    signupAllowlist: process.env.SIGNUP_ALLOWLIST ? new Set(process.env.SIGNUP_ALLOWLIST.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean)) : undefined,
    store,
    info: new InfoClient(network),
    jwtSecret: new TextEncoder().encode(need('JWT_SECRET')),
    proxySecret: need('PROXY_SECRET'),
    siweDomain: process.env.SIWE_DOMAIN ?? 'bulwark.0xo.in',
    siweExtraDomains: (process.env.SIWE_EXTRA_DOMAINS ?? '').split(',').map((d) => d.trim()).filter(Boolean),
    ...(translator ? { translator } : {}),
    keyCustody: process.env.KEY_CUSTODY === 'kms' ? 'kms' : 'sealed',
    repeatChoiceRequired: process.env.REPEAT_CHOICE_REQUIRED === '1',
    network,
    ...(kms ? { provisionAgent: (account: Hex) => createGuardKey(kms, { user: account, env: network }) } : {}),
    telegramBot: process.env.TELEGRAM_BOT_USERNAME ?? 'BulwarkGuardBot',
    // Operator alerting: off until both are set (the bot token and the operator's own chat id).
    ...(process.env.TELEGRAM_BOT_TOKEN && process.env.OPERATOR_ALERT_CHAT_ID
      ? {
          operatorAlert: async (text: string) => {
            const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: process.env.OPERATOR_ALERT_CHAT_ID, text }), signal: AbortSignal.timeout(5000) });
            if (!r.ok) throw new Error(`telegram ${r.status}`);
          },
        }
      : {}),
    codeAt: arbitrumCode(),
    now: Date.now,
  });
  // Wiped or replaced KMS keys: disable and schedule deletion (provisioner role only).
  if (kms) {
    const retire = { store, network, retireKmsKey: (keyId: string) => retireGuardKey(kms, keyId), now: Date.now };
    setInterval(() => void retireKmsKeys(retire).catch((e) => console.error('retireKmsKeys', e)), 15_000);
  }
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) });
  // The operator watchdog (does nothing until operator alerting is configured).
  setInterval(() => void app.watchdog().catch((e) => console.error('watchdog', e)), 30_000);
  console.log(JSON.stringify({ msg: 'api started', network, kms: Boolean(kms), translator: translator?.id ?? null }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
