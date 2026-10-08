import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Audit log', description: 'Every guard action, rule change and signed command on your account, in a chain anyone can verify.' };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
