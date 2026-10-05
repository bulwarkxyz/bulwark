import './app.css';
import { AppShell } from '@/components/app/shell';
import { Providers } from '@/lib/providers';

export const metadata = { title: 'Bulwark app' };

export default function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <Providers>
      <AppShell>{children}</AppShell>
    </Providers>
  );
}
