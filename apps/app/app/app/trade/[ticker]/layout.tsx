import type { Metadata } from 'next';

export async function generateMetadata({ params }: { params: Promise<{ ticker: string }> }): Promise<Metadata> {
  const ticker = decodeURIComponent((await params).ticker).toUpperCase().replace(/^XYZ:/, '');
  return { title: { absolute: `${ticker} · Trade · Bulwark` }, description: `Trade ${ticker} on Hyperliquid testnet, with the chart, the order book and what the guard will do before you place an order.` };
}

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
