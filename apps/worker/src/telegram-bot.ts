import type { GuardStore } from './store.js';

/**
 * Long-polling Telegram bot (no Mini App). It does two things: `/start` explains how to link, and
 * `/link <code>` links this chat to the account that generated the one-time code in the app.
 * https://core.telegram.org/bots/api#getupdates
 */
export class TelegramBot {
  private offset = 0;
  private running = false;

  constructor(
    private readonly token: string,
    private readonly store: Pick<GuardStore, 'redeemTelegramCode'>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private api(method: string, body: unknown) {
    return this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
  }

  private reply(chatId: number | string, text: string) {
    return this.api('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
  }

  /** Handles one batch of updates; exposed for tests. */
  async handle(updates: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }>): Promise<void> {
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      const msg = u.message;
      if (!msg?.text) continue;
      const [cmd, arg] = msg.text.trim().split(/\s+/, 2);
      if (cmd === '/start') {
        await this.reply(msg.chat.id, 'Bulwark sends your guard alerts here. In the app, open Settings › Alerts › Link Telegram, then send /link followed by the code it shows.');
      } else if (cmd === '/link') {
        const account = arg ? await this.store.redeemTelegramCode(arg, String(msg.chat.id), this.now()) : null;
        await this.reply(
          msg.chat.id,
          account ? `Linked to ${account.slice(0, 6)}…${account.slice(-4)}. You will get an alert here whenever the guard acts or is near one of your lines.` : 'That code is not valid or has expired. Create a new one in Settings › Alerts.',
        );
      }
    }
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        const res = await this.api('getUpdates', { offset: this.offset, timeout: 30, allowed_updates: ['message'] });
        const body = (await res.json()) as { ok: boolean; result: Parameters<TelegramBot['handle']>[0] };
        if (body.ok) await this.handle(body.result);
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  stop() {
    this.running = false;
  }
}
