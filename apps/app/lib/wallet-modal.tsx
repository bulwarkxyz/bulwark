'use client';

import { RainbowKitProvider, useConnectModal, type Theme } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import { useEffect } from 'react';
import { setModalBridge } from './wallet';

/**
 * The modal in the app's own tokens (app.css defines them on [data-rk] too), so it follows light and
 * dark and never shows RainbowKit's blue. Ink is the primary action, as everywhere in the app; the
 * connected dot is neutral, since colour carries guard state only. No shadows that read as glow.
 */
const theme: Theme = {
  colors: {
    accentColor: 'var(--ink)',
    accentColorForeground: 'var(--on-ink)',
    actionButtonBorder: 'var(--line-2)',
    actionButtonBorderMobile: 'var(--line-2)',
    actionButtonSecondaryBackground: 'var(--s2)',
    closeButton: 'var(--text-2)',
    closeButtonBackground: 'var(--s2)',
    connectButtonBackground: 'var(--ink)',
    connectButtonBackgroundError: 'var(--crit)',
    connectButtonInnerBackground: 'var(--s2)',
    connectButtonText: 'var(--on-ink)',
    connectButtonTextError: 'var(--on-crit)',
    connectionIndicator: 'var(--text-2)',
    downloadBottomCardBackground: 'var(--surface)',
    downloadTopCardBackground: 'var(--s2)',
    error: 'var(--crit)',
    generalBorder: 'var(--line)',
    generalBorderDim: 'var(--line)',
    menuItemBackground: 'var(--s2)',
    modalBackdrop: 'var(--scrim)',
    modalBackground: 'var(--surface)',
    modalBorder: 'var(--line-2)',
    modalText: 'var(--text)',
    modalTextDim: 'var(--text-3)',
    modalTextSecondary: 'var(--text-2)',
    profileAction: 'var(--s2)',
    profileActionHover: 'var(--s3)',
    profileForeground: 'var(--surface)',
    selectedOptionBorder: 'var(--line-2)',
    standby: 'var(--text-3)',
  },
  fonts: { body: 'var(--font-geist), ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
  radii: { actionButton: '8px', connectButton: '8px', menuButton: '8px', modal: '12px', modalMobile: '14px' },
  shadows: { connectButton: 'none', dialog: '0 12px 40px rgba(0,0,0,.28)', profileDetailsAction: 'none', selectedOption: 'none', selectedWallet: 'none', walletLogo: 'none' },
  blurs: { modalOverlay: 'none' },
};

/** RainbowKit's connect modal, loaded after the page (lib/wallet.tsx mounts it). */
export default function WalletModal() {
  return (
    <RainbowKitProvider theme={theme} modalSize="compact" locale="en-US" showRecentTransactions={false} appInfo={{ appName: 'Bulwark', disclaimer: Disclaimer }}>
      <Bridge />
    </RainbowKitProvider>
  );
}

/** Hands the modal's opener to the rest of the app. */
function Bridge() {
  const { openConnectModal, connectModalOpen } = useConnectModal();
  useEffect(() => {
    setModalBridge({ open: openConnectModal ?? null, isOpen: connectModalOpen });
  }, [openConnectModal, connectModalOpen]);
  useEffect(() => () => setModalBridge({ open: null, isOpen: false }), []);
  return null;
}

function Disclaimer({ Text }: { Text: React.FC<{ children: React.ReactNode }> }) {
  return <Text>Connecting shares your address only. Bulwark asks for a signature to sign in, and never for a transaction or your keys.</Text>;
}

