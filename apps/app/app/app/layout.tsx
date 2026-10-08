import type { Metadata } from 'next';
import './app.css';
import { AppShell } from '@/components/app/shell';
import { Providers } from '@/lib/providers';

export const metadata: Metadata = {
  title: { default: 'Markets · Bulwark', template: '%s · Bulwark' },
  description: 'Every HIP-3 stock and commodity market on Hyperliquid testnet, with price, funding and whether its home market is open.',
};

export default function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <Providers>
      <AppShell>{children}</AppShell>
    </Providers>
  );
}
