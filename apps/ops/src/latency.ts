/**
 * Tick-to-order latency, measured where the worker runs (Railway Singapore). Read-only on mainnet; the
 * only exchange call is a signed cancel of a non-existent order on TESTNET, which changes nothing.
 *
 *   SIGNER=local  (default) — a throwaway key, measures the network legs
 *   SIGNER=kms KMS_KEY_ID=… AWS_REGION=ap-southeast-1 — real KMS signing
 *   SIGNER=sealed — the encrypted-at-rest signer: a throwaway key sealed under a throwaway master key;
 *                   every signature decrypts (AES-256-GCM), signs, zeroes and checks recovery
 *
 * For each sample: mainnet xyz mark tick arrives on the WebSocket → the guard evaluates → the action is
 * signed → POSTed to the testnet exchange → response. Prints p50/p90 per leg.
 */
import { buildAssetIndex, type RawPerpDexs, type RawPerpMeta } from '@bulwarkxyz/guard-core';
import { ExchangeClient, InfoClient, cancelAction, digestOf, l1ActionHash, l1TypedData } from '@bulwarkxyz/hyperliquid';
import { randomBytes } from 'node:crypto';
import { AwsKmsBackend, KmsDigestSigner, LocalDigestSigner, SealedDigestSigner, createSealedAgentKey, parseMasterKeys, type DigestSigner } from '@bulwarkxyz/signer';
import http from 'node:http';
import { generatePrivateKey } from 'viem/accounts';
import WebSocket from 'ws';

const N = Number(process.env.SAMPLES ?? 30);
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] ?? NaN;
const stat = (a: number[]) => ({ n: a.length, p50: +q(a, 0.5).toFixed(1), p90: +q(a, 0.9).toFixed(1), max: +Math.max(...a).toFixed(1) });
let result: unknown = { status: 'running' };
http.createServer((_, res) => res.end(JSON.stringify(result, null, 2))).listen(Number(process.env.PORT ?? 8080));

async function signer(): Promise<DigestSigner> {
  if (process.env.SIGNER === 'kms') return KmsDigestSigner.load(AwsKmsBackend.fromEnv(), process.env.KMS_KEY_ID as string);
  if (process.env.SIGNER === 'sealed') {
    const master = parseMasterKeys(`probe:${randomBytes(32).toString('base64')}`);
    const account = '0x0000000000000000000000000000000000000001';
    const k = createSealedAgentKey(master, account, 'testnet');
    return new SealedDigestSigner(master, account, 'testnet', k.sealed, k.address);
  }
  return new LocalDigestSigner(generatePrivateKey());
}

async function main() {
  const s = await signer();
  const testnet = new ExchangeClient('testnet');
  const assets = buildAssetIndex((await new InfoClient('mainnet').perpDexs()) as RawPerpDexs, (await new InfoClient('mainnet').allPerpMetas()) as RawPerpMeta[]);
  const cl = assets.get('xyz:CL')!;

  const signMs: number[] = [];
  const postMs: number[] = [];
  const tickToSent: number[] = [];
  const tickToResponse: number[] = [];

  // KMS / local signing alone
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await s.signDigest(digestOf(l1TypedData(l1ActionHash({ action: cancelAction([{ asset: cl.assetId, oid: 1 }]), nonce: Date.now() + i }), false)));
    signMs.push(performance.now() - t);
  }

  // Full path on live mainnet ticks
  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'activeAssetCtx', coin: 'xyz:CL' } }));
  let busy = false;
  await new Promise<void>((done) => {
    ws.on('message', async (raw) => {
      const tick = performance.now();
      const msg = JSON.parse(String(raw)) as { channel?: string };
      if (msg.channel !== 'activeAssetCtx' || busy) return;
      busy = true;
      const action = cancelAction([{ asset: cl.assetId, oid: 1 }]); // stands in for the guard's decision
      const nonce = Date.now();
      const sig = await s.signDigest(digestOf(l1TypedData(l1ActionHash({ action, nonce }), false)));
      const sent = performance.now();
      await testnet.send({ action, nonce, signature: sig }).catch(() => undefined);
      const back = performance.now();
      tickToSent.push(sent - tick);
      postMs.push(back - sent);
      tickToResponse.push(back - tick);
      busy = false;
      if (tickToResponse.length >= N) {
        ws.close();
        done();
      }
    });
  });

  result = {
    region: process.env.RAILWAY_REPLICA_REGION ?? 'local',
    signer: process.env.SIGNER ?? 'local',
    at: new Date().toISOString(),
    sign_ms: stat(signMs),
    tick_to_signed_and_sent_ms: stat(tickToSent),
    post_round_trip_ms: stat(postMs),
    tick_to_exchange_response_ms: stat(tickToResponse),
  };
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  result = { error: String(e) };
  console.error(e);
});
