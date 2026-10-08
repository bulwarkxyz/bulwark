import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Set up', description: 'Seven steps from connecting your wallet to your first signed rules. Nothing here moves your funds.' };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
