import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@bulwarkxyz/store';
import { TelegramBot } from '../src/telegram-bot.js';
import { ConsoleNotifier, TelegramNotifier, formatRun } from '../src/notify.js';

const A = '0x9959260f1aa229f8a70e0c495ca9b251106c1a86';

function fakeTelegram() {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const f = (async (url: string, init: { body: string }) => {
    calls.push({ method: url.split('/').at(-1) as string, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: [] }));
  }) as unknown as typeof fetch;
  return { calls, f };
}

describe('telegram', () => {
  it('links a chat with a one-time code, once, before it expires', async () => {
    const store = new MemoryStore();
    store.putUser({ account: A as `0x${string}`, agentKeyRef: 'kms:k', region: 'allowed', telegramChatId: null, killSwitch: false, builderApproved: false });
    store.putTelegramCode('AB12CD', A, 2000);
    const tg = fakeTelegram();
    const bot = new TelegramBot('TOKEN', store, tg.f, () => 1000);
    await bot.handle([{ update_id: 1, message: { chat: { id: 77 }, text: '/link AB12CD' } }]);
    expect((await store.user(A))?.telegramChatId).toBe('77');
    expect(tg.calls.at(-1)?.body.text).toMatch(/Linked to 0x9959…1a86/);
    await bot.handle([{ update_id: 2, message: { chat: { id: 78 }, text: '/link AB12CD' } }]);
    expect((await store.user(A))?.telegramChatId).toBe('77');
    expect(tg.calls.at(-1)?.body.text).toMatch(/not valid or has expired/);
  });

  it('refuses expired codes', async () => {
    const store = new MemoryStore();
    store.putTelegramCode('OLD', A, 500);
    const tg = fakeTelegram();
    await new TelegramBot('T', store, tg.f, () => 1000).handle([{ update_id: 1, message: { chat: { id: 1 }, text: '/link OLD' } }]);
    expect(tg.calls.at(-1)?.body.text).toMatch(/expired/);
  });

  it('sends plain alerts with no link previews', async () => {
    const tg = fakeTelegram();
    await new TelegramNotifier('T', tg.f).send('42', 'hello');
    expect(tg.calls[0]).toEqual({ method: 'sendMessage', body: { chat_id: '42', text: 'hello', disable_web_page_preview: true } });
  });

  it('formats a run with what fired, what was done and what was held back', () => {
    const text = formatRun([
      { action: { type: 'order', ruleId: 's1', reason: 'buffer 1.45× below your 2× line', dex: 'xyz', coin: 'xyz:CL', assetId: 1, isBuy: false, size: 0.12, limitPx: 68.31, reduceOnly: true, tif: 'Ioc', closesPosition: false }, status: 'sent', result: { ok: true, statuses: [{ kind: 'filled', oid: 1, totalSz: '0.12', avgPx: '68.9' }], raw: {} }, builderRetried: false, latencyMs: 90 },
      { action: { type: 'transfer', ruleId: 's1', reason: 'buffer 1.45× below your 2× line', source: 'spot', toDex: 'xyz', amount: 0.23, token: 0 }, status: 'rejected', violation: { invariant: 'I4', message: 'kill switch is on' }, builderRetried: false, latencyMs: 0 },
    ]);
    expect(text).toBe(
      'Bulwark guard: buffer 1.45× below your 2× line\n• Reduced xyz:CL by 0.12 (reduce-only, limit 68.31) — filled 0.12 @ 68.9\n• Held back: Moved 0.23 USDC from spot to xyz (I4: kill switch is on)',
    );
    void ConsoleNotifier;
  });
});
