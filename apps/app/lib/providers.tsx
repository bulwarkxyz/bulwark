'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { arbitrum, mainnet } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';
import { ReviewProvider } from './review';
import { TimesProvider } from './time';

// A screen that mounts within this long of the last answer reuses it instead of asking again; every live
// query keeps polling on its own interval, so nothing older than its poll is ever shown.
const FRESH_MS = 2_000;

/**
 * Browser wallets only (EIP-6963 discovery through the injected connector). Hyperliquid's user-signed
 * actions accept any signature chain id, so the wallet's active chain is used as is.
 */
export const wagmiConfig = createConfig({
  chains: [arbitrum, mainnet],
  connectors: [injected()],
  transports: { [arbitrum.id]: http(), [mainnet.id]: http() },
  ssr: true,
});

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: FRESH_MS } } }));
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={client}>
        <ReviewProvider>
          <TimesProvider>{children}</TimesProvider>
        </ReviewProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
