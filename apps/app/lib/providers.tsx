'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { WagmiProvider } from 'wagmi';
import { ReviewProvider } from './review';
import { TimesProvider } from './time';
import { WalletProvider, wagmiConfig } from './wallet';

// A screen that mounts within this long of the last answer reuses it instead of asking again; every live
// query keeps polling on its own interval, so nothing older than its poll is ever shown.
const FRESH_MS = 2_000;

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: FRESH_MS } } }));
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={client}>
        <WalletProvider>
          <ReviewProvider>
            <TimesProvider>{children}</TimesProvider>
          </ReviewProvider>
        </WalletProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
