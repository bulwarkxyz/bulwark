'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { arbitrum, mainnet } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';
import { ReviewProvider } from './review';
import { TimesProvider } from './time';

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
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } }));
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
