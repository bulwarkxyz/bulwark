import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Trade', description: 'Trade HIP-3 stock and commodity perps on Hyperliquid testnet, with the chart, the order book and what the guard will do before you place an order.' };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
