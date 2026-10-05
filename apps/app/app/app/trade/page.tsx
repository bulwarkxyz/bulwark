'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NETWORK } from '@/lib/env';
import { useMarketActivity } from '@/lib/hl';
import { readLastMarket } from '@/lib/last-market';
import { defaultMarket } from '@/lib/markets';

/**
 * /app/trade: opens the user's last market if it still has data here, else the curated market with the
 * most recent real trade on this network (read live), so a visitor never lands on an empty chart.
 * Links from the landing page and the docs point here.
 */
export default function TradeIndex() {
  const router = useRouter();
  const activity = useMarketActivity();
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 4000);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    // Live activity normally answers in well under a second; if it can't be read, use the fallback order.
    if (!activity.data && !waited) return;
    const m = defaultMarket(activity.data, NETWORK, Date.now(), readLastMarket());
    router.replace(`/app/trade/${m.ticker}${window.location.search}`);
  }, [activity.data, waited, router]);
  return (
    <div className="pg" aria-busy="true">
      <div className="panel pb col" style={{ gap: 12 }}>
        <span className="small t2">Opening the market with the latest trades…</span>
        <span className="sk" style={{ width: '40%', height: 22 }} />
        <span className="skb" style={{ height: 320 }} />
      </div>
    </div>
  );
}
