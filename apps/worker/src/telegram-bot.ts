import type { GuardStore } from '@bulwarkxyz/store';

/** Where the kill switch is signed. Telegram can point there but can never stop the guard by itself. */
export const KILL_SWITCH_URL = 'https://bulwark.0xo.in/app/settings#kill-switch';
const SETTINGS_URL = 'https://bulwark.0xo.in/app/settings#alerts';

/** The command menu Telegram shows (setMyCommands). */
export const BOT_COMMANDS = [
  { command: 'link', description: 'Link this chat with the code from Bulwark Settings' },
  { command: 'stop', description: 'Stop the guard: opens the kill switch to sign in the app' },
  { command: 'unlink', description: 'Stop alerts here and forget this chat' },
  { command: 'help', description: 'What this bot does' },
] as const;

export const BOT_SHORT_DESCRIPTION = 'Alerts from your Bulwark margin guard on Hyperliquid. It can never trade or withdraw.';
export const BOT_DESCRIPTION =
  'Bulwark sends your guard alerts here: when it acts on your rules, when it holds off on stale data, and when something needs your choice.\n\n' +
  'To link: in the app, Settings › Alerts › Get a link code, then tap the link or send /link and the code.\n\n' +
  'This bot only sends messages. It cannot trade, withdraw or stop your guard: stopping it is signed by your wallet in the app.';

const HELP = [
  'Bulwark sends your guard alerts here.',
  '',
  '/link CODE: link this chat (get the code in the app: Settings › Alerts).',
  '/stop: stop the guard. You sign the stop in the app with your wallet; this chat cannot stop it by itself.',
  '/unlink: stop alerts here and forget this chat.',
  '',
  'This bot never asks for a private key or seed phrase.',
].join('\n');

/**
 * Long-polling Telegram bot (no Mini App).
 * - `/start` explains how to link; `/start CODE` (the t.me deep link the app shows) and `/link CODE` link this chat
 *   to the account that generated the one-time code.
 * - `/stop` (also `/disarm`) answers with a link to the kill switch: the stop is a command signed by the user's wallet,
 *   so access to this chat is never enough to turn protection off.
 * - `/unlink` forgets this chat on every account linked to it; it only stops messages.
 * https://core.telegram.org/bots/api#getupdates
 */
export class TelegramBot {
  private offset = 0;
  private running = false;

  constructor(
    private readonly token: string,
    private readonly store: Pick<GuardStore, 'redeemTelegramCode' | 'unlinkTelegramChat'>,
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

  /** The bot's command menu and descriptions, kept in code so a new token is set up the same way. */
  async configure(): Promise<void> {
    await this.api('setMyCommands', { commands: BOT_COMMANDS });
    await this.api('setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION });
    await this.api('setMyDescription', { description: BOT_DESCRIPTION });
  }

  private async link(chatId: number, code: string | undefined) {
    const account = code ? await this.store.redeemTelegramCode(code.toUpperCase(), String(chatId), this.now()) : null;
    await this.reply(
      chatId,
      account
        ? `Linked to ${account.slice(0, 6)}…${account.slice(-4)}. You will get an alert here whenever the guard acts or is near one of your lines. /stop opens the kill switch; /unlink stops these messages.`
        : `That code is not valid or has expired. Create a new one in the app: ${SETTINGS_URL}`,
    );
  }

  /** Handles one batch of updates; exposed for tests. */
  async handle(updates: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }>): Promise<void> {
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      const msg = u.message;
      if (!msg?.text) continue;
      const [raw, arg] = msg.text.trim().split(/\s+/, 2);
      const cmd = (raw ?? '').toLowerCase().replace(/@\w+$/, ''); // "/stop@BulwarkGuardBot" in groups
      if (cmd === '/start' && arg) await this.link(msg.chat.id, arg);
      else if (cmd === '/start')
        await this.reply(msg.chat.id, `Bulwark sends your guard alerts here. In the app, open Settings › Alerts › Get a link code, then tap the link it shows or send /link followed by the code.\n${SETTINGS_URL}`);
      else if (cmd === '/link') await this.link(msg.chat.id, arg);
      else if (cmd === '/stop' || cmd === '/disarm')
        await this.reply(
          msg.chat.id,
          `To stop the guard, open the kill switch and sign the stop with your wallet:\n${KILL_SWITCH_URL}\n\nIt takes effect at once and cancels only the guard's own orders. A message here can't stop it by itself, so nobody with access to this chat can turn your protection off.`,
        );
      else if (cmd === '/unlink') {
        const gone = await this.store.unlinkTelegramChat(String(msg.chat.id));
        await this.reply(msg.chat.id, gone.length ? 'Unlinked. No more alerts will come here. Your guard keeps running; alerts still show in the app if they are on.' : 'This chat is not linked to any account.');
      } else if (cmd === '/help') await this.reply(msg.chat.id, HELP);
    }
  }

  async start(): Promise<void> {
    this.running = true;
    await this.configure().catch(() => undefined);
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
