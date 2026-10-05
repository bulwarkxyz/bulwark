'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ConnectButton, useSignIn } from '@/components/app/connect';
import { fmtUsd } from '@/components/app/format';
import { Icon } from '@/components/app/icons';
import { BuilderCard, GuardKeyCard, KEY_STORAGE, TradingKeyCard, shownCustody } from '@/components/app/keys';
import { ActiveRules, HowGuardTrades, RuleBuilder, usePolicyDraft } from '@/components/app/rules-editor';
import { shortAddr } from '@/components/app/format';
import { api, ApiError, useSignedIn } from '@/lib/api';
import { BUILDER_ON, NETWORK } from '@/lib/env';
import { useNow } from '@/lib/guard';
import { useAccountView } from '@/lib/hl';
import { MARKETS, homeOpen } from '@/lib/markets';
import { useMe } from '@/lib/me';
import { useReview, useViewer } from '@/lib/review';

const STEPS = [
  { name: 'Connect your wallet', sub: 'Sign in proves you own the address. It authorises nothing.' },
  { name: 'Region check', sub: 'Trading and the guard, or trading and alerts in the EU.' },
  { name: 'Funds on Hyperliquid', sub: 'Your USDC stays in your own Hyperliquid account.' },
  { name: 'Approve the guard key', sub: 'The key that acts on your rules. It cannot withdraw.' },
  { name: 'Create your trading key', sub: 'Lives in this browser and signs your own orders.' },
  ...(BUILDER_ON ? [{ name: 'Approve the Bulwark fee', sub: 'A cap you approve; you can lower it to zero.' }] : []),
  { name: 'Write your first rules', sub: 'Your own lines, in your own numbers.' },
];

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
    <div className="col" style={{ gap: 12 }}>
      <span className="small t2">Bulwark is not offered in the US, Canada, the UK, Russia, Belarus or sanctioned regions. In the EU it offers trading and alerts only. We also check your connection’s country and apply the strictest of the three.</span>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ width: 200 }}>
          <label htmlFor="res">Country you live in (2 letters)</label>
          <div className="input">
            <input id="res" maxLength={2} placeholder="Two letters" value={residency} onChange={(e) => setResidency(e.target.value.toUpperCase())} />
          </div>
        </div>
        <div className="field" style={{ width: 200 }}>
          <label htmlFor="cit">Citizenship (2 letters)</label>
          <div className="input">
            <input id="cit" maxLength={2} placeholder="Two letters" value={citizenship} onChange={(e) => setCitizenship(e.target.value.toUpperCase())} />
          </div>
        </div>
        <button type="button" className="btn btn-ink" disabled={!valid || busy} onClick={submit}>
          {busy ? 'Checking…' : 'Confirm'}
        </button>
      </div>
      {msg ? <span className={`small ${msg.ok ? '' : 'ct'}`}>{msg.text}</span> : null}
    </div>
  );
}

