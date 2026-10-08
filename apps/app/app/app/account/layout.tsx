import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Account', description: 'Your Hyperliquid account: value, margin, every margin pool with its buffer, and the keys the guard uses.' };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
