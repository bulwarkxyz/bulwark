import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Positions', description: 'Your open positions, each margin pool’s buffer, and the price at which the guard steps in.' };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
