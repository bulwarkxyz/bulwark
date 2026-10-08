import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Notifications', description: 'What the guard told you: alert lines crossed, actions taken, and anything it could not do.' };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
