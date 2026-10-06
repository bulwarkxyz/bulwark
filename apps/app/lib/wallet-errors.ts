import { ApiError } from './api';

/**
 * Every failure while connecting a wallet or signing with it, in plain words with the next step. Wallets
 * report the same thing in different ways (EIP-1193 codes, viem error classes, WalletConnect strings,
 * Hyperliquid's and Bulwark's own answers), so each case matches all of them.
 */
export interface Explained {
  /** What happened. */
  text: string;
  /** What to do now. */
  next?: string;
  /** The user chose not to: show it quietly, not as an error. */
  declined?: boolean;
}

interface Shape {
  code?: number;
  name?: string;
  message?: string;
  shortMessage?: string;
  details?: string;
  cause?: unknown;
}

/** The error and its causes, outermost first (viem and wagmi wrap the wallet's own error). */
function chain(e: unknown): Shape[] {
  const out: Shape[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
    out.push(cur as Shape);
    cur = (cur as Shape).cause;
  }
  if (typeof e === 'string') out.push({ message: e });
  return out;
}

const PHONE = 'Open the wallet app on your phone and try again.';

export function explainWalletError(e: unknown): Explained {
  // Bulwark's API answers first: they carry their own words.
  if (e instanceof ApiError) {
    // The API's text already says what to do: show it alone.
    if (e.body.code === 'contract_wallet') return { text: e.message };
    // A site the API doesn't accept sign-ins from (each nonce is bound to one site).
    if (e.body.code === 'wrong_domain') return { text: 'This site isn’t allowed to sign in to Bulwark.', next: 'Sign in at bulwark.0xo.in.' };
    // The app's own server route couldn't reach the API: a problem with this version of the app, not your wallet.
    if (e.body.code === 'api_unreachable') return { text: 'This version of the app can’t reach Bulwark’s server.', next: 'Nothing was signed or changed. Try again shortly, or use bulwark.0xo.in.' };
    if (e.status === 401) return { text: 'Bulwark didn’t accept your sign-in or that signature.', next: 'Sign in again. If it repeats, check your wallet shows the same address as Bulwark.' };
    if (e.status === 403) return { text: e.message, next: 'Bulwark is not available where you live or for your citizenship.' };
    if (e.status === 429) return { text: 'Too many requests in a short time.', next: 'Wait a minute and try again.' };
    if (e.status >= 500) return { text: 'Bulwark’s server could not answer.', next: 'Try again in a minute. Nothing was signed or changed.' };
    return { text: e.message };
  }
  const all = chain(e);
  const codes = all.map((x) => x.code).filter((c): c is number => typeof c === 'number');
  const names = all.map((x) => x.name ?? '').join(' ');
  const words = all.map((x) => `${x.shortMessage ?? ''} ${x.message ?? ''} ${x.details ?? ''}`).join(' ');
  const has = (re: RegExp) => re.test(words);

  if (codes.includes(4001) || /UserRejected/.test(names) || has(/user (rejected|denied|cancel+ed|disapproved)|rejected by user|request rejected|denied (message|transaction) signature|action_rejected/i))
    return { text: 'You declined in your wallet.', next: 'Nothing was signed. Try again when you’re ready.', declined: true };
  if (codes.includes(-32002) || has(/already pending|request already|already processing/i))
    return { text: 'Your wallet already has a request open.', next: 'Open your wallet and approve or cancel it, then try again.' };
  if (/ProviderNotFound|ConnectorNotFound/.test(names) || has(/provider not found|no (injected )?provider|connector not found|no ethereum provider/i))
    return { text: 'No browser wallet found.', next: 'Install a wallet extension, or choose WalletConnect to use a wallet on your phone.' };
  if (codes.includes(4100) || has(/not been authori[sz]ed|unauthori[sz]ed.*account|account.*not.*(connected|authori[sz]ed)/i))
    return { text: 'Your wallet hasn’t given Bulwark access to this account.', next: 'Open your wallet, connect this site to the account, and try again.' };
  if (codes.includes(4200) || codes.includes(-32601) || /MethodNotSupported|UnsupportedProviderMethod/.test(names) || has(/method (not supported|not found|does not exist)|not support(ed)? (eth_)?signTypedData|unsupported method/i))
    return { text: 'This wallet can’t make the kind of signature Bulwark needs (EIP-712).', next: 'Use a wallet that supports typed signatures, such as MetaMask, Rabby or Rainbow.' };
  if (codes.includes(4900) || codes.includes(4901) || /Disconnected/.test(names) || has(/disconnected|session (expired|ended|deleted)|no matching key|connection (closed|lost)/i))
    return { text: 'Your wallet disconnected.', next: 'Connect it again and retry.' };
  if (has(/must match the active chain|chainId.*(does not match|mismatch)|chain mismatch|ChainMismatch/i) || /ChainMismatch/.test(names))
    return { text: 'Your wallet changed network while signing.', next: 'Leave it on one network and sign again. Any network works.' };
  if (codes.includes(4902) || /ChainNotConfigured|SwitchChain/.test(names) || has(/unrecogni[sz]ed chain|switch(ing)? chain/i))
    return { text: 'Your wallet couldn’t switch network.', next: 'Bulwark doesn’t need a particular network. Try again on the one your wallet is on.' };
  if (has(/expired|timed? ?out|timeout/i)) return { text: 'The request to your wallet timed out.', next: PHONE };
  if (has(/contract wallet|erc-?6492|smart[- ]contract|smart (wallet|account)/i))
    return { text: 'Smart-contract wallets can’t sign for Hyperliquid accounts.', next: 'Connect the ordinary wallet that holds your Hyperliquid account.' };
  // Hyperliquid's answers to a user-signed action.
  if (has(/User or API Wallet .* does not exist/i))
    return { text: 'Hyperliquid didn’t recognise that signature as your account.', next: 'Check your wallet is on the address you deposited with, then sign again.' };
  if (has(/Must deposit before performing actions/i)) return { text: 'This address has no deposit on Hyperliquid yet.', next: 'Deposit USDC on Hyperliquid, then come back.' };
  if (has(/Failed to fetch|NetworkError|network request failed|Load failed/i)) return { text: 'Couldn’t reach the network.', next: 'Check your connection and try again.' };
  const first = all.find((x) => x.shortMessage || x.message);
  return { text: (first?.shortMessage ?? first?.message ?? 'Something went wrong with your wallet.').split('\n')[0]! };
}

/** One line for the places that show a single message. */
export function walletErrorText(e: unknown): string {
  const x = explainWalletError(e);
  return x.next ? `${x.text} ${x.next}` : x.text;
}
