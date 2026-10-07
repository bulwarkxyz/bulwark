'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { createSiweMessage } from 'viem/siwe';
import { useAccount, useDisconnect, useSignMessage } from 'wagmi';
import { api, setSessionToken, useSignedIn } from '@/lib/api';
import { useReview, useViewer } from '@/lib/review';
import { NETWORK, explorerAddress } from '@/lib/env';
import { useWalletChainId, useWalletModal } from '@/lib/wallet';
import { explainWalletError, type Explained } from '@/lib/wallet-errors';
import { shortAddr } from './format';
import { Icon } from './icons';
import { Popover } from './popover';

/** Sign-in with Ethereum against the Bulwark API. The message says it authorises no transaction. */
export function useSignIn() {
  const { address } = useAccount();
  const chainId = useWalletChainId();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  return async () => {
    if (!address) throw new Error('connect a wallet first');
    const { nonce, domain } = await api<{ nonce: string; domain: string }>('/auth/nonce', { body: { address } });
    const message = createSiweMessage({
      address,
      chainId,
      domain,
      nonce,
      uri: `https://${domain}`,
      version: '1',
      statement: 'Sign in to Bulwark. This signature does not authorise any transaction.',
      issuedAt: new Date(),
    });
    const signature = await signMessageAsync({ message });
    const { token } = await api<{ token: string }>('/auth/verify', { body: { message, signature } });
    setSessionToken(token, address);
    await qc.invalidateQueries({ queryKey: ['me'] });
  };
}

/** A connection or signing failure: what happened and what to do (lib/wallet-errors.ts). */
export function WalletMessage({ error, compact = false }: { error: Explained; compact?: boolean }) {
  return (
    <span role={error.declined ? 'status' : 'alert'} className={`small ${error.declined ? 't2' : 'ct'}`} style={compact ? { fontSize: 12 } : undefined}>
      {error.text}
      {error.next ? <span className="t2"> {error.next}</span> : null}
    </span>
  );
}

/**
 * Ends the Bulwark session and the wallet connection together, and drops everything loaded for that
 * address, so the next account starts clean.
 */
export function useEndSession() {
  const { address } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const qc = useQueryClient();
  return async () => {
    const who = address?.toLowerCase();
    setSessionToken(null);
    await disconnectAsync().catch(() => {});
    qc.removeQueries({ predicate: (q) => ['me', 'alert-settings', 'guard-status'].includes(String(q.queryKey[0])) || (who ? JSON.stringify(q.queryKey).toLowerCase().includes(who) : false) });
  };
}

/** A wallet was connected in this browser before (wagmi remembers the last connector). */
function hadWallet(): boolean {
  try {
    return Boolean(localStorage.getItem('wagmi.recentConnectorId'));
  } catch {
    return false;
  }
}

/** `stepSignIn`: the page has its own Sign in (setup), so phones skip the header's to keep it on one line. */
export function ConnectButton({ stepSignIn = false }: { stepSignIn?: boolean }) {
  const { address, isConnected, isConnecting, isReconnecting } = useAccount();
  const wallet = useWalletModal();
  const signIn = useSignIn();
  const [err, setErr] = useState<Explained | null>(null);
  const signedIn = useSignedIn();
  const review = useReview();
  const viewer = useViewer();
  const btn = useRef<HTMLButtonElement>(null);
  const signBtn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const clearErr = useCallback(() => setErr(null), []);
  const close = useCallback(() => setOpen(false), []);

  if (review.on && review.watch && viewer.connected) {
    return (
      <>
        <button ref={btn} type="button" className="wallet" aria-haspopup="dialog" aria-expanded={open} aria-label="Watched account (review build): open menu" onClick={() => setOpen((o) => !o)}>
          <span className="num small">{shortAddr(review.watch)}</span>
          {/* Phones keep the title room; the menu says what "Watching" means. */}
          <span className="tag hide-sm">Watching</span>
        </button>
        <Popover anchor={btn} open={open} onClose={close} label="Watched account" width={340}>
          <WatchingMenu address={review.watch} onClose={close} />
        </Popover>
      </>
    );
  }
  if (!isConnected) {
    // The modal being open isn't "connecting": that starts when a wallet is chosen. wagmi also runs a
    // reconnect pass on every page load and calls it "connecting", even for a visitor who never connected:
    // only say so when a wallet was connected here before.
    const busy = wallet.loading || ((isConnecting || isReconnecting) && hadWallet());
    return (
      <button type="button" className="btn btn-sm btn-ink" onClick={wallet.open}>
        {busy ? 'Connecting…' : 'Connect wallet'}
      </button>
    );
  }
  const doSignIn = () => {
    setErr(null);
    signIn().catch((e: unknown) => setErr(explainWalletError(e)));
  };
  return (
    <div className="row nw" style={{ gap: 8 }}>
      {!signedIn ? (
        <button ref={signBtn} type="button" className={`btn btn-sm btn-ink ${stepSignIn ? 'hide-sm' : ''}`} onClick={doSignIn}>
          Sign in
        </button>
      ) : null}
      <button ref={btn} type="button" className="wallet" aria-haspopup="dialog" aria-expanded={open} aria-label="Wallet menu" onClick={() => setOpen((o) => !o)}>
        {/* Phones, not yet signed in: Sign in sits next to it, so the address gives way to an icon. */}
        <span className={`num small ${signedIn ? '' : 'hide-sm'}`}>{shortAddr(address as string)}</span>
        {signedIn ? null : <span className="mobile-only">{Icon.account(14)}</span>}
        {Icon.caret()}
      </button>
      <Popover anchor={btn} open={open} onClose={close} label="Wallet" width={340}>
        <WalletMenu onClose={close} onSignIn={doSignIn} signedIn={signedIn} />
      </Popover>
      {/* A failed sign-in opens under its button in the top layer, so the top bar never reflows. */}
      <Popover anchor={signBtn.current ? signBtn : btn} open={Boolean(err)} onClose={clearErr} label="Sign-in problem" width={320}>
        {err ? (
          <div className="wm col">
            <WalletMessage error={err} />
            <div className="row nw" style={{ gap: 8 }}>
              {err.declined ? null : (
                <button type="button" className="btn btn-sm btn-ink" onClick={doSignIn}>
                  Try again
                </button>
              )}
              <button type="button" className="btn btn-sm btn-ghost" onClick={clearErr}>
                Close
              </button>
            </div>
          </div>
        ) : null}
      </Popover>
    </div>
  );
}

