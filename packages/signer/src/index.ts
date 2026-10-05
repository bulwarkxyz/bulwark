import { CreateKeyCommand, DisableKeyCommand, GetPublicKeyCommand, KMSClient, ScheduleKeyDeletionCommand, SignCommand } from '@aws-sdk/client-kms';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { recoverAddress } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';

export type Hex = `0x${string}`;

export interface Signature {
  r: Hex;
  s: Hex;
  v: 27 | 28;
}

/**
 * Signs 32-byte digests (EIP-712 hashes) with a secp256k1 key. This is the only place a key is used.
 * The guarded signer in @bulwarkxyz/executor sits in front of it and re-runs the invariants first.
 */
export interface DigestSigner {
  readonly address: Hex;
  signDigest(digest: Hex): Promise<Signature>;
}

const pad32 = (b: Uint8Array): Hex => `0x${bytesToHex(b).padStart(64, '0')}` as Hex;
const hexOf = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;

// ---------------------------------------------------------------- local key (tests, test wallets)

export class LocalDigestSigner implements DigestSigner {
  readonly address: Hex;
  constructor(private readonly privateKey: Hex) {
    this.address = privateKeyToAccount(privateKey).address.toLowerCase() as Hex;
  }
  async signDigest(digest: Hex): Promise<Signature> {
    const sig = await sign({ hash: digest, privateKey: this.privateKey });
    return { r: sig.r, s: sig.s, v: Number(sig.v) as 27 | 28 };
  }
}

// ---------------------------------------------------------------- AWS KMS (production agent keys)

/** secp256k1 group order. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Parses a DER ECDSA signature `SEQUENCE { INTEGER r, INTEGER s }`. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  const expect = (tag: number) => {
    if (der[i] !== tag) throw new Error(`DER: expected 0x${tag.toString(16)} at ${i}`);
    i++;
  };
  const len = (): number => {
    const first = der[i++] as number;
    if (first < 0x80) return first;
    const bytes = first & 0x7f;
    let l = 0;
    for (let k = 0; k < bytes; k++) l = (l << 8) | (der[i++] as number);
    return l;
  };
  const int = (): bigint => {
    expect(0x02);
    const l = len();
    const v = der.slice(i, i + l);
    i += l;
    return BigInt(`0x${bytesToHex(v) || '0'}`);
  };
  expect(0x30);
  len();
  const r = int();
  const s = int();
  return { r, s };
}

/** Ethereum address from a DER SubjectPublicKeyInfo holding an uncompressed secp256k1 point. */
export function addressFromSpki(spki: Uint8Array): Hex {
  const point = spki.slice(spki.length - 65);
  if (point[0] !== 0x04) throw new Error('expected an uncompressed secp256k1 public key');
  return `0x${bytesToHex(keccak_256(point.slice(1)).slice(12))}` as Hex;
}

/** Turns a raw (r, s) into an Ethereum signature: low-s normalised (EIP-2) and v recovered against `address`. */
export async function toEthSignature(digest: Hex, r: bigint, s: bigint, address: Hex): Promise<Signature> {
  const lowS = s > N / 2n ? N - s : s;
  for (const v of [27, 28] as const) {
    const recovered = await recoverAddress({ hash: digest, signature: { r: hexOf(r), s: hexOf(lowS), v: BigInt(v) } });
    if (recovered.toLowerCase() === address.toLowerCase()) return { r: hexOf(r), s: hexOf(lowS), v };
  }
  throw new Error('signature does not recover to the key address');
}

/** The two KMS calls the signer needs; a real KMS client or a test double. */
export interface KmsBackend {
  sign(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
  getPublicKey(keyId: string): Promise<Uint8Array>;
}

export class AwsKmsBackend implements KmsBackend {
  constructor(private readonly client: KMSClient) {}
  static fromEnv(region = process.env.AWS_REGION ?? 'ap-southeast-1'): AwsKmsBackend {
    return new AwsKmsBackend(new KMSClient({ region }));
  }
  async sign(keyId: string, digest: Uint8Array): Promise<Uint8Array> {
    // MessageType DIGEST: KMS signs the 32-byte hash as given and skips its own hashing.
    // https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html
    const out = await this.client.send(new SignCommand({ KeyId: keyId, Message: digest, MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' }));
    if (!out.Signature) throw new Error('KMS returned no signature');
    return out.Signature;
  }
  async getPublicKey(keyId: string): Promise<Uint8Array> {
    const out = await this.client.send(new GetPublicKeyCommand({ KeyId: keyId }));
    if (!out.PublicKey) throw new Error('KMS returned no public key');
    return out.PublicKey;
  }
}

/** Agent key held in KMS. The private key never leaves KMS; the address is derived from its public key. */
export class KmsDigestSigner implements DigestSigner {
  private constructor(
    private readonly backend: KmsBackend,
    readonly keyId: string,
    readonly address: Hex,
  ) {}

  /** Loads the public key once (cached) so each signature is a single KMS round trip. */
  static async load(backend: KmsBackend, keyId: string): Promise<KmsDigestSigner> {
    return new KmsDigestSigner(backend, keyId, addressFromSpki(await backend.getPublicKey(keyId)));
  }

  async signDigest(digest: Hex): Promise<Signature> {
    const der = await this.backend.sign(this.keyId, hexToBytes(digest.slice(2)));
    const { r, s } = parseDerSignature(der);
    return toEthSignature(digest, r, s, this.address);
  }
}

/**
 * Creates one non-exportable secp256k1 signing key per user, tagged for the IAM conditions in the B0
 * report (`aws:RequestTag/app = bulwark`). Requires the provisioner role, which cannot sign.
 */
export async function createGuardKey(client: KMSClient, args: { user: Hex; env: string }): Promise<{ keyId: string; address: Hex }> {
  const out = await client.send(
    new CreateKeyCommand({
      KeySpec: 'ECC_SECG_P256K1',
      KeyUsage: 'SIGN_VERIFY',
      Origin: 'AWS_KMS',
      MultiRegion: false,
      Description: `Bulwark guard agent key for ${args.user}`,
      Tags: [
        { TagKey: 'app', TagValue: 'bulwark' },
        { TagKey: 'user', TagValue: args.user.toLowerCase() },
        { TagKey: 'env', TagValue: args.env },
      ],
    }),
  );
  const keyId = out.KeyMetadata?.KeyId;
  if (!keyId) throw new Error('KMS did not return a key id');
  const pk = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!pk.PublicKey) throw new Error('KMS returned no public key');
  return { keyId, address: addressFromSpki(pk.PublicKey) };
}

/** Retires a user's key: disabled now, deleted after the minimum 7-day window. */
export async function retireGuardKey(client: KMSClient, keyId: string): Promise<void> {
  await client.send(new DisableKeyCommand({ KeyId: keyId }));
  await client.send(new ScheduleKeyDeletionCommand({ KeyId: keyId, PendingWindowInDays: 7 }));
}

export { pad32 };
