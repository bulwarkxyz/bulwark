'use client';

import { describeRule } from '@bulwarkxyz/compiler';
import type { Policy, Rule } from '@bulwarkxyz/guard-core';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useAccount, useChainId, useSignTypedData } from 'wagmi';
import { StageForm } from '@/components/app/stage-form';
import { TopBar } from '@/components/app/shell';
import { api, ApiError, useSignedIn } from '@/lib/api';
import { useMe } from '@/lib/me';
import { signPolicy, type SignTypedData } from '@/lib/signing';

type DraftReply =
  | { kind: 'draft'; rule: Rule; description: string; provenance: Array<{ path: string; value: number; typed: number }>; policy: Policy }
  | { kind: 'clarify'; question: string }
  | { kind: 'refuse'; reason: string }
  | { kind: 'rejected'; violations: string[] };

function Translator() {
  const me = useMe();
  const qc = useQueryClient();
  const chainId = useChainId();
  const { signTypedDataAsync } = useSignTypedData();
  const [text, setText] = useState('');
  const [reply, setReply] = useState<DraftReply | null>(null);
  const [busy, setBusy] = useState<'translate' | 'sign' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function translate() {
    setBusy('translate');
    setErr(null);
    setReply(null);
    setDone(null);
    try {
      setReply(await api<DraftReply>('/v1/rules/draft', { body: { text } }));
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 503 ? 'The AI translator is not switched on yet. You can still write rules with the stage editor below.' : (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function sign() {
    if (reply?.kind !== 'draft') return;
    setBusy('sign');
    setErr(null);
    try {
      const signature = await signPolicy(signTypedDataAsync as unknown as SignTypedData, chainId, reply.policy);
      await api('/v1/policy', { body: { policy: reply.policy, signature, chainId } });
      await qc.invalidateQueries({ queryKey: ['me'] });
      setDone(`Added. Policy v${reply.policy.version} is now running.`);
      setReply(null);
      setText('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" aria-labelledby="ai-h">
      <div className="card-h">
        <h2 id="ai-h">Add a rule in your own words</h2>
        <span className="chip" style={{ marginLeft: 'auto' }}>
          AI translator
        </span>
      </div>
      <div className="card-b stack">
        <span className="muted" style={{ fontSize: 13 }}>
          An AI model (Claude) turns your sentence into a rule. It only uses numbers you type, it can only add protection, and you sign the result before it runs. It never suggests limits.
        </span>
        <textarea className="area" aria-label="Your rule" placeholder="Describe one rule, with your own numbers" maxLength={500} value={text} onChange={(e) => setText(e.target.value)} disabled={!me.data?.policy} />
        <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={!text.trim() || busy !== null || !me.data?.policy} onClick={translate}>
          {busy === 'translate' ? 'Translating…' : 'Translate'}
        </button>
        {!me.data?.policy ? <span className="faint" style={{ fontSize: 12 }}>Sign your stages and slippage limit first (below); the translator adds to them.</span> : null}

        {reply?.kind === 'draft' ? (
          <div className="callout guard" style={{ flexDirection: 'column', gap: 10 }}>
            <b style={{ color: 'var(--guard-text)' }}>{reply.description}</b>
            <div className="row" style={{ gap: 6 }}>
              {reply.provenance.map((p) => (
                <span key={p.path} className="pill-k num" title={p.path}>
                  {p.value} · you typed {p.typed}
                </span>
              ))}
            </div>
            <span className="faint" style={{ fontSize: 12 }}>
              Your existing rules and limits stay as they are. This becomes policy v{reply.policy.version}.
            </span>
            <div className="row">
              <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={sign}>
                {busy === 'sign' ? 'Waiting for signature…' : 'Sign and add'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setReply(null)}>
                Discard
              </button>
            </div>
          </div>
        ) : reply?.kind === 'clarify' ? (
          <div className="callout">
            <span>
              <b>Needs one more detail.</b> {reply.question} Edit your sentence and translate again.
            </span>
          </div>
        ) : reply?.kind === 'refuse' ? (
          <div className="callout warn">
            <span>
              <b>Not a guard rule.</b> {reply.reason}
            </span>
          </div>
        ) : reply?.kind === 'rejected' ? (
          <div className="callout crit" style={{ flexDirection: 'column', gap: 6 }}>
            <b>The draft failed the safety checks, so it was not used.</b>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {reply.violations.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
            <span style={{ fontSize: 12 }}>Write the number you want into your sentence and try again.</span>
          </div>
        ) : null}
        {err ? <span className="err" style={{ fontSize: 13 }}>{err}</span> : null}
        {done ? <span className="ok-text" style={{ fontSize: 13 }}>{done}</span> : null}
      </div>
    </section>
  );
}

export default function RulesPage() {
  const { address } = useAccount();
  const signedIn = useSignedIn();
  const me = useMe();
  const policy = me.data?.policy;

  return (
    <>
      <TopBar title="Guard rules">
        {policy ? (
          <span className="chip chip-guard">
            <i />
            Policy v{policy.version} · signed {new Date(policy.confirmedAt).toISOString().slice(0, 10)}
          </span>
        ) : null}
      </TopBar>
      <div className="content">
        {!address || !signedIn ? <div className="callout">Connect a wallet and sign in to see and change your rules.</div> : null}
        {me.data && !me.data.user ? (
          <div className="callout guard">
            <span>
              Finish setting up first.{' '}
              <Link className="link" href="/app/onboarding">
                Continue onboarding
              </Link>
            </span>
          </div>
        ) : null}

        <section className="card" aria-labelledby="cur-h">
          <div className="card-h">
            <h2 id="cur-h">Running now</h2>
            {policy ? (
              <span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>
                Guard trades at most {policy.policy.execution.maxSlippagePct}% from the mark
              </span>
            ) : null}
          </div>
          <div className="card-b">
            {policy?.policy.rules.length ? (
              policy.policy.rules.map((r, i) => (
                <div key={r.id} className="stage armed">
                  <span className="n">{i + 1}</span>
                  <div className="stack" style={{ gap: 4 }}>
                    <span>{describeRule(r)}</span>
                    {r.source ? (
                      <span className="faint" style={{ fontSize: 12 }}>
                        From your words: “{r.source.text}”
                      </span>
                    ) : null}
                  </div>
                  <span className="pill-k num">{r.id}</span>
                </div>
              ))
            ) : (
              <span className="faint">No rules yet.</span>
            )}
          </div>
        </section>

        <Translator />

        <section className="card" aria-labelledby="stages-h">
          <div className="card-h">
            <h2 id="stages-h">Buffer stages</h2>
            <span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>
              Editing here can loosen limits; you sign every change
            </span>
          </div>
          <div className="card-b">{me.isFetched ? <StageForm key={policy?.version ?? 0} /> : <div className="skeleton" style={{ height: 120 }} />}</div>
        </section>
      </div>
    </>
  );
}
