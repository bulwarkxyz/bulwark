import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { toEthSignature, type DigestSigner, type Hex, type Signature } from './index.js';

/**
 * Encrypted-at-rest agent keys (the testnet signer while KMS is unavailable).
 *
 * One secp256k1 agent key per user, generated on the signing service and stored only as an
 * AES-256-GCM blob under a master key that exists solely as a secret on that service. The blob is
 * bound to the account and network (additional authenticated data), so it cannot be moved to
 * another user. The private key is decrypted only for the duration of one signature and the buffer
 * is zeroed afterwards. Nothing here returns key material to a caller.
 *
 * What this does not give: hardware isolation. Whoever controls the signing service and its master
 * key can sign with these keys, which on Hyperliquid means trading, never withdrawing.
 */

export const SEALED_FORMAT = 'bwk1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface MasterKeys {
  /** Id of the key new blobs are sealed under. */
  activeId: string;
  keys: ReadonlyMap<string, Uint8Array>;
}

/**
 * Parses `SIGNER_MASTER_KEYS`: comma-separated `id:base64` entries, active key first.
 * Rotation: put the new key first and keep the old one until every blob has been resealed.
 */
export function parseMasterKeys(raw: string | undefined): MasterKeys {
  if (!raw?.trim()) throw new Error('SIGNER_MASTER_KEYS is not set');
  const keys = new Map<string, Uint8Array>();
  let activeId = '';
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    const id = part.slice(0, i);
    if (i < 1 || !/^[a-z0-9-]{1,16}$/.test(id)) throw new Error('master key ids must be 1-16 of [a-z0-9-]');
    const key = new Uint8Array(Buffer.from(part.slice(i + 1), 'base64'));
    if (key.length !== KEY_BYTES) throw new Error(`master key ${id} must be 32 bytes`);
    if (keys.has(id)) throw new Error(`duplicate master key id ${id}`);
    keys.set(id, key);
    if (!activeId) activeId = id;
  }
  return { activeId, keys };
}

const aad = (account: string, network: string, mk: string) => Buffer.from(`bulwark/agent-key/v1|${network}|${account.toLowerCase()}|${mk}`, 'utf8');

export function addressOf(privateKey: Uint8Array): Hex {
  const pub = secp256k1.getPublicKey(privateKey, false);
  return `0x${bytesToHex(keccak_256(pub.slice(1)).slice(12))}` as Hex;
}

/** Seals a 32-byte private key for one account on one network under the active master key. */
export function sealAgentKey(master: MasterKeys, account: string, network: string, privateKey: Uint8Array): string {
  if (privateKey.length !== KEY_BYTES) throw new Error('agent key must be 32 bytes');
  const key = master.keys.get(master.activeId)!;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(account, network, master.activeId));
  const ct = Buffer.concat([cipher.update(privateKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SEALED_FORMAT, master.activeId, iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.');
}

export function sealedMasterId(blob: string): string {
  const parts = blob.split('.');
  if (parts.length !== 5 || parts[0] !== SEALED_FORMAT) throw new Error('not a sealed agent key');
  return parts[1]!;
}

/** Decrypts into a fresh buffer the caller must zero. Throws on any tampering or wrong binding. */
function unseal(master: MasterKeys, account: string, network: string, blob: string): Uint8Array {
  const [, mk, iv, ct, tag] = blob.split('.') as [string, string, string, string, string];
  const key = master.keys.get(sealedMasterId(blob));
  if (!key) throw new Error(`no master key ${mk} on this service`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(aad(account, network, mk));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const out = Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
  const k = new Uint8Array(out);
  out.fill(0);
  return k;
}

/**
 * Runs `fn` with the decrypted key and zeroes the buffer afterwards, whatever happens.
 * Also checks the key still derives to the expected address, so a swapped blob is refused.
 */
export async function withAgentKey<T>(master: MasterKeys, account: string, network: string, blob: string, expectAddress: Hex, fn: (key: Uint8Array) => T | Promise<T>): Promise<T> {
  const key = unseal(master, account, network, blob);
  try {
    if (addressOf(key).toLowerCase() !== expectAddress.toLowerCase()) throw new Error('sealed key does not match its recorded address');
    return await fn(key);
  } finally {
    key.fill(0);
  }
}

/** A new random agent key, sealed. Only the sealed blob and the address leave this function. */
export function createSealedAgentKey(master: MasterKeys, account: string, network: string): { address: Hex; sealed: string; masterKeyId: string } {
  const key = secp256k1.utils.randomSecretKey();
  try {
    return { address: addressOf(key), sealed: sealAgentKey(master, account, network, key), masterKeyId: master.activeId };
  } finally {
    key.fill(0);
  }
}

/** Re-encrypts a blob under the active master key (master-key rotation). Returns null if already current. */
export function resealAgentKey(master: MasterKeys, account: string, network: string, blob: string): string | null {
  if (sealedMasterId(blob) === master.activeId) return null;
  const key = unseal(master, account, network, blob);
  try {
    return sealAgentKey(master, account, network, key);
  } finally {
    key.fill(0);
  }
}

/** Digest signer over a sealed key: decrypt, sign, zero, for every signature. */
export class SealedDigestSigner implements DigestSigner {
  constructor(
    private readonly master: MasterKeys,
    private readonly account: string,
    private readonly network: string,
    private readonly blob: string,
    readonly address: Hex,
  ) {}

  async signDigest(digest: Hex): Promise<Signature> {
    const compact = await withAgentKey(this.master, this.account, this.network, this.blob, this.address, (key) =>
      // The digest is already the EIP-712 hash: no pre-hashing. Low-s, deterministic (RFC 6979).
      secp256k1.sign(hexToBytes(digest.slice(2)), key, { prehash: false, lowS: true, format: 'compact' }),
    );
    const r = BigInt(`0x${bytesToHex(compact.slice(0, 32))}`);
    const s = BigInt(`0x${bytesToHex(compact.slice(32, 64))}`);
    // Same recovery check as the KMS path: refuse unless the signature recovers to the key's address.
    return toEthSignature(digest, r, s, this.address);
  }
}
