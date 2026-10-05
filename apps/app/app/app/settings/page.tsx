'use client';

import Link from 'next/link';
import { useTheme } from 'next-themes';
import { DisconnectButton } from '@/components/app/connect';
import { Icon } from '@/components/app/icons';
import { BuilderCard, GuardKeyCard, KillSwitchCard, TelegramCard, TradingKeyCard } from '@/components/app/keys';
import { useMounted, useSignedIn } from '@/lib/api';
import { BUILDER_ON, NETWORK } from '@/lib/env';
import { useMe } from '@/lib/me';
import { useReview, useViewer } from '@/lib/review';

export default function SettingsPage() {
  const review = useReview();
  const { connected } = useViewer();
  const signedIn = useSignedIn() || review.on;
  const me = useMe();
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const loading = connected && signedIn && !me.isFetched;

  return (
    <div className="pg">
      <div className="ptitle">
        <h1 className="h1">Settings</h1>
        <span className="sp" />
        <DisconnectButton />
      </div>

      {me.isError ? (
        <div className="banner b-crit">
          {Icon.alert()}
          <span>
            <b>Can’t reach Bulwark’s server.</b> The guard keeps running with your signed rules. Changes here need the server; try again shortly.
          </span>
        </div>
      ) : null}
      {!connected ? (
        <div className="banner">
          <span>Display settings work without a wallet. Guard settings need one: connect and sign in.</span>
        </div>
      ) : !signedIn ? (
        <div className="banner">
          <span>Sign in (top right) to load your guard settings.</span>
        </div>
      ) : me.data && !me.data.user ? (
        <div className="banner">
          <span>
            You have not finished setting up. <Link href="/app/onboarding" style={{ textDecoration: 'underline' }}>Continue setup</Link>
          </span>
        </div>
      ) : null}

      {loading ? (
        <div className="panel pb col" style={{ gap: 12 }}>
          <span className="sk" style={{ width: '40%' }} />
          <span className="sk" style={{ width: '80%' }} />
        </div>
      ) : connected ? (
        <KillSwitchCard preview={review.state === 'loading' ? 'busy' : review.state === 'error' ? 'error' : undefined} />
      ) : null}

      <div className="grid2 even">
        {connected ? (
          <>
            <GuardKeyCard />
            <TradingKeyCard />
            {BUILDER_ON ? <BuilderCard /> : null}
            <TelegramCard />
          </>
        ) : null}
        <section className="panel" aria-labelledby="pref-h">
          <div className="ph">
            <h2 id="pref-h">Display and network</h2>
          </div>
          <div className="pb col" style={{ gap: 12 }}>
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
            <div className="kv line">
              <span className="small">Times</span>
              <span className="small">UTC everywhere</span>
            </div>
            <div className="kv line">
              <span className="small">Network</span>
              <span className="small">
                {NETWORK === 'mainnet' ? 'Hyperliquid mainnet' : 'Hyperliquid testnet'} {NETWORK === 'testnet' ? <span className="tag tag-net">testnet</span> : null}
              </span>
            </div>
            {me.data?.user ? (
              <div className="kv">
                <span className="small">Region</span>
                <span className="small">{me.data.user.region === 'allowed' ? 'Trading and the guard' : 'Trading and alerts only'}</span>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
