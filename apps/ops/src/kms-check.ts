/**
 * KMS end-to-end check. Credentials come from the environment only (AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, AWS_REGION); nothing is printed but key ids, addresses and timings.
 *
 *   kms-check create            (provisioner) create a tagged test key, print its id and address
 *   kms-check sign <keyId> [n]  (signer) sign n random digests, check each recovers to the key's address, time them
 *   kms-check retire <keyId>    (provisioner) disable and schedule deletion in 7 days
 */
import { randomBytes } from 'node:crypto';
import { KMSClient } from '@aws-sdk/client-kms';
import { AwsKmsBackend, KmsDigestSigner, createGuardKey, retireGuardKey } from '@bulwarkxyz/signer';
import { recoverAddress, type Hex } from 'viem';

const [cmd, arg, nArg] = process.argv.slice(2);
const region = process.env.AWS_REGION ?? 'ap-southeast-1';

async function main() {
  if (cmd === 'create') {
    const t0 = performance.now();
    const k = await createGuardKey(new KMSClient({ region }), { user: '0x0000000000000000000000000000000000000000', env: 'kms-check' });
    console.log(JSON.stringify({ keyId: k.keyId, address: k.address, createMs: +(performance.now() - t0).toFixed(1) }));
    return;
  }
  if (cmd === 'sign' && arg) {
    const n = Number(nArg ?? 30);
    const t0 = performance.now();
    const signer = await KmsDigestSigner.load(AwsKmsBackend.fromEnv(), arg);
    const loadMs = performance.now() - t0;
    const ms: number[] = [];
    for (let i = 0; i < n; i++) {
      const digest = `0x${randomBytes(32).toString('hex')}` as Hex;
      const s0 = performance.now();
      const sig = await signer.signDigest(digest);
      ms.push(performance.now() - s0);
      const rec = await recoverAddress({ hash: digest, signature: sig as never });
      if (rec.toLowerCase() !== signer.address.toLowerCase()) throw new Error(`signature ${i} does not recover to the key`);
    }
    ms.sort((a, b) => a - b);
    const q = (p: number) => +ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]!.toFixed(1);
    console.log(JSON.stringify({ address: signer.address, loadMs: +loadMs.toFixed(1), n, recovered: n, signMs: { p50: q(0.5), p90: q(0.9), max: +ms[ms.length - 1]!.toFixed(1) } }));
    return;
  }
  if (cmd === 'retire' && arg) {
    await retireGuardKey(new KMSClient({ region }), arg);
    console.log(JSON.stringify({ retired: arg }));
    return;
  }
  console.error('usage: kms-check create | sign <keyId> [n] | retire <keyId>');
  process.exit(2);
}

main().catch((e: Error & { name?: string }) => {
  // AWS errors carry the denied action, never the credentials.
  console.error(JSON.stringify({ error: e.name, message: e.message }));
  process.exit(1);
});
