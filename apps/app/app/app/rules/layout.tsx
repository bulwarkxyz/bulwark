import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Guard rules', description: 'Write the rules the guard follows: your own buffer lines, in your own words or by hand, signed in your wallet.' };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
