'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createSiweMessage } from 'viem/siwe';
import { useAccount, useChainId, useConnect, useDisconnect, useSignMessage } from 'wagmi';
import { api, setSessionToken, useSignedIn } from '@/lib/api';
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
  const { disconnect } = useDisconnect();
  const signIn = useSignIn();
  const [err, setErr] = useState<string | null>(null);
  const signedIn = useSignedIn();

  if (!isConnected) {
    const injected = connectors[0];
    return (
      <button type="button" className="btn btn-sm btn-primary" disabled={!injected || isPending} onClick={() => injected && connect({ connector: injected })}>
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
    );
  }
  return (
    <div className="row" style={{ gap: 8 }}>
      {!signedIn ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setErr(null);
            signIn().catch((e: Error) => setErr(e.message));
          }}
        >
          Sign in
        </button>
      ) : null}
      <button
        type="button"
        className="chip"
        style={{ height: 34 }}
        onClick={() => {
          setSessionToken(null);
          disconnect();
        }}
        title="Disconnect"
      >
        <span className="num">{shortAddr(address as string)}</span>
      </button>
      {err ? <span className="err" style={{ fontSize: 12 }}>{err}</span> : null}
    </div>
  );
}
