'use client';

import type { Wallet, WalletList } from '@rainbow-me/rainbowkit';
import { injectedWallet, metaMaskWallet, rabbyWallet, rainbowWallet, trustWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets';
import { useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createConfig, http, useAccount, useAccountEffect, type CreateConnectorFn } from 'wagmi';
import { arbitrum, mainnet } from 'wagmi/chains';
import { sessionAddress, sessionToken, setSessionToken } from './api';
import { WALLETCONNECT_PROJECT_ID } from './env';

/**
 * Wallet connection: RainbowKit's modal over wagmi.
 * - Browser wallets are found through EIP-6963 (wagmi's multi-injected discovery), each under its own
 *   name and icon, plus the plain injected provider for older extensions.
 * - Phone and desktop-app wallets connect through WalletConnect once a project ID is set.
 * - No smart-contract wallets: Hyperliquid accounts are ordinary addresses, so Coinbase's Base smart
 *   account and passkey wallets are left out (the Coinbase extension still appears through EIP-6963).
 * Hyperliquid's user-signed actions take any signature chain, so there is no network switch: each
 * signature uses the chain the wallet is on (useAccount().chainId).
 */
// The plain injected provider, for extensions that don't announce themselves through EIP-6963: neutral
// icon instead of RainbowKit's blue one, and listed only when such a provider is actually there.
const NEUTRAL_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><rect width="28" height="28" rx="6" fill="#5D6B7B"/><rect x="7" y="9" width="14" height="10" rx="2" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="17.5" cy="14" r="1.4" fill="#fff"/></svg>')}`;
const browserWallet = (): Wallet => ({
  ...injectedWallet(),
  name: 'Browser wallet',
  iconUrl: NEUTRAL_ICON,
  iconBackground: '#5D6B7B',
  hidden: () => typeof window === 'undefined' || !(window as Window & { ethereum?: unknown }).ethereum,
});

const withPhones = WALLETCONNECT_PROJECT_ID
  ? [
      { groupName: 'Popular', wallets: [metaMaskWallet, rabbyWallet, rainbowWallet, trustWallet] },
      { groupName: 'More', wallets: [walletConnectWallet, browserWallet] },
    ]
  : [{ groupName: 'Browser wallets', wallets: [browserWallet, rabbyWallet] }];

/**
 * The connectors, built from RainbowKit's wallet list the way its connectorsForWallets does, so the
 * config needs only the small wallets entry and the modal's UI can load later (wallet-modal.tsx).
 */
function connectorsFor(list: WalletList): CreateConnectorFn[] {
  const metadata = { name: 'Bulwark', description: 'Trade Hyperliquid stock and commodity markets with a margin guard.', url: 'https://bulwark.0xo.in', icons: ['https://bulwark.0xo.in/favicon.svg'] };
  const out: CreateConnectorFn[] = [];
  const seen = new Set<string>();
  let index = -1;
  list.forEach(({ groupName, wallets }, g) => {
    for (const create of wallets) {
      index++;
      // The project ID is used only by the WalletConnect wallets, which are listed only when it is set.
      const { createConnector, hidden, ...meta } = create({ projectId: WALLETCONNECT_PROJECT_ID || 'unset', appName: 'Bulwark', appIcon: metadata.icons[0], options: { metadata }, walletConnectParameters: { metadata } }) as Wallet & { hidden?: () => boolean };
      if (seen.has(meta.id) || (typeof hidden === 'function' && hidden())) continue;
      seen.add(meta.id);
      const details = (extra: Record<string, unknown> = {}) => ({ rkDetails: Object.fromEntries(Object.entries({ ...meta, groupIndex: g + 1, groupName, index, isRainbowKitConnector: true, ...extra }).filter(([, v]) => v !== undefined)) });
      if (meta.id === 'walletConnect') out.push(createConnector(details({ isWalletConnectModalConnector: true, showQrModal: true }) as never));
      out.push(createConnector(details() as never));
    }
  });
  return out;
}
const connectors = typeof window === 'undefined' ? [] : connectorsFor(withPhones);

export const wagmiConfig = createConfig({
  chains: [arbitrum, mainnet],
  connectors,
  transports: { [arbitrum.id]: http(), [mainnet.id]: http() },
  ssr: true,
});

/**
 * The chain the connected wallet is on, for signatures: Hyperliquid and Bulwark accept any, but a wallet
 * refuses an EIP-712 domain whose chainId isn't its active one. Arbitrum when nothing is connected.
 */
export function useWalletChainId(): number {
  return useAccount().chainId ?? arbitrum.id;
}

/**
 * A Bulwark session belongs to the address that signed in. When the wallet disconnects, or switches to
 * another account, the session ends and the screens reload for the new state; the user signs in again.
 */
function SessionFollowsWallet() {
  const { address, status } = useAccount();
  const qc = useQueryClient();
  const end = () => {
    if (!sessionToken()) return;
    setSessionToken(null);
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
  useAccountEffect({ onDisconnect: end });
  useEffect(() => {
    if (status !== 'connected' || !address) return;
    const owner = sessionAddress();
    if (sessionToken() && owner && owner !== address.toLowerCase()) end();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, status]);
  return null;
}

// ------------------------------------------------------------------ the connect modal, loaded lazily

type ModalState = { ready: boolean; open: boolean; wanted: boolean };
let modal: ModalState = { ready: false, open: false, wanted: false };
const modalListeners = new Set<() => void>();
let opener: (() => void) | null = null;
/** Called by wallet-modal.tsx once RainbowKit is mounted, and whenever its modal opens or closes. */
export function setModalBridge(next: { open: (() => void) | null; isOpen: boolean }) {
  opener = next.open;
  modal = { ready: Boolean(next.open), open: next.isOpen, wanted: modal.wanted };
  if (modal.wanted && opener && !next.isOpen) {
    modal = { ...modal, wanted: false };
    opener();
  }
  for (const fn of modalListeners) fn();
}
function setWanted(wanted: boolean) {
  modal = { ...modal, wanted };
  for (const fn of modalListeners) fn();
}
const subscribeModal = (fn: () => void) => {
  modalListeners.add(fn);
  return () => {
    modalListeners.delete(fn);
  };
};
const SERVER_MODAL: ModalState = { ready: false, open: false, wanted: false };

/** Open the connect modal: at once when it's loaded, or as soon as it is. */
export function useWalletModal() {
  const state = useSyncExternalStore(subscribeModal, () => modal, () => SERVER_MODAL);
  return {
    open: () => (opener ? opener() : setWanted(true)),
    isOpen: state.open,
    /** Clicked before the modal's code arrived: show it's coming. */
    loading: state.wanted && !state.ready,
  };
}

const WalletModal = dynamic(() => import('./wallet-modal'), { ssr: false });

/** Mounts the modal after the page is idle (or at the first click), so it never delays the first paint. */
export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [load, setLoad] = useState(false);
  const wanted = useSyncExternalStore(subscribeModal, () => modal.wanted, () => false);
  useEffect(() => {
    if (load) return;
    if (wanted) return setLoad(true);
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setLoad(true), { timeout: 3_000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(() => setLoad(true), 1_500);
    return () => clearTimeout(t);
  }, [load, wanted]);
  return (
    <>
      <SessionFollowsWallet />
      {children}
      {load ? <WalletModal /> : null}
    </>
  );
}
