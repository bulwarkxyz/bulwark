'use client';

import type { Policy, Rule } from '@bulwarkxyz/guard-core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSignTypedData } from 'wagmi';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/me';
import { signPolicy, type SignTypedData } from '@/lib/signing';
import { Icon } from './icons';
import type { PolicyDraftState } from './rules-editor';
import { useWalletChainId } from '@/lib/wallet';
import { walletErrorText } from '@/lib/wallet-errors';

type DraftReply =
  | { kind: 'draft'; rule: Rule; description: string; provenance: Array<{ path: string; value: number; typed: number }>; policy: Policy }
  | { kind: 'clarify'; question: string }
  | { kind: 'refuse'; reason: string }
  | { kind: 'rejected'; violations: string[] };

/**
 * "Write a rule in your own words": the AI translator (POST /v1/rules/draft). With a signed policy the draft
 * adds one rule to it; for a first policy the user types their slippage limit here and the draft is
 * version 1 (apps/api/CONTRACT.md). The provider's name comes from /v1/me, never from this file.
 */
export function Translator({ forced, s, bare }: { forced: 'loading' | 'error' | null; s: PolicyDraftState; bare?: boolean }) {
  const qc = useQueryClient();
  const chainId = useWalletChainId();
  const { signTypedDataAsync } = useSignTypedData();
  const [text, setText] = useState('');
  const [reply, setReply] = useState<DraftReply | null>(null);
  const [busy, setBusy] = useState<'translate' | 'sign' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const me = useMe();
  const provider = me.data?.translator?.provider ?? null;
  // Off only when the API says so; an older API that doesn't report it is treated as on (it answers 503 if not).
  const enabled = me.data?.translator?.enabled !== false;
  const first = !me.data?.policy;
  const slip = Number(s.draft.slippage);
  const slipOk = s.draft.slippage.trim() !== '' && slip > 0 && slip <= 10;

  async function translate() {
    setBusy('translate');
    setErr(null);
    setReply(null);
    setDone(null);
    try {
      setReply(await api<DraftReply>('/v1/rules/draft', { body: first ? { text, maxSlippagePct: slip } : { text } }));
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 503 ? 'The AI translator is not switched on yet. You can still build rules by hand.' : walletErrorText(e));
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
      setDone(reply.policy.version === 1 ? 'Signed. Your first rules are running: the guard is armed.' : `Added. Version ${reply.policy.version} is now running.`);
      setReply(null);
      setText('');
    } catch (e) {
      setErr(walletErrorText(e));
    } finally {
      setBusy(null);
    }
  }

  const translating = forced === 'loading' || busy === 'translate';
  return (
    <section className={bare ? 'col' : 'panel'} aria-labelledby="ai-h" style={bare ? { gap: 12 } : undefined}>
      <div className={bare ? 'row' : 'ph'} style={bare ? { alignItems: 'center' } : undefined}>
        <h2 id="ai-h" style={bare ? { margin: 0, fontSize: 14, fontWeight: 620 } : undefined}>Write a rule in your own words</h2>
        <span className="tag">{provider ? `AI translator · ${provider}` : 'AI translator'}</span>
        <span className="sp" />
        <span className="tiny t3">30 translations an hour</span>
      </div>
      <div className={bare ? 'col' : 'pb col'} style={{ gap: 12 }}>
        <label className="small t2" htmlFor="rule-text">
          What should the guard do, and when? Use your own numbers.
        </label>
        <span className="tiny t3">{`Your sentence, the market list and your current rules are sent to ${provider ?? 'the AI provider'} to draft the rule; nothing else. You check and sign the exact rule.`}</span>
        <textarea id="rule-text" className="area" placeholder="Say what the guard should do, and at what buffer, price move or time." maxLength={500} value={text} onChange={(e) => setText(e.target.value)} disabled={!enabled} />
        {first && enabled && bare ? (
          <div className="field" style={{ maxWidth: 360 }}>
            <label htmlFor="tr-slip">Max slippage for guard orders (your first rules need it)</label>
            <div className="input">
              <input id="tr-slip" inputMode="decimal" placeholder="Your number" value={s.draft.slippage} onChange={(e) => s.setDraft({ ...s.draft, slippage: e.target.value })} />
              <span className="unit">%</span>
            </div>
          </div>
        ) : null}
        <div className="row">
          <button type="button" className="btn btn-ink" disabled={!text.trim() || busy !== null || !enabled || (first && !slipOk)} onClick={translate}>
            {translating ? 'Translating…' : 'Translate'}
          </button>
          <span className="small t3">
            {!enabled
              ? 'The AI translator is off for now. Build your rule by hand below.'
              : first && !slipOk
                ? `Type your max slippage (above 0, up to 10%)${bare ? '' : ' under How the guard trades'} first: the guard never trades further than that from the mark.`
                : 'The translator turns your sentence into a rule. It never adds a number.'}
          </span>
        </div>

        {translating ? (
          <div className="panel pb col" style={{ background: 'var(--s2)', gap: 10 }}>
            <b className="small">Translating your sentence…</b>
            <span className="sk" style={{ width: '80%' }} />
            <span className="sk" style={{ width: '55%' }} />
          </div>
        ) : null}
        {forced === 'error' ? (
          <div className="banner b-crit" style={{ flexDirection: 'column', gap: 6 }}>
            <b>The draft failed the safety checks, so it was not shown.</b>
            <span>It contained a number that is not in your sentence. It was discarded and logged in your audit log. Write the number you want into your sentence and try again.</span>
          </div>
        ) : null}

        {reply?.kind === 'draft' ? (
          <div className="panel pb col" style={{ background: 'var(--s2)', gap: 10 }}>
            <div className="row">
              <b className="small">Draft rule</b>
              <span className="tag">not active until you sign</span>
            </div>
            <p style={{ fontSize: 14, margin: 0 }}>{reply.description}</p>
            <div className="disclose">
              {Icon.check(14)}
              <span>
                Every number in this rule is one you typed:{' '}
                {reply.provenance.map((p, i) => (
                  <span key={p.path}>
                    {i ? ', ' : ''}
                    <span className="num">{p.typed}</span>
                  </span>
                ))}
                . The wording above is generated from the rule itself, not by the AI.
              </span>
            </div>
            <div className="row">
              <button type="button" className="btn btn-sm btn-ink" disabled={busy !== null || s.changes.any} onClick={sign}>
                {busy === 'sign' ? 'Waiting for signature…' : `Sign version ${reply.policy.version}`}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  s.startFrom(reply.rule);
                  setReply(null);
                }}
              >
                Edit by hand
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setReply(null)}>
                Discard
              </button>
            </div>
            {s.changes.any ? <span className="tiny wt">You have changes below that aren’t signed. Sign or discard them first, or use Edit by hand to add this rule to them.</span> : null}
          </div>
        ) : reply?.kind === 'clarify' ? (
          <div className="banner">
            <span>
              <b>The translator has one question.</b> {reply.question} Edit your sentence and translate again.
            </span>
          </div>
        ) : reply?.kind === 'refuse' ? (
          <div className="banner b-warn">
            <span>
              <b>Not a guard rule.</b> {reply.reason}
            </span>
          </div>
        ) : reply?.kind === 'rejected' ? (
          <div className="banner b-crit" style={{ flexDirection: 'column', gap: 6 }}>
            <b>The draft failed the safety checks, so it was not used.</b>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {reply.violations.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
            <span>Write the number you want into your sentence and try again.</span>
          </div>
        ) : null}
        {err ? <span className="small ct">{err}</span> : null}
        {done ? <span className="small">{done}</span> : null}
        <div className="disclose">
          {Icon.lines(14)}
          <span>
            <b>The AI only translates what you wrote.</b> It never suggests a number, and a draft with any number you didn’t type is thrown away. You sign every rule before it runs.
          </span>
        </div>
      </div>
    </section>
  );
}

