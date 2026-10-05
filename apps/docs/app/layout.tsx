import { RootProvider } from 'fumadocs-ui/provider/next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { Metadata } from 'next';
import './global.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });

export const metadata: Metadata = {
  title: 'Bulwark docs',
  description: 'How the Bulwark guard works, how keys are stored, what it costs, the risks, and the crash-day replays.',
  icons: { icon: '/docs/favicon.svg' },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        {/* basePath is /docs, so the search route lives at /docs/api/search */}
        <RootProvider theme={{ defaultTheme: 'dark' }} search={{ options: { api: '/docs/api/search' } }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
