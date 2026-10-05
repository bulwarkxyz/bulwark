'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton, useSignIn } from '@/components/app/connect';
import { fmtUsd } from '@/components/app/format';
import { BrandMark } from '@/components/app/icons';
import { NetworkBadge } from '@/components/app/network-badge';
import { BuilderCard, GuardKeyCard, TradingKeyCard } from '@/components/app/keys';
import { StageForm } from '@/components/app/stage-form';
import { api, ApiError } from '@/lib/api';
import { BUILDER_ON } from '@/lib/env';
import { useAccountView } from '@/lib/hl';
import { useMe } from '@/lib/me';

const STEPS = ['Connect', 'Region', 'Funds', 'Guard key', 'Trading key', ...(BUILDER_ON ? ['Fee'] : []), 'Rules'] as const;

function RegionStep() {
  const qc = useQueryClient();
  const [residency, setResidency] = useState('');
  const [citizenship, setCitizenship] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const valid = /^[A-Za-z]{2}$/.test(residency) && /^[A-Za-z]{2}$/.test(citizenship);
  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ verdict: string; guard: string }>('/v1/onboarding/attest', { body: { residency, citizenship } });
      setMsg({ ok: true, text: r.verdict === 'allowed' ? 'You can use the guard.' : 'In your region Bulwark offers trading and alerts; the guard stays off.' });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError && e.status === 403 ? 'Bulwark is not available where you live or for your citizenship.' : (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <span className="muted" style={{ fontSize: 13 }}>
        Bulwark is not offered in the US, Canada, the UK, Russia, Belarus or sanctioned regions. In the EU it offers trading and alerts only. We check your connection's country too and apply the strictest of the three.
      </span>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ width: 200 }}>
          <label htmlFor="res">Country you live in (2 letters)</label>
          <div className="input">
            <input id="res" maxLength={2} placeholder="e.g. IN" value={residency} onChange={(e) => setResidency(e.target.value.toUpperCase())} />
          </div>
        </div>
        <div className="field" style={{ width: 200 }}>
          <label htmlFor="cit">Citizenship (2 letters)</label>
          <div className="input">
            <input id="cit" maxLength={2} placeholder="e.g. IN" value={citizenship} onChange={(e) => setCitizenship(e.target.value.toUpperCase())} />
          </div>
        </div>
        <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
          {busy ? 'Checking…' : 'Confirm'}
        </button>
      </div>
      {msg ? <span className={msg.ok ? 'ok-text' : 'err'} style={{ fontSize: 13 }}>{msg.text}</span> : null}
    </div>
  );
}

export default function OnboardingPage() {
  const { address } = useAccount();
  const me = useMe();
  const view = useAccountView(address);
  const signIn = useSignIn();
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<number | null>(null);

  const done = [
    Boolean(address && me.data),
    Boolean(me.data?.user),
    Boolean(view.data && view.data.risk.accountValue > 0),
    Boolean(me.data?.agent?.approved) || me.data?.user?.region === 'guardOff',
    false, // the trading key is optional; the user moves on when ready
    ...(BUILDER_ON ? [(me.data?.builder.approvedMaxTenthsBps ?? 0) >= (me.data?.builder.feeTenthsBps ?? 1)] : []),
    Boolean(me.data?.policy),
  ];
  const firstOpen = done.findIndex((d) => !d);
  const current = step ?? (firstOpen === -1 ? STEPS.length - 1 : firstOpen);
  const name = STEPS[current]!;

  return (
    <div className="wrap" style={{ maxWidth: 760, paddingTop: 32, paddingBottom: 48 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 24 }}>
        <Link href="/app" className="brand" style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 650, fontSize: 16 }}>
          <BrandMark />
          Bulwark
        </Link>
        <span className="row" style={{ gap: 8 }}>
          <NetworkBadge />
          <ConnectButton />
        </span>
      </div>
      <h1 style={{ fontSize: 26, letterSpacing: '-.02em', margin: '0 0 6px' }}>Set up your guard</h1>
      <p className="muted" style={{ margin: '0 0 20px' }}>
        A few signatures, each one shown in your wallet. Nothing here moves your funds.
      </p>
      <ol className="steps" style={{ listStyle: 'none', padding: 0, margin: '0 0 24px' }}>
        {STEPS.map((s, i) => (
          <li key={s}>
            <button type="button" className={`step ${i === current ? 'on' : done[i] ? 'done' : ''}`} style={{ background: 'transparent', cursor: 'pointer', font: 'inherit' }} onClick={() => setStep(i)} aria-current={i === current ? 'step' : undefined}>
              <span className="dot">{done[i] ? '✓' : i + 1}</span>
              {s}
            </button>
          </li>
        ))}
      </ol>

      <section className="card">
        <div className="card-h">
          <h2>
            {current + 1}. {name}
          </h2>
        </div>
        <div className="card-b">
          {name === 'Connect' ? (
            <div className="stack">
              <span className="muted" style={{ fontSize: 13 }}>
                Connect the wallet you trade with on Hyperliquid, then sign in. Signing in proves you own the address and authorises nothing.
              </span>
              {!address ? (
                <ConnectButton />
              ) : !me.data ? (
                <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => signIn().catch((e: Error) => setErr(e.message))}>
                  Sign in
                </button>
              ) : (
                <span className="ok-text">Signed in.</span>
              )}
              {err ? <span className="err">{err}</span> : null}
            </div>
          ) : name === 'Region' ? (
            <RegionStep />
          ) : name === 'Funds' ? (
            <div className="stack">
              <span className="muted" style={{ fontSize: 13 }}>
                Bulwark trades from your own Hyperliquid account. Deposit USDC there the usual way; nothing is held by Bulwark.
              </span>
              <div className="kv">
                <span>Account value on Hyperliquid</span>
                <span className="num">{view.data ? fmtUsd(view.data.risk.accountValue) : '—'}</span>
              </div>
              <div className="kv">
                <span>Account mode</span>
                <span>{view.data ? (view.data.risk.mode === 'unified' ? 'Unified' : view.data.risk.mode === 'standard' ? 'Standard' : 'Portfolio margin (read-only)') : '—'}</span>
              </div>
            </div>
          ) : name === 'Guard key' ? (
            <GuardKeyCard />
          ) : name === 'Trading key' ? (
            <TradingKeyCard />
          ) : name === 'Fee' ? (
            <BuilderCard />
          ) : (
            <StageForm />
          )}
        </div>
      </section>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 16 }}>
        <button type="button" className="btn btn-sm btn-ghost" disabled={current === 0} onClick={() => setStep(Math.max(0, current - 1))}>
          Back
        </button>
        {current < STEPS.length - 1 ? (
          <button type="button" className="btn btn-sm" onClick={() => setStep(current + 1)}>
            Next
          </button>
        ) : (
          <Link className="btn btn-sm" href="/app/positions">
            Go to positions
          </Link>
        )}
      </div>
    </div>
  );
}