/** Copy to the clipboard, saying so for two seconds. */
function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  return (
    <div className="wm-addr">
      <span className="num small" style={{ wordBreak: 'break-all' }}>
        {address}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        aria-label="Copy address"
        onClick={() => {
          navigator.clipboard
            .writeText(address)
            .then(() => setCopied('ok'))
            .catch(() => setCopied('fail'))
            .finally(() => setTimeout(() => setCopied(null), 2000));
        }}
      >
        {Icon.copy()} {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Can’t copy' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * The wallet menu: what wagmi knows about the connection (the wallet's name and icon from its
 * connector, its address and chain) and the actions RainbowKit and wagmi provide (the connect modal to
 * switch wallet, disconnect). The Bulwark session ends with the connection.
 */
function WalletMenu({ onClose, onSignIn, signedIn }: { onClose: () => void; onSignIn: () => void; signedIn: boolean }) {
  const { address, connector, chain, chainId } = useAccount();
  const wallet = useWalletModal();
  const end = useEndSession();
  const router = useRouter();
  if (!address) return null;
  return (
    <div className="wm col">
      <div className="wm-head row nw">
        {connector?.icon ? <img src={connector.icon} alt="" width={24} height={24} style={{ borderRadius: 6 }} /> : <span className="wm-icon">{Icon.account(14)}</span>}
        <span className="col" style={{ gap: 0 }}>
          <b className="small">{connector?.name ?? 'Wallet'}</b>
          <span className="tiny t2">{signedIn ? 'Connected and signed in' : 'Connected, not signed in'}</span>
        </span>
      </div>
      <CopyAddress address={address} />
      <a className="wm-row" href={explorerAddress(address)} target="_blank" rel="noopener noreferrer">
        {Icon.external()} View on Hyperliquid’s explorer
      </a>
      <div className="wm-kv">
        <span className="tiny t3">Network</span>
        <span className="small">
          Hyperliquid {NETWORK} <span className="tag tag-net">{NETWORK}</span>
        </span>
        <span className="tiny t3">Wallet is on</span>
        <span className="small">{chain?.name ?? `chain ${chainId}`}</span>
      </div>
      <span className="tiny t3">Bulwark needs no particular wallet network: each signature uses the one your wallet is on.</span>
      <div className="wm-actions col">
        {!signedIn ? (
          <button
            type="button"
            className="btn btn-sm btn-ink btn-block"
            onClick={() => {
              onClose();
              onSignIn();
            }}
          >
            Sign in
          </button>
        ) : null}
        <button
          type="button"
          className="wm-row"
          onClick={async () => {
            onClose();
            await end();
            wallet.open();
          }}
        >
          {Icon.swap()} Switch wallet
        </button>
        <button
          type="button"
          className="wm-row"
          onClick={async () => {
            onClose();
            await end();
          }}
        >
          {Icon.logout()} Disconnect
        </button>
        <button
          type="button"
          className="wm-row"
          onClick={() => {
            onClose();
            router.push('/app/account');
          }}
        >
          {Icon.account(14)} Account: pools, keys and fees
        </button>
      </div>
    </div>
  );
}

/** Review builds only: what "Watching" means, and how to leave it. */
function WatchingMenu({ address, onClose }: { address: string; onClose: () => void }) {
  const router = useRouter();
  return (
    <div className="wm col">
      <div className="wm-head row nw">
        <span className="wm-icon">{Icon.eye()}</span>
        <span className="col" style={{ gap: 0 }}>
          <b className="small">Watching a public account</b>
          <span className="tiny t2">Review build only</span>
        </span>
      </div>
      <span className="small t2">This review link shows a public testnet account read-only, as if it were connected, so the screens have real positions to show. Nothing here can sign or send for it. Production builds don’t have this.</span>
      <CopyAddress address={address} />
      <a className="wm-row" href={explorerAddress(address)} target="_blank" rel="noopener noreferrer">
        {Icon.external()} View on Hyperliquid’s explorer
      </a>
      <div className="wm-actions col">
        <a className="wm-row" href="/app">
          {Icon.logout()} Stop watching
        </a>
        <button
          type="button"
          className="wm-row"
          onClick={() => {
            onClose();
            router.push('/app/account');
          }}
        >
          {Icon.account(14)} Account: pools, keys and fees
        </button>
      </div>
    </div>
  );
}

/** Disconnect and forget the session (Account and Settings). */
export function DisconnectButton() {
  const { isConnected } = useAccount();
  const end = useEndSession();
  if (!isConnected) return null;
  return (
    <button type="button" className="btn btn-sm" onClick={() => void end()}>
      Disconnect
    </button>
  );
}
