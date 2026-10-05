import { describe, expect, it } from 'vitest';
import { ExchangeClient, InfoClient, NonceManager, parseExchangeResponse } from '../src/clients.js';

// Response shapes from https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
describe('exchange responses', () => {
  it('parses resting, filled and per-order errors', () => {
    const r = parseExchangeResponse({
      status: 'ok',
      response: { type: 'order', data: { statuses: [{ resting: { oid: 77738308 } }, { filled: { totalSz: '0.02', avgPx: '1891.4', oid: 77747314 } }, { error: 'Order must have minimum value of $10.' }] } },
    });
    expect(r.ok).toBe(false);
    expect(r.statuses).toEqual([
      { kind: 'resting', oid: 77738308 },
      { kind: 'filled', oid: 77747314, totalSz: '0.02', avgPx: '1891.4' },
      { kind: 'error', error: 'Order must have minimum value of $10.' },
    ]);
    expect(r.error).toBe('Order must have minimum value of $10.');
  });
  it('parses cancel successes and whole-request errors', () => {
    expect(parseExchangeResponse({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } })).toMatchObject({ ok: true, statuses: [{ kind: 'success' }] });
    expect(parseExchangeResponse({ status: 'err', response: 'Builder fee has not been approved.' })).toMatchObject({ ok: false, error: 'Builder fee has not been approved.' });
    expect(parseExchangeResponse({ status: 'ok', response: { type: 'default' } })).toMatchObject({ ok: true, statuses: [] });
  });
  it('parses a twap start', () => {
    expect(parseExchangeResponse({ status: 'ok', response: { type: 'twapOrder', data: { status: { running: { twapId: 77738308 } } } } }).ok).toBe(true);
  });
});

describe('clients', () => {
  it('posts signed requests to the network’s exchange endpoint', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fake = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ status: 'ok', response: { type: 'default' } }), { status: 200 });
    }) as unknown as typeof fetch;
    await new ExchangeClient('testnet', fake).send({ action: { type: 'claimRewards' }, nonce: 1, signature: { r: '0x1', s: '0x2', v: 27 } });
    expect(calls[0]?.url).toBe('https://api.hyperliquid-testnet.xyz/exchange');
    expect(calls[0]?.body).toEqual({ action: { type: 'claimRewards' }, nonce: 1, signature: { r: '0x1', s: '0x2', v: 27 } });
    await new InfoClient('mainnet', fake).userRole('0xabc');
    expect(calls[1]?.url).toBe('https://api.hyperliquid.xyz/info');
  });
});

describe('nonces', () => {
  it('are strictly increasing per signer even within one millisecond', () => {
    const n = new NonceManager(() => 1000);
    expect([n.next('0xA'), n.next('0xa'), n.next('0xb')]).toEqual([1000, 1001, 1000]);
  });
});
