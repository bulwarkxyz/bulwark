'use client';

import { BUILDER_ADDRESS, BUILDER_APPROVE_MAX_RATE, BUILDER_FEE_TENTHS_BPS } from '@bulwarkxyz/config';
import type { Hex } from '@bulwarkxyz/hyperliquid';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTheme } from 'next-themes';
import { useState } from 'react';
import { useAccount, useChainId, useSignTypedData } from 'wagmi';
import { DisconnectButton } from '@/components/app/connect';
import { Icon } from '@/components/app/icons';
import { GuardKeyCard, KEY_STORAGE, KillSwitchCard, TradingKeyCard, guardKeyStatus, shownCustody } from '@/components/app/keys';
import { api, useMounted, useSignedIn } from '@/lib/api';
import { BUILDER_ON, NETWORK } from '@/lib/env';
import { info } from '@/lib/hl';
import { useMe } from '@/lib/me';
import { useReview, useViewer } from '@/lib/review';
import { approveBuilderFor, forgetTradingKey, sendUserSigned, tradingKey, type SignTypedData } from '@/lib/signing';
import { useTimes } from '@/lib/time';

/** Keys: one compact row each, with the full controls one click away. */
function KeysPanel() {
  const me = useMe();
  const review = useReview();
  const { address } = useAccount();
  const [open, setOpen] = useState<null | 'guard' | 'trading'>(null);
  const [, bump] = useState(0);
  const custody = shownCustody(me.data);
  const key = address ? tradingKey(address) : null;
  const agents = useQuery({ queryKey: ['agents', NETWORK, address], enabled: Boolean(address), queryFn: () => info.extraAgents(address as Hex) as Promise<Array<{ address: string }>> });
  const tkApproved = Boolean(key && agents.data?.some((a) => a.address.toLowerCase() === key.address));
  const toggle = (k: 'guard' | 'trading') => setOpen(open === k ? null : k);
  return (
    <section className="panel" aria-labelledby="keys-h">
      <div className="ph">
        <h2 id="keys-h">Keys</h2>
      </div>
      <div className="pb col" style={{ gap: 0 }}>
        <div className="kv line krow">
          <span className="small">Guard key</span>
          <span className="row nw" style={{ gap: 8 }}>
            <span className="small t2">{custody && me.data?.agent ? `${KEY_STORAGE[custody]} · ` : ''}{guardKeyStatus(me.data)}</span>
            <button type="button" className="btn btn-sm" aria-expanded={open === 'guard'} onClick={() => toggle('guard')} disabled={!me.data?.user}>
              {open === 'guard' ? 'Close' : me.data?.agent ? 'Manage' : 'Set up'}
            </button>
          </span>
        </div>
        {open === 'guard' ? (
          <div className="kexp">
            <GuardKeyCard variant="bare" />
          </div>
        ) : null}
        <div className="kv line krow">
          <span className="small">Trading key</span>
          <span className="row nw" style={{ gap: 8 }}>
            <span className="small t2">{review.on ? 'this browser · example' : key ? `this browser · ${tkApproved ? 'approved' : 'not approved'}` : 'none'}</span>
            {key && tkApproved && !review.on ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  if (address) forgetTradingKey(address);
                  bump((n) => n + 1);
                }}
              >
                Forget
              </button>
            ) : (
              <button type="button" className="btn btn-sm" aria-expanded={open === 'trading'} onClick={() => toggle('trading')} disabled={!address}>
                {open === 'trading' ? 'Close' : 'Set up'}
              </button>
            )}
          </span>
        </div>
        {open === 'trading' ? (
          <div className="kexp">
            <TradingKeyCard variant="bare" />
          </div>
        ) : null}
        <div className="disclose" style={{ marginTop: 10 }}>
          {Icon.shield(14)}
          <span>
            <b>Reduce-only is enforced by our engine, not by Hyperliquid.</b> The guard key cannot withdraw. Forgetting the trading key deletes it from this browser; its approval on Hyperliquid stays until it expires, with no key left to sign.
          </span>
        </div>
      </div>
    </section>
  );
}

function AlertsPanel() {
  const me = useMe();
  const [code, setCode] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const linked = Boolean(me.data?.user?.telegramChatId);
  return (
    <section className="panel" aria-labelledby="alerts-h">
      <div className="ph">
        <h2 id="alerts-h">Alerts</h2>
      </div>
      <div className="pb col" style={{ gap: 0 }}>
        <div className="kv line krow">
          <span className="small">Telegram</span>
          <span className="row nw" style={{ gap: 8 }}>
            <span className="small t2">{linked ? 'linked' : 'not linked'}</span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!me.data?.user}
              onClick={() =>
                api<{ code: string }>('/v1/telegram/code', { method: 'POST', body: {} })
                  .then((r) => setCode(r.code))
                  .catch((e: Error) => setErr(e.message))
              }
            >
              {linked ? 'Link another chat' : 'Get a link code'}
            </button>
          </span>
        </div>
        {code ? (
          <div className="code" style={{ margin: '10px 0' }}>
            Send <b>/link {code}</b> to the Bulwark bot <span className="t3">· valid 15 minutes</span>
          </div>
        ) : null}
        {err ? <span className="small ct">{err}</span> : null}
        <span className="tiny t3" style={{ marginTop: 10 }}>
          Alerts fire on your alert rules and on every guard action.
        </span>
      </div>
    </section>
  );
}

