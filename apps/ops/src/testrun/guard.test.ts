import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { generatePrivateKey } from 'viem/accounts';
import { BRIDGE, LIMIT_USDC, Ledger, Refused, WALLET, checkDestination, confirm, loadWallet } from './guard.js';

const tmp = () => pathToFileURL(join(mkdtempSync(join(tmpdir(), 'testrun-')), 'ledger.json'));

test('refuses any key that is not the test wallet\'s, and a missing or malformed key', () => {
  assert.throws(() => loadWallet(() => generatePrivateKey()), (e) => e instanceof Refused && /not the test wallet/.test(e.message));
  assert.throws(() => loadWallet(() => 'not a key'), Refused);
  assert.throws(() => loadWallet(() => { throw new Error('item not found'); }), (e) => e instanceof Refused && /not in this Mac's Keychain/.test(e.message));
});

test('never lets real money above the 13 USDC limit, across parts', () => {
  const l = new Ledger(tmp());
  assert.equal(l.remaining(), LIMIT_USDC);
  l.check(13);
  assert.throws(() => l.check(13.01), Refused);
  assert.throws(() => l.check(0), Refused);
  l.add('bridge deposit', 13, '0xabc');
  assert.equal(l.remaining(), 0);
  assert.throws(() => l.check(0.01), (e) => e instanceof Refused && /above what is left/.test(e.message));
});

test('sends only to the bridge (deposits) or the wallet itself', () => {
  checkDestination('deposit', BRIDGE);
  checkDestination('self', WALLET);
  assert.throws(() => checkDestination('deposit', WALLET), Refused);
  assert.throws(() => checkDestination('self', '0x000000000000000000000000000000000000dEaD'), Refused);
});

test('acts only on an exact "yes" typed at a terminal; never from a pipe', async () => {
  const ask = async (answer: string, isTTY = true) => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const p = confirm({ what: 'x', amount: '1 USDC', limit: '13 USDC' }, { input, output, isTTY });
    input.write(`${answer}\n`);
    return p;
  };
  assert.equal(await ask('yes'), true);
  assert.equal(await ask('y'), false);
  assert.equal(await ask('YES please'), false);
  await assert.rejects(ask('yes', false), Refused);
});
