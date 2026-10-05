import { TradeScreen } from '@/components/app/trade-screen';
import { MARKETS } from '@/lib/markets';

/**
 * Pre-rendered for every curated market (and its other names), so opening Trade is a static file from the
 * CDN, not a server render. Any other ticker still renders on demand.
 */
export const dynamicParams = true;
export function generateStaticParams() {
  return MARKETS.flatMap((m) => [m.ticker, ...(m.aliases ?? [])]).map((ticker) => ({ ticker }));
}

export default async function TradePage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  return <TradeScreen ticker={ticker} />;
}
