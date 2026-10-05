import { randomBytes } from 'node:crypto';
import { keccak256, recoverAddress, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { LocalDigestSigner, SealedDigestSigner, addressOf, createSealedAgentKey, parseMasterKeys, resealAgentKey, sealAgentKey, sealedMasterId, withAgentKey, type Hex } from '../src/index.js';

const b64 = (n = 32) => randomBytes(n).toString('base64');
const master = parseMasterKeys(`v1:${b64()}`);
const ACCOUNT = '0x9959260f1aa229f8a70e0c495ca9b251106c1a86';
const digest = (s: string) => keccak256(toHex(s)) as Hex;

describe('master keys', () => {
  it('takes the first entry as active and validates every key', () => {
    const m = parseMasterKeys(`v2:${b64()}, v1:${b64()}`);
    expect(m.activeId).toBe('v2');
    expect(m.keys.size).toBe(2);
    expect(() => parseMasterKeys(undefined)).toThrow(/not set/);
    expect(() => parseMasterKeys(`v1:${b64(16)}`)).toThrow(/32 bytes/);
    expect(() => parseMasterKeys(`v1:${b64()},v1:${b64()}`)).toThrow(/duplicate/);
    expect(() => parseMasterKeys(`V 1:${b64()}`)).toThrow(/ids/);
  });
});

describe('sealed agent keys', () => {
  it('signs exactly like a plain key, low-s, and every signature recovers to the address', async () => {
    const key = new Uint8Array(randomBytes(32));
    const local = new LocalDigestSigner(toHex(key));
    const blob = sealAgentKey(master, ACCOUNT, 'testnet', key);
    const sealed = new SealedDigestSigner(master, ACCOUNT, 'testnet', blob, addressOf(key));
    expect(sealed.address).toBe(local.address);
    for (const d of [digest('a'), digest('b'), digest('order')]) {
      const s = await sealed.signDigest(d);
      expect(s).toEqual(await local.signDigest(d)); // RFC 6979: identical r, s, v
      expect(BigInt(s.s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true);
      expect((await recoverAddress({ hash: d, signature: { r: s.r, s: s.s, v: BigInt(s.v) } })).toLowerCase()).toBe(local.address);
    }
  });

  it('never returns the key: creation hands back only the address and the blob', () => {
    const k = createSealedAgentKey(master, ACCOUNT, 'testnet');
    expect(Object.keys(k).sort()).toEqual(['address', 'masterKeyId', 'sealed']);
    expect(k.sealed.startsWith('bwk1.v1.')).toBe(true);
    expect(k.address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('refuses a blob that was tampered with, moved to another account or network, or swapped', async () => {
    const k = createSealedAgentKey(master, ACCOUNT, 'testnet');
    const parts = k.sealed.split('.');
    const flip = (i: number) => {
      const p = [...parts];
      const buf = Buffer.from(p[i]!, 'base64url');
      buf[0] = buf[0]! ^ 1;
      p[i] = buf.toString('base64url');
      return p.join('.');
    };
    const use = (blob: string, account = ACCOUNT, network = 'testnet', address = k.address) => withAgentKey(master, account, network, blob, address, () => 'used');
    await expect(use(k.sealed)).resolves.toBe('used');
    for (const i of [2, 3, 4]) await expect(use(flip(i))).rejects.toThrow(); // iv, ciphertext, tag
    await expect(use(k.sealed, '0x0000000000000000000000000000000000000001')).rejects.toThrow();
    await expect(use(k.sealed, ACCOUNT, 'mainnet')).rejects.toThrow();
    const other = createSealedAgentKey(master, ACCOUNT, 'testnet');
    await expect(use(other.sealed, ACCOUNT, 'testnet', k.address)).rejects.toThrow(/does not match/);
  });

  it('needs the master key it was sealed under', async () => {
    const k = createSealedAgentKey(master, ACCOUNT, 'testnet');
    const stranger = parseMasterKeys(`v1:${b64()}`);
    await expect(withAgentKey(stranger, ACCOUNT, 'testnet', k.sealed, k.address, () => 1)).rejects.toThrow();
    const missing = parseMasterKeys(`v9:${b64()}`);
    await expect(withAgentKey(missing, ACCOUNT, 'testnet', k.sealed, k.address, () => 1)).rejects.toThrow(/no master key v1/);
  });

  it('zeroes the decrypted key after use, also when the work throws', async () => {
    const k = createSealedAgentKey(master, ACCOUNT, 'testnet');
    let seen: Uint8Array | null = null;
    await withAgentKey(master, ACCOUNT, 'testnet', k.sealed, k.address, (key) => {
      seen = key;
      expect(key.some((b) => b !== 0)).toBe(true);
    });
    expect(seen!.every((b) => b === 0)).toBe(true);
    let seen2: Uint8Array | null = null;
    await expect(
      withAgentKey(master, ACCOUNT, 'testnet', k.sealed, k.address, (key) => {
        seen2 = key;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(seen2!.every((b) => b === 0)).toBe(true);
  });

  it('master-key rotation: reseals under the new key, keeps the same agent key, then the old key can go', async () => {
    const old = parseMasterKeys(`v1:${b64()}`);
    const k = createSealedAgentKey(old, ACCOUNT, 'testnet');
    const both = parseMasterKeys(`v2:${b64()},v1:${Buffer.from(old.keys.get('v1')!).toString('base64')}`);
    const resealed = resealAgentKey(both, ACCOUNT, 'testnet', k.sealed)!;
    expect(sealedMasterId(resealed)).toBe('v2');
    expect(resealAgentKey(both, ACCOUNT, 'testnet', resealed)).toBeNull();
    const onlyNew = parseMasterKeys(`v2:${Buffer.from(both.keys.get('v2')!).toString('base64')}`);
    const s = new SealedDigestSigner(onlyNew, ACCOUNT, 'testnet', resealed, k.address);
    const d = digest('after rotation');
    const sig = await s.signDigest(d);
    expect((await recoverAddress({ hash: d, signature: { r: sig.r, s: sig.s, v: BigInt(sig.v) } })).toLowerCase()).toBe(k.address);
  });
});
