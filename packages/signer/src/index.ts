import {
  CreateKeyCommand,
  DescribeKeyCommand,
  DisableKeyCommand,
  GetPublicKeyCommand,
  KMSClient,
  ScheduleKeyDeletionCommand,
  SignCommand,
  type CreateKeyCommandOutput,
  type GetPublicKeyCommandOutput,
} from '@aws-sdk/client-kms';
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

/** Commands the provisioner may send. TagResource and UntagResource are deliberately absent. */
const PROVISIONER_COMMANDS = [CreateKeyCommand, GetPublicKeyCommand, DescribeKeyCommand, DisableKeyCommand, ScheduleKeyDeletionCommand] as const;

/**
 * The api service's only handle on KMS. The provisioner's IAM policy allows kms:TagResource in the
 * region (KMS does not see request tags when it checks TagResource during CreateKey), so this guard
 * narrows it on our side: tags travel only inside CreateKey, so they can only ever land on the key
 * created by that same request. Any other command, including TagResource and UntagResource on an
 * existing key, is refused before it reaches AWS. CreateKey must carry the app=bulwark tag, which keeps
 * the signer's access limited to Bulwark keys.
 */
export class ProvisionerKms {
  constructor(private readonly inner: { send(command: never): Promise<unknown> }) {}
  send(command: CreateKeyCommand): Promise<CreateKeyCommandOutput>;
  send(command: GetPublicKeyCommand): Promise<GetPublicKeyCommandOutput>;
  send(command: DescribeKeyCommand | DisableKeyCommand | ScheduleKeyDeletionCommand): Promise<unknown>;
  async send(command: object): Promise<unknown> {
    if (!PROVISIONER_COMMANDS.some((C) => command instanceof C)) throw new Error(`provisioner may not send ${command.constructor.name}`);
    if (command instanceof CreateKeyCommand) {
      const tags = command.input.Tags ?? [];
      if (!tags.some((t) => t.TagKey === 'app' && t.TagValue === 'bulwark')) throw new Error('CreateKey must carry the app=bulwark tag');
    }
    return this.inner.send(command as never);
  }
}

/**
 * Creates one non-exportable secp256k1 signing key per user, tagged in the same request
 * (`app=bulwark`, `user`, `env`). Requires the provisioner, which cannot sign.
 */
export async function createGuardKey(kms: ProvisionerKms, args: { user: Hex; env: string }): Promise<{ keyId: string; address: Hex }> {
  const out = await kms.send(
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
  const pk = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!pk.PublicKey) throw new Error('KMS returned no public key');
  return { keyId, address: addressFromSpki(pk.PublicKey) };
}

/** Retires a user's key: disabled now, deleted after the minimum 7-day window. */
export async function retireGuardKey(kms: ProvisionerKms, keyId: string): Promise<void> {
  await kms.send(new DisableKeyCommand({ KeyId: keyId }));
  await kms.send(new ScheduleKeyDeletionCommand({ KeyId: keyId, PendingWindowInDays: 7 }));
}

export { pad32 };
export * from './sealed.js';
