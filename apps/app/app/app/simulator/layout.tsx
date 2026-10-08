import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Simulator', description: 'Move prices on your real positions and see what your signed rules would do, step by step, before it happens.' };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