export default function OnboardingPage() {
  const review = useReview();
  const { address, connected } = useViewer();
  const me = useMe();
  const signedIn = useSignedIn() || review.on;
  const view = useAccountView(address);
  const signIn = useSignIn();
  const now = useNow();
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<number | null>(null);
  // Deep link to a step: /app/onboarding?step=4 (1-based).
  useEffect(() => {
    const n = Number(new URLSearchParams(window.location.search).get('step'));
    if (n >= 1 && n <= STEPS.length) setStep(n - 1);
  }, []);

  const funded = Boolean(view.data && view.data.risk.accountValue > 0) && review.state !== 'empty';
  const done = [
    Boolean(connected && signedIn && me.data),
    Boolean(me.data?.user),
    funded,
    Boolean(me.data?.agent?.approved) || me.data?.user?.region === 'guardOff',
    false, // the trading key is optional; the user moves on when ready
    ...(BUILDER_ON ? [(me.data?.builder.approvedMaxTenthsBps ?? 0) >= (me.data?.builder.feeTenthsBps ?? 1)] : []),
    Boolean(me.data?.policy),
  ];
  const custody = shownCustody(me.data);
  // What each finished step settled, in the list (the board's second line).
  const settled = [
    address ? `${shortAddr(address)} · signed in` : null,
    me.data?.user ? (me.data.user.region === 'allowed' ? 'Allowed: trading and the guard' : 'Trading and alerts only in your region') : null,
    funded && view.data ? `${fmtUsd(view.data.risk.accountValue)} USDC${review.on ? ' (example account)' : ''}` : null,
    me.data?.agent?.approved && custody ? `An agent key in ${KEY_STORAGE[custody].replace(', hardware-backed', '')} that can only reduce` : null,
    null,
    ...(BUILDER_ON ? [done[5] ? 'Approved' : null] : []),
    me.data?.policy ? `Version ${me.data.policy.version} signed` : null,
  ];
  const draft = usePolicyDraft();
  const held = (view.data?.risk.pools ?? []).flatMap((p) => p.positions.map((r) => r.position.coin));
  const firstOpen = done.findIndex((d) => !d);
  const current = step ?? (firstOpen === -1 ? STEPS.length - 1 : firstOpen);
  const name = STEPS[current]!.name;
  const loading = review.state === 'loading' || (connected && signedIn && !me.isFetched);
  const anyClosed = MARKETS.some((m) => !homeOpen(m.session, now));

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="pb col" style={{ gap: 12 }}>
        <span className="sk" style={{ width: '70%' }} />
        <span className="sk" style={{ width: '90%' }} />
        <span className="sk" style={{ width: '40%', height: 36 }} />
      </div>
    );
  } else if (name === 'Connect your wallet') {
    body = (
      <div className="pb col" style={{ gap: 12 }}>
        <span className="small t2">Connect the wallet you trade with on Hyperliquid, then sign in. Signing in proves you own the address and authorises nothing.</span>
        <div className="row">
          {!connected ? (
            <ConnectButton />
          ) : !signedIn || !me.data ? (
            <button type="button" className="btn btn-ink" onClick={() => signIn().catch((e: Error) => setErr(e.message))}>
              Sign in
            </button>
          ) : (
            <span className="small">Signed in.</span>
          )}
        </div>
        {err ? <span className="small ct">{err}</span> : null}
      </div>
    );
  } else if (name === 'Region check') {
    body = (
      <div className="pb">
        <RegionStep />
      </div>
    );
  } else if (name === 'Funds on Hyperliquid') {
    body = (
      <div className="pb col" style={{ gap: 12 }}>
        {funded ? (
          <>
            <span className="small t2">Bulwark trades from your own Hyperliquid account. Nothing is held by Bulwark.</span>
            <div className="kv line">
              <span>Account value on Hyperliquid</span>
              <span className="num">{fmtUsd(view.data!.risk.accountValue)}</span>
            </div>
            <div className="kv">
              <span>Account mode</span>
              <span>{view.data!.risk.mode === 'unified' ? 'Unified' : view.data!.risk.mode === 'standard' ? 'Standard' : 'Portfolio margin (read-only)'}</span>
            </div>
          </>
        ) : (
          <>
            <div className="empty" style={{ padding: '20px 0', alignItems: 'flex-start', textAlign: 'left' }}>
              <b>No USDC in your Hyperliquid account yet.</b>
              <span className="small">Hyperliquid accepts key approvals only after a first deposit, so this comes before the guard key. Deposit USDC on Hyperliquid the usual way; it stays in your own account.{NETWORK === 'testnet' ? ' On testnet, claim test USDC from Hyperliquid’s faucet.' : ''}</span>
            </div>
            <div className="row">
              <a className="btn btn-ink" href={NETWORK === 'testnet' ? 'https://app.hyperliquid-testnet.xyz/drip' : 'https://app.hyperliquid.xyz/trade'} target="_blank" rel="noreferrer">
                {NETWORK === 'testnet' ? 'Open Hyperliquid’s faucet' : 'Deposit on Hyperliquid'}
              </a>
              <button type="button" className="btn" onClick={() => view.refetch()}>
                I’ve deposited, check again
              </button>
            </div>
          </>
        )}
      </div>
    );
  } else if (name === 'Approve the guard key') {
    body = (
      <div className="pb col" style={{ gap: 12 }}>
        <span className="small t2">
          Bulwark’s guard key is created for you{custody === 'kms' ? ' in AWS KMS' : custody === 'sealed' ? ' on Bulwark’s signing service' : ''} and approved on Hyperliquid as your agent. It is the key that acts when your rules say so.
        </span>
        <div className="grid2 even" style={{ gap: 12 }}>
          <div className="panel pb" style={{ background: 'var(--s2)' }}>
            <b className="small">It can</b>
            <ul className="small t2" style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
              <li>send reduce-only orders</li>
              <li>move the USDC you typed in a top-up rule</li>
              <li>cancel its own orders</li>
            </ul>
          </div>
          <div className="panel pb" style={{ background: 'var(--s2)' }}>
            <b className="small">It cannot</b>
            <ul className="small t2" style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
              <li>withdraw anything (Hyperliquid’s rule for agent keys)</li>
              <li>open or add to a position (our engine’s rule)</li>
              <li>touch your own orders (our engine’s rule)</li>
            </ul>
          </div>
        </div>
        {review.state === 'error' ? (
          <div className="banner b-crit">
            {Icon.alert()}
            <span>
              <b>Hyperliquid rejected the approval.</b> It said the account has no deposit yet. Hyperliquid accepts key approvals only after a first deposit. Check step 3, then try again.
            </span>
          </div>
        ) : null}
        <div className="disclose">
          {Icon.shield(14)}
          <span>
            Hyperliquid lets an agent key sign any order. <b>Reduce-only is enforced by our engine, not by Hyperliquid. The guard key cannot withdraw</b>: Hyperliquid agent keys can’t move funds out.
          </span>
        </div>
        <GuardKeyCard variant="bare" setup />
      </div>
    );
  } else if (name === 'Create your trading key') {
    body = (
      <div className="pb col" style={{ gap: 12 }}>
        <TradingKeyCard variant="bare" />
        <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setStep(current + 1)}>
          Skip for now: I’ll sign each order in my wallet
        </button>
      </div>
    );
  } else if (name === 'Approve the Bulwark fee') {
    body = (
      <div className="pb">
        <BuilderCard variant="bare" />
      </div>
    );
  } else {
    body = (
      <div className="pb col" style={{ gap: 16 }}>
        {anyClosed ? (
          <div className="banner">
            {Icon.moon()}
            <span>Home markets are closed now. Rules you sign start watching at once, on trade.xyz’s off-hours prices.</span>
          </div>
        ) : null}
        {me.data?.policy ? (
          <span className="small">
            Your rules are signed (version {me.data.policy.version}). Add more in your own words on <Link href="/app/rules" style={{ textDecoration: 'underline' }}>Guard rules</Link>, where the AI translator turns a sentence into a rule.
          </span>
        ) : (
          <>
            <span className="small t2">
              What should the guard do, and when? Build your first rule with your own numbers, set how far from the mark the guard may trade, then sign. The AI translator, for rules in your own words, opens once this first version is signed.
            </span>
            <RuleBuilder s={draft} held={held} disabled={!connected} bare />
            <HowGuardTrades s={draft} bare />
            <ActiveRules s={draft} status={() => ({ text: 'Not active until you sign', cls: 'wt' })} loading={false} bare title="Your first rules" />
            {draft.changes.any ? (
              <button type="button" className="btn btn-ink btn-lg mobile-only" disabled={!draft.next.ok || draft.busy} onClick={draft.sign}>
                {draft.busy ? 'Waiting for signature…' : `Sign version ${draft.signedVersion + 1}`}
              </button>
            ) : null}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="pg" style={{ maxWidth: 1240 }}>
      <div className="grid2 lead400">
        <div className="mobile-only col" style={{ gap: 8 }}>
          <h1 className="h1">{name}</h1>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${STEPS.length}, minmax(0,1fr))`, gap: 4 }} aria-hidden="true">
            {STEPS.map((s, i) => (
              <span key={s.name} style={{ height: 4, borderRadius: 2, background: done[i] ? 'var(--ink)' : i === current ? 'var(--text-2)' : 'var(--s3)' }} />
            ))}
          </div>
          <span className="small t2">
            Step {current + 1} of {STEPS.length}. Each step is signed in your wallet; nothing here moves your funds.
          </span>
        </div>
        <section aria-label="Steps" className="hide-sm">
          <h1 className="h1" style={{ marginBottom: 4 }}>
            Set up Bulwark
          </h1>
          <p className="small t2" style={{ margin: '0 0 8px' }}>
            {STEPS.length === 7 ? 'Seven' : 'Six'} steps. You can trade after step 5; the guard arms after step {STEPS.length}. Each is signed in your wallet, and nothing here moves your funds.
          </p>
          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={s.name}>
                <button type="button" className="step" onClick={() => setStep(i)} aria-current={i === current ? 'step' : undefined}>
                  <span className={`n ${done[i] ? 'done' : i === current ? 'cur' : ''}`}>{done[i] ? Icon.check() : i + 1}</span>
                  <span className="col" style={{ gap: 2 }}>
                    <b className={done[i] || i === current ? '' : 't2'}>{s.name}</b>
                    <span className="small t2">{settled[i] ?? s.sub}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
        <section className="panel" aria-label="Current step" style={{ marginTop: 8 }}>
          <div className="ph hide-sm">
            <h2>
              Step {current + 1} · {name}
            </h2>
            <span className="sp" />
            <span className="tiny t3">
              {current + 1} of {STEPS.length}
            </span>
          </div>
          <div className="obody">{body}</div>
          {done[current] ? (
            <div className="row" style={{ padding: '0 12px 12px' }}>
              {current < STEPS.length - 1 ? (
                <button type="button" className="btn btn-sm" onClick={() => setStep(firstOpen === -1 ? current + 1 : Math.max(firstOpen, current + 1))}>
                  Continue to step {(firstOpen === -1 ? current + 1 : Math.max(firstOpen, current + 1)) + 1}
                </button>
              ) : (
                <Link className="btn btn-sm btn-ink" href="/app/positions">
                  Go to positions
                </Link>
              )}
            </div>
          ) : null}
          <ul className="mobile-only checklist" aria-label="Done so far">
            {STEPS.map((st, i) =>
              done[i] && i !== current ? (
                <li key={st.name}>
                  <span className="n done">{Icon.check()}</span>
                  {settled[i] ?? st.name}
                </li>
              ) : null,
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}
