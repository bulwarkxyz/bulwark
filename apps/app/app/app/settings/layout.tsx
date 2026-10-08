import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Settings', description: 'Your guard key and trading key, alerts and Telegram, the Bulwark fee, the kill switch and display settings.' };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
