/**
 * Links Telegram to the test wallet, so the guard's alerts (the hosted testnet guard's, and the mainnet canary's)
 * reach your chat with @BulwarkGuardBot. It signs in to Bulwark's API as the wallet (that signature authorises
 * nothing), asks for a one-time link code, prints the link, and waits until you have opened it and pressed Start.
 *
 *   pnpm --filter @bulwarkxyz/ops testrun link-telegram
 */
import { RunLog, WALLET, loadWallet } from './guard.js';
import { Session } from './session.js';

export async function linkTelegram(): Promise<void> {
  const s = new Session(new RunLog('link-telegram'), loadWallet());
  await s.signIn();
  const now = (await s.api<{ linked: boolean }>('/v1/telegram')).body;
  if (now.linked) return void console.log(`\nTelegram is already linked to ${WALLET}. Nothing to do.`);
  const code = (await s.api<{ link: string | null; code: string; expiresInMinutes: number }>('/v1/telegram/code', { method: 'POST' })).body;
  console.log(`\nOn your phone, open this link and press Start (it works once, for ${code.expiresInMinutes} minutes):\n\n  ${code.link ?? `send /start ${code.code} to @BulwarkGuardBot`}\n\nWaiting for the link…`);
  const end = Date.now() + code.expiresInMinutes * 60_000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 3000));
    if ((await s.api<{ linked: boolean }>('/v1/telegram')).body.linked) return void console.log(`\nLinked. Alerts for ${WALLET} now reach that chat.`);
  }
  console.log('\nThe code expired before the link was opened. Run this again.');
}
