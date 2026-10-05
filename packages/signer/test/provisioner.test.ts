import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CreateKeyCommand, GetPublicKeyCommand, SignCommand, TagResourceCommand, UntagResourceCommand } from '@aws-sdk/client-kms';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import { ProvisionerKms, createGuardKey, retireGuardKey } from '../src/index.js';

/** Records every command that would have reached AWS. */
function recorder() {
  const sent: object[] = [];
  const pub = secp256k1.getPublicKey(new Uint8Array(32).fill(7), false);
  const spki = new Uint8Array([...Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'), ...pub]);
  return {
    sent,
    async send(command: object) {
      sent.push(command);
      if (command instanceof CreateKeyCommand) return { KeyMetadata: { KeyId: 'new-key' } };
      if (command instanceof GetPublicKeyCommand) return { PublicKey: spki };
      return {};
    },
  };
}

describe('provisioner KMS guard: tags only ever land on the key created in the same request', () => {
  it('creating a guard key sends one tagged CreateKey and one GetPublicKey, and nothing else', async () => {
    const aws = recorder();
    await createGuardKey(new ProvisionerKms(aws), { user: '0x00000000000000000000000000000000000000aa', env: 'testnet' });
    expect(aws.sent.map((c) => c.constructor.name)).toEqual(['CreateKeyCommand', 'GetPublicKeyCommand']);
    const tags = (aws.sent[0] as CreateKeyCommand).input.Tags;
    expect(tags).toContainEqual({ TagKey: 'app', TagValue: 'bulwark' });
  });

  it('refuses TagResource and UntagResource on any existing key before it reaches AWS', async () => {
    const aws = recorder();
    const kms = new ProvisionerKms(aws);
    const attempts = [
      new TagResourceCommand({ KeyId: 'existing-key', Tags: [{ TagKey: 'app', TagValue: 'bulwark' }] }),
      new UntagResourceCommand({ KeyId: 'existing-key', TagKeys: ['app'] }),
      new SignCommand({ KeyId: 'existing-key', Message: new Uint8Array(32), MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' }),
    ];
    for (const c of attempts) await expect(kms.send(c as never)).rejects.toThrow(/may not send/);
    expect(aws.sent).toHaveLength(0);
  });

  it('refuses a CreateKey without the app=bulwark tag (keeps the signer scoped to Bulwark keys)', async () => {
    const aws = recorder();
    await expect(new ProvisionerKms(aws).send(new CreateKeyCommand({ KeySpec: 'ECC_SECG_P256K1', KeyUsage: 'SIGN_VERIFY' }))).rejects.toThrow(/app=bulwark/);
    await expect(new ProvisionerKms(aws).send(new CreateKeyCommand({ KeySpec: 'ECC_SECG_P256K1', KeyUsage: 'SIGN_VERIFY', Tags: [{ TagKey: 'app', TagValue: 'other' }] }))).rejects.toThrow(/app=bulwark/);
    expect(aws.sent).toHaveLength(0);
  });

  it('retiring a key disables and schedules deletion only', async () => {
    const aws = recorder();
    await retireGuardKey(new ProvisionerKms(aws), 'some-key');
    expect(aws.sent.map((c) => c.constructor.name)).toEqual(['DisableKeyCommand', 'ScheduleKeyDeletionCommand']);
  });

  it('no source file anywhere references a tag-changing KMS command, and the api only reaches KMS through the guard', () => {
    const root = join(import.meta.dirname, '../../..');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        if (['node_modules', 'dist', '.next', 'test'].includes(f)) continue;
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|js)$/.test(f)) files.push(p);
      }
    };
    for (const top of ['packages', 'apps']) walk(join(root, top));
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((f) => /TagResource|UntagResource/.test(readFileSync(f, 'utf8').replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')));
    expect(offenders).toEqual([]);
    const api = readFileSync(join(root, 'apps/api/src/main.ts'), 'utf8');
    expect(api).toMatch(/new ProvisionerKms\(new KMSClient\(/);
    expect(api.match(/new KMSClient\(/g)).toHaveLength(1);
  });
});
