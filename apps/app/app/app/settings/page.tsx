'use client';

import Link from 'next/link';
import { useTheme } from 'next-themes';
import { useAccount } from 'wagmi';
import { BuilderCard, GuardKeyCard, KillSwitchCard, TelegramCard, TradingKeyCard } from '@/components/app/keys';
import { TopBar } from '@/components/app/shell';
import { useMounted } from '@/lib/api';
import { NETWORK } from '@/lib/env';
import { useMe } from '@/lib/me';

export default function SettingsPage() {
  const { address } = useAccount();
  const me = useMe();
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  return (
    <>
      <TopBar title="Settings" />
      <div className="content">
        {!address ? <div className="callout">Connect a wallet and sign in to change settings.</div> : null}
        {address && !me.data ? <div className="callout">Sign in (top right) to load your settings.</div> : null}
        {me.data && !me.data.user ? (
          <div className="callout guard">
            <span>
              You have not finished setting up.{' '}
              <Link className="link" href="/app/onboarding">
                Continue onboarding
              </Link>
            </span>
          </div>
        ) : null}
        <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))', alignItems: 'start' }}>
          <KillSwitchCard />
          <GuardKeyCard />
          <TradingKeyCard />
          <BuilderCard />
          <TelegramCard />
          <section className="card" aria-labelledby="pref-h">
            <div className="card-h">
              <h2 id="pref-h">Display and network</h2>
            </div>
            <div className="card-b stack">
              <div className="field">
                <label>Theme</label>
                <div className="seg" role="radiogroup" aria-label="Theme">
                  {(['dark', 'light', 'system'] as const).map((t) => (
                    <button key={t} type="button" className={mounted && theme === t ? 'on' : ''} aria-pressed={mounted && theme === t} onClick={() => setTheme(t)}>
                      {t[0]!.toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="kv">
                <span>Network</span>
                <span className="num">{NETWORK === 'mainnet' ? 'Hyperliquid mainnet' : 'Hyperliquid testnet'}</span>
              </div>
              {me.data?.user ? (
                <div className="kv">
                  <span>Region status</span>
                  <span>{me.data.user.region === 'allowed' ? 'Guard available' : 'Trading and alerts only'}</span>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
