import type { ExecutionRecord } from '@bulwarkxyz/executor';
import type { GuardAction } from '@bulwarkxyz/guard-core';

/**
 * Alerts. A plain Telegram bot (no Mini App), alerts only, no trade links — Telegram exempts plain
 * bots from its TON-only rule for Mini Apps (https://core.telegram.org/bots/blockchain-guidelines) and
 * its bot terms bar promoting regulated services (https://telegram.org/tos/bot-developers).
 */
export interface Notifier {
  send(chatId: string, text: string): Promise<void>;
}

export class TelegramNotifier implements Notifier {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(chatId: string, text: string): Promise<void> {
    // https://core.telegram.org/bots/api#sendmessage
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`telegram ${res.status}`);
  }
}

export class ConsoleNotifier implements Notifier {
  readonly sent: Array<{ chatId: string; text: string }> = [];
  async send(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }
}

const fmt = (n: number, d = 4) => String(Number(n.toFixed(d)));

function describe(a: GuardAction): string {
  switch (a.type) {
    case 'order':
      return `${a.closesPosition ? 'Closed' : 'Reduced'} ${a.coin} by ${fmt(a.size)} (reduce-only, limit ${fmt(a.limitPx, 6)})`;
    case 'trigger':
      return `Backstop stop for ${a.coin} at ${fmt(a.triggerPx, 6)}`;
    case 'transfer':
      return `Moved ${fmt(a.amount, 2)} USDC from ${a.source === 'spot' ? 'spot' : a.source.replace('dex:', '') || 'main'} to ${a.toDex || 'main'}`;
    case 'isolatedMargin':
      return `Added ${fmt(a.amount, 2)} USDC isolated margin to ${a.coin}`;
    case 'cancel':
      return `Cancelled order ${a.oid} on ${a.coin}`;
    case 'alert':
      return a.reason;
  }
}

/** One message per guard run: what fired, what was done, what failed. */
export function formatRun(records: readonly ExecutionRecord[]): string | null {
  if (records.length === 0) return null;
  const why = [...new Set(records.map((r) => r.action.reason))];
  const lines = records.map((r) => {
    if (r.status === 'alert') return `• ${r.action.reason}`;
    if (r.status === 'sent') {
      const fill = r.result?.statuses.find((s) => s.kind === 'filled') as { totalSz?: string; avgPx?: string } | undefined;
      return `• ${describe(r.action)}${fill ? ` — filled ${fill.totalSz} @ ${fill.avgPx}` : ''}`;
    }
    if (r.status === 'rejected') return `• Held back: ${describe(r.action)} (${r.violation?.invariant}: ${r.violation?.message})`;
    return `• Failed: ${describe(r.action)} — ${r.error ?? 'unknown error'}`;
  });
  return [`Bulwark guard: ${why.join('; ')}`, ...lines].join('\n');
}