function FeePanel() {
  const me = useMe();
  const qc = useQueryClient();
  const chainId = useChainId();
  const { signTypedDataAsync } = useSignTypedData();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const approvedMax = me.data?.builder.approvedMaxTenthsBps ?? 0;
  const ok = approvedMax >= BUILDER_FEE_TENTHS_BPS;
  async function approve(rate: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await sendUserSigned(signTypedDataAsync as unknown as SignTypedData, approveBuilderFor(chainId, BUILDER_ADDRESS, rate));
      if (!res.ok) throw new Error(res.error);
      setMsg({ ok: true, text: rate === '0%' ? 'Approval lowered to zero. Orders through Bulwark now need a new approval.' : 'Fee approved.' });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-labelledby="fee-h">
      <div className="ph">
        <h2 id="fee-h">Bulwark fee</h2>
        {NETWORK === 'testnet' ? <span className="tag tag-net">testnet path</span> : null}
      </div>
      <div className="pb col" style={{ gap: 0 }}>
        <div className="kv line">
          <span className="small">Fee</span>
          <span className="small num">
            {(BUILDER_FEE_TENTHS_BPS / 1000).toFixed(2)}% · {BUILDER_FEE_TENTHS_BPS / 10} bps on every order
          </span>
        </div>
        <div className="kv">
          <span className="small">Your approval</span>
          <span className="small">
            {ok ? (
              <>
                up to {(approvedMax / 1000).toFixed(2)}% ·{' '}
                <button type="button" className="linkbtn" disabled={busy} onClick={() => approve('0%')}>
                  Revoke
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-sm btn-ink" disabled={busy || !me.data?.user} onClick={() => approve(BUILDER_APPROVE_MAX_RATE)}>
                {busy ? 'Waiting for signature…' : `Approve up to ${BUILDER_APPROVE_MAX_RATE}`}
              </button>
            )}
          </span>
        </div>
        {msg ? <span className={`small ${msg.ok ? '' : 'ct'}`}>{msg.text}</span> : null}
      </div>
    </section>
  );
}

function DisplayPanel() {
  const me = useMe();
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const times = useTimes();
  return (
    <section className="panel" aria-labelledby="pref-h">
      <div className="ph">
        <h2 id="pref-h">Display</h2>
      </div>
      <div className="pb col" style={{ gap: 10 }}>
        <div className="drow">
          <span className="small">Theme</span>
          <div className="seg" role="radiogroup" aria-label="Theme">
            {(['system', 'dark', 'light'] as const).map((t) => (
              <button key={t} type="button" role="radio" className={mounted && theme === t ? 'on' : ''} aria-checked={mounted && theme === t} onClick={() => setTheme(t)}>
                {t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="drow">
          <span className="small">Times</span>
          <div className="seg" role="radiogroup" aria-label="Times">
            {(['utc', 'local'] as const).map((z) => (
              <button key={z} type="button" role="radio" className={times.zone === z ? 'on' : ''} aria-checked={times.zone === z} onClick={() => times.setZone(z)}>
                {z === 'utc' ? 'UTC' : 'Local'}
              </button>
            ))}
          </div>
        </div>
        <div className="drow">
          <span className="small">Network</span>
          <span className="small">
            {NETWORK === 'mainnet' ? 'Hyperliquid mainnet' : 'Hyperliquid testnet'} {NETWORK === 'testnet' ? <span className="tag tag-net">testnet</span> : null}
          </span>
        </div>
        {me.data?.user ? (
          <div className="drow">
            <span className="small">Region</span>
            <span className="small">{me.data.user.region === 'allowed' ? 'Allowed · trading and guard' : 'Trading and alerts only'}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default function SettingsPage() {
  const review = useReview();
  const { connected } = useViewer();
  const signedIn = useSignedIn() || review.on;
  const me = useMe();
  const loading = connected && signedIn && !me.isFetched;

  return (
    <div className="pg">
      <div className="ptitle">
        <h1 className="h1">
          <span className="hide-sm">Settings</span>
          <span className="mobile-only">More</span>
        </h1>
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

      {/* Phones: the More tab lands here, so the screens without a tab of their own are listed first. */}
      <nav className="panel mobile-only" aria-label="More screens">
        <ul className="morelist">
          {[
            { href: '/app/account', label: 'Account', sub: 'pools, keys, fees' },
            { href: '/app/audit', label: 'Audit log', sub: 'every action, verified in your browser' },
            { href: '/app/simulator', label: 'Simulator', sub: 'test your rules' },
          ].map((l) => (
            <li key={l.href}>
              <Link href={l.href}>
                <span>{l.label}</span>
                <span className="small t3">{l.sub}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="grid2 even">
        {connected ? <KeysPanel /> : null}
        {connected ? <AlertsPanel /> : null}
        {connected && BUILDER_ON ? <FeePanel /> : null}
        <DisplayPanel />
      </div>
    </div>
  );
}
