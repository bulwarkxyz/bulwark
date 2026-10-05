import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { recoverAddress, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { KmsDigestSigner, LocalDigestSigner, addressFromSpki, parseDerSignature, type Hex, type KmsBackend } from '../src/index.js';

const KEY = `0x${'42'.repeat(32)}` as const;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function derInt(n: bigint): Uint8Array {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let b = hexToBytes(hex);
  if ((b[0] as number) & 0x80) b = new Uint8Array([0, ...b]); // keep it positive
  return new Uint8Array([0x02, b.length, ...b]);
}
function der(r: bigint, s: bigint): Uint8Array {
  const body = new Uint8Array([...derInt(r), ...derInt(s)]);
  return new Uint8Array([0x30, body.length, ...body]);
}

/** A stand-in for KMS: same key, emits DER like KMS does, optionally the high-s twin of the signature. */
function fakeKms(privateKey: Hex, { highS }: { highS: boolean }): KmsBackend {
  const pub = secp256k1.getPublicKey(hexToBytes(privateKey.slice(2)), false);
  // SubjectPublicKeyInfo header for an EC public key on secp256k1 (as KMS returns it), then the point.
  const header = hexToBytes('3056301006072a8648ce3d020106052b8104000a034200');
  return {
    async getPublicKey() {
      return new Uint8Array([...header, ...pub]);
    },
    async sign(_keyId, digest) {
      const compact = secp256k1.sign(digest, hexToBytes(privateKey.slice(2)), { prehash: false, lowS: true });
      const r = BigInt(`0x${bytesToHex(compact.slice(0, 32))}`);
      const s = BigInt(`0x${bytesToHex(compact.slice(32, 64))}`);
      return der(r, highS ? N - s : s);
    },
  };
}

const digest = keccak256(toHex('bulwark'));

describe('local signer', () => {
  it('signs digests that recover to its address', async () => {
    const s = new LocalDigestSigner(KEY);
    const sig = await s.signDigest(digest);
    expect((await recoverAddress({ hash: digest, signature: { r: sig.r, s: sig.s, v: BigInt(sig.v) } })).toLowerCase()).toBe(s.address);
  });
});

describe('KMS signer', () => {
  it('derives the address from the KMS public key', async () => {
    const backend = fakeKms(KEY, { highS: false });
    expect(addressFromSpki(await backend.getPublicKey('k'))).toBe(privateKeyToAccount(KEY).address.toLowerCase());
  });

  it.each([false, true])('produces the same signature as the local key (KMS returned high-s: %s)', async (highS) => {
    const kms = await KmsDigestSigner.load(fakeKms(KEY, { highS }), 'key-1');
    const local = new LocalDigestSigner(KEY);
    expect(kms.address).toBe(local.address);
    const a = await kms.signDigest(digest);
    const b = await local.signDigest(digest);
    expect(a).toEqual(b); // low-s normalised, same r, same v
  });

  it('parses DER with leading zero bytes and long-form lengths', () => {
    const r = 0x80n << 248n; // high bit set → needs a 0x00 pad
    const parsed = parseDerSignature(der(r, 5n));
    expect(parsed).toEqual({ r, s: 5n });
  });

  it('refuses a signature that does not recover to the key', async () => {
    const wrong = fakeKms(`0x${'43'.repeat(32)}`, { highS: false });
    const backend: KmsBackend = { getPublicKey: fakeKms(KEY, { highS: false }).getPublicKey, sign: wrong.sign };
    const kms = await KmsDigestSigner.load(backend, 'key-1');
    await expect(kms.signDigest(digest)).rejects.toThrow(/does not recover/);
  });
});
