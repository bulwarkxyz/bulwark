'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { createSiweMessage } from 'viem/siwe';
import { useAccount, useChainId, useConnect, useDisconnect, useSignMessage } from 'wagmi';
import { api, setSessionToken, useSignedIn } from '@/lib/api';
import { useReview, useViewer } from '@/lib/review';
import { shortAddr } from './format';

/** Sign-in with Ethereum against the Bulwark API. The message says it authorises no transaction. */
export function useSignIn() {
  const { address } = useAccount();
  const chainId = useChainId();
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
    setSessionToken(token);
    await qc.invalidateQueries({ queryKey: ['me'] });
  };
}

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const signIn = useSignIn();
  const [err, setErr] = useState<string | null>(null);
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
    const injected = connectors[0];
    return (
      <button type="button" className="btn btn-sm btn-ink" disabled={!injected || isPending} onClick={() => injected && connect({ connector: injected })}>
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
    );
  }
  return (
    <div className="row nw" style={{ gap: 8 }}>
      {!signedIn ? (
        <button
          type="button"
          className="btn btn-sm btn-ink"
          onClick={() => {
            setErr(null);
            signIn().catch((e: Error) => setErr(e.message));
          }}
        >
          Sign in
        </button>
      ) : null}
      <Link className="wallet" href="/app/account" aria-label="Account">
        <span className="num small">{shortAddr(address as string)}</span>
      </Link>
      {err ? <span className="err hide-sm" style={{ fontSize: 12 }}>{err}</span> : null}
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
