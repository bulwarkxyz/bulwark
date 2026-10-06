'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { createSiweMessage } from 'viem/siwe';
import { useAccount, useDisconnect, useSignMessage } from 'wagmi';
import { api, setSessionToken, useSignedIn } from '@/lib/api';
import { useReview, useViewer } from '@/lib/review';
import { useWalletChainId, useWalletModal } from '@/lib/wallet';
import { explainWalletError, type Explained } from '@/lib/wallet-errors';
import { shortAddr } from './format';

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

/** `stepSignIn`: the page has its own Sign in (setup), so phones skip the header's to keep it on one line. */
export function ConnectButton({ stepSignIn = false }: { stepSignIn?: boolean }) {
  const { address, isConnected, isConnecting, isReconnecting } = useAccount();
  const wallet = useWalletModal();
  const signIn = useSignIn();
  const [err, setErr] = useState<Explained | null>(null);
  const signedIn = useSignedIn();
  const review = useReview();
  const viewer = useViewer();

  if (review.on && review.watch && viewer.connected) {
    return (
      <Link className="wallet" href="/app/account" aria-label="Account (review build: a public account shown read-only)">
        <span className="num small">{shortAddr(review.watch)}</span>
        <span className="tag">Watching</span>
      </Link>
    );
  }
  if (!isConnected) {
    // The modal being open isn't "connecting": that starts when a wallet is chosen.
    const busy = wallet.loading || isConnecting || isReconnecting;
    return (
      <button type="button" className="btn btn-sm btn-ink" onClick={wallet.open}>
        {busy ? 'Connecting…' : 'Connect wallet'}
      </button>
    );
  }
  return (
    <div className="row nw" style={{ gap: 8 }}>
      {!signedIn ? (
        <button
          type="button"
          className={`btn btn-sm btn-ink ${stepSignIn ? 'hide-sm' : ''}`}
          onClick={() => {
            setErr(null);
            signIn().catch((e: unknown) => setErr(explainWalletError(e)));
          }}
        >
          Sign in
        </button>
      ) : null}
      <Link className="wallet" href="/app/account" aria-label="Account">
        <span className="num small">{shortAddr(address as string)}</span>
      </Link>
      {err ? (
        <span className="hide-sm">
          <WalletMessage error={err} compact />
        </span>
      ) : null}
    </div>
  );
}

/** Disconnect and forget the session (Account and Settings). */
export function DisconnectButton() {
  const { isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  if (!isConnected) return null;
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={() => {
        setSessionToken(null);
        disconnect();
      }}
    >
      Disconnect
    </button>
  );
}
