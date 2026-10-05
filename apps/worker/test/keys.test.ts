import { randomBytes } from 'node:crypto';
import { SealedDigestSigner, parseMasterKeys } from '@bulwarkxyz/signer';
import { MemoryStore } from '@bulwarkxyz/store';
import { keccak256, recoverAddress, toHex, type Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { KeyService, SEALED_PREFIX } from '../src/keys.js';

const ACCOUNT = '0x9959260f1aa229f8a70e0c495ca9b251106c1a86';
const master = parseMasterKeys(`m1:${randomBytes(32).toString('base64')}`);
let now = 1_791_150_000_000;
let store: MemoryStore;
let approved: string[];
let dropped: string[];
const service = (m = master) => new KeyService({ vault: store, store, master: m, network: 'testnet', approvedAgents: async () => approved, onKeyChanged: (a) => dropped.push(a), now: () => now });

beforeEach(() => {
  store = new MemoryStore();
  store.putUser({ account: ACCOUNT as Hex, agentKeyRef: 'pending', agentAddress: null, region: 'allowed', telegramChatId: null, killSwitch: false, builderApproved: false });
  approved = [];
  dropped = [];
});

async function signWithStored(account: string): Promise<{ address: string; recovered: string }> {
  const u = (await store.user(account))!;
  const address = u.agentKeyRef.slice(SEALED_PREFIX.length) as Hex;
  const k = (await store.sealedKey(account, 'testnet', address))!;
  const d = keccak256(toHex('order'));
  const sig = await new SealedDigestSigner(master, account, 'testnet', k.sealed, address).signDigest(d);
  return { address, recovered: (await recoverAddress({ hash: d, signature: { r: sig.r, s: sig.s, v: BigInt(sig.v) } })).toLowerCase() };
}

describe('key service', () => {
  it('creates one sealed key per user on request; the user record points at it; requests are idempotent', async () => {
    expect(await store.requestAgentKey(ACCOUNT, 'testnet', 'create', now)).toMatchObject({ created: true });
    expect(await store.requestAgentKey(ACCOUNT, 'testnet', 'create', now)).toMatchObject({ created: false });
    expect(await service().processRequests()).toBe(1);
    const u = (await store.user(ACCOUNT))!;
    expect(u.agentKeyRef.startsWith(SEALED_PREFIX)).toBe(true);
    const { address, recovered } = await signWithStored(ACCOUNT);
    expect(recovered).toBe(address);
    expect(u.agentAddress).toBe(address);
    // a second create request does not make a second key
    await store.requestAgentKey(ACCOUNT, 'testnet', 'create', now);
    await service().processRequests();
    expect(await store.agentKeys(ACCOUNT, 'testnet')).toHaveLength(1);
    expect(store.audit.raw(ACCOUNT).at(-1)).toMatchObject({ kind: 'key' });
    expect(JSON.stringify(store.audit.raw(ACCOUNT))).not.toContain((await store.sealedKey(ACCOUNT, 'testnet', address))!.sealed);
  });

  it('answers with an error, and creates nothing, when the master key is not on this service', async () => {
    await store.requestAgentKey(ACCOUNT, 'testnet', 'create', now);
    await service(null as never).processRequests();
    expect(await store.agentKeys(ACCOUNT, 'testnet')).toHaveLength(0);
    expect((await store.user(ACCOUNT))!.agentKeyRef).toBe('pending');
  });

  it('rotation: the new key waits until the user approves it on Hyperliquid, then the old key is wiped', async () => {
    await store.requestAgentKey(ACCOUNT, 'testnet', 'create', now);
    await service().processRequests();
    const first = (await store.user(ACCOUNT))!.agentAddress!;
    now += 1000;
    await store.requestAgentKey(ACCOUNT, 'testnet', 'rotate', now);
    await service().processRequests();
    const next = (await store.agentKeys(ACCOUNT, 'testnet')).find((k) => k.status === 'pending')!;
    expect((await store.user(ACCOUNT))!.agentAddress).toBe(first); // still signing with the approved key
    expect(await service().promoteRotations([ACCOUNT])).toBe(0);
    approved = [next.address];
    expect(await service().promoteRotations([ACCOUNT])).toBe(1);
    expect((await store.user(ACCOUNT))!.agentAddress).toBe(next.address);
    expect(await store.sealedKey(ACCOUNT, 'testnet', first)).toBeNull();
    const statuses = Object.fromEntries((await store.agentKeys(ACCOUNT, 'testnet')).map((k) => [k.address, k.status]));
    expect(statuses).toEqual({ [first]: 'wiped', [next.address]: 'active' });
    expect(dropped).toContain(ACCOUNT);
  });

  it('master-key rotation: reseals every live blob under the new key; signatures are unchanged', async () => {
    await store.requestAgentKey(ACCOUNT, 'testnet', 'create', now);
    await service().processRequests();
    const before = await signWithStored(ACCOUNT);
    const rotated = parseMasterKeys(`m2:${randomBytes(32).toString('base64')},m1:${Buffer.from(master.keys.get('m1')!).toString('base64')}`);
    expect(await service(rotated).resealAll()).toBe(1);
    expect(await service(rotated).resealAll()).toBe(0);
    const k = (await store.sealedKey(ACCOUNT, 'testnet', before.address))!;
    expect(k.masterKeyId).toBe('m2');
    const onlyNew = parseMasterKeys(`m2:${Buffer.from(rotated.keys.get('m2')!).toString('base64')}`);
    const d = keccak256(toHex('order'));
    const sig = await new SealedDigestSigner(onlyNew, ACCOUNT, 'testnet', k.sealed, before.address as Hex).signDigest(d);
    expect((await recoverAddress({ hash: d, signature: { r: sig.r, s: sig.s, v: BigInt(sig.v) } })).toLowerCase()).toBe(before.address);
  });

  it('wipe destroys the stored key; nothing can sign for the account afterwards', async () => {
    await store.requestAgentKey(ACCOUNT, 'testnet', 'create', now);
    await service().processRequests();
    const address = (await store.user(ACCOUNT))!.agentAddress!;
    expect(await service().wipe(ACCOUNT, 'test')).toBe(1);
    expect(await store.sealedKey(ACCOUNT, 'testnet', address)).toBeNull();
    expect((await store.user(ACCOUNT))!.agentKeyRef).toBe('wiped');
    expect((await store.agentKeys(ACCOUNT, 'testnet'))[0]).toMatchObject({ status: 'wiped' });
    expect(store.audit.raw(ACCOUNT).at(-1)).toMatchObject({ kind: 'key', what: expect.stringContaining('wiped') });
  });
});
