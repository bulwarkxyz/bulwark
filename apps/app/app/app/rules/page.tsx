'use client';

import type { Policy, Rule } from '@bulwarkxyz/guard-core';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useChainId, useSignTypedData } from 'wagmi';
import { fmtBuffer } from '@/components/app/format';
import { BufferMeter } from '@/components/app/guard-ui';
import { Icon } from '@/components/app/icons';
import { ActiveRules, HowGuardTrades, RuleBuilder, usePolicyDraft, type PolicyDraftState } from '@/components/app/rules-editor';
import { api, ApiError, useSignedIn } from '@/lib/api';
import { describeAction, tickerOf, useGuardView, useNow, type GuardView } from '@/lib/guard';
import { useAccountView } from '@/lib/hl';
import { homeOpen, marketByCoin } from '@/lib/markets';
import { useMe } from '@/lib/me';
import { useReview, useViewer } from '@/lib/review';
import { signPolicy, type SignTypedData } from '@/lib/signing';
import { useTimes } from '@/lib/time';

type DraftReply =
  | { kind: 'draft'; rule: Rule; description: string; provenance: Array<{ path: string; value: number; typed: number }>; policy: Policy }
  | { kind: 'clarify'; question: string }
  | { kind: 'refuse'; reason: string }
  | { kind: 'rejected'; violations: string[] };

function Translator({ enabled, forced, s }: { enabled: boolean; forced: 'loading' | 'error' | null; s: PolicyDraftState }) {
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
      setErr(e instanceof ApiError && e.status === 503 ? 'The AI translator is not switched on yet. You can still build rules by hand.' : (e as Error).message);
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
      setDone(`Added. Version ${reply.policy.version} is now running.`);
      setReply(null);
      setText('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const translating = forced === 'loading' || busy === 'translate';
  return (
    <section className="panel" aria-labelledby="ai-h">
      <div className="ph">
        <h2 id="ai-h">Write a rule in your own words</h2>
        <span className="tag">AI translator</span>
        <span className="sp" />
        <span className="tiny t3">30 translations an hour</span>
      </div>
      <div className="pb col" style={{ gap: 12 }}>
        <label className="small t2" htmlFor="rule-text">
          What should the guard do, and when? Use your own numbers.
        </label>
        <textarea id="rule-text" className="area" placeholder="Say what the guard should do, and at what buffer, price move or time." maxLength={500} value={text} onChange={(e) => setText(e.target.value)} disabled={!enabled} />
        <div className="row">
          <button type="button" className="btn btn-ink" disabled={!text.trim() || busy !== null || !enabled} onClick={translate}>
            {translating ? 'Translating…' : 'Translate'}
          </button>
          <span className="small t3">{enabled ? 'The translator turns your sentence into a rule. It never adds a number.' : 'Sign your first rules (build one by hand) first; the translator adds to them.'}</span>
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

function ruleStatus(r: Rule, g: GuardView): { text: string; cls: string } {
  if (r.when.kind === 'buffer') {
    const line = r.when.below;
    const below = (g.worst && g.worst.buffer < line) || false;
    if (below) return { text: `Crossed now: the lowest pool is at ${fmtBuffer(g.worst!.buffer)}`, cls: g.state === 'risk' ? 'ct' : 'wt' };
    return { text: g.worst ? `Idle · lowest buffer ${fmtBuffer(g.worst.buffer)}` : 'Idle · no positions', cls: 't3' };
  }
  return { text: r.window ? 'Watching during its window' : 'Watching', cls: 't3' };
}

export default function RulesPage() {
  const review = useReview();
  const { address, connected } = useViewer();
  const signedIn = useSignedIn() || review.on;
  const me = useMe();
  const g = useGuardView();
  const now = useNow();
  const view = useAccountView(address);
  const policy = me.data?.policy;
  const draft = usePolicyDraft();
  const times = useTimes();
  const held = (view.data?.risk.pools ?? []).flatMap((p) => p.positions.map((r) => r.position.coin));
  const draftLines = draft.draft.rules.flatMap((r) => (r.when.kind === 'buffer' && !g.lines.includes(r.when.below) ? [r.when.below] : []));
  const loading = review.state === 'loading' || (connected && signedIn && !me.isFetched);
  const closed = (view.data?.risk.pools ?? []).flatMap((p) => p.positions).some((r) => {
    const m = marketByCoin(r.position.coin);
    return m ? !homeOpen(m.session, now) : false;
  });
  const doesAt = (line: number) => {
    const r = g.rules.find((x) => x.when.kind === 'buffer' && x.when.below === line);
    return r ? r.then.map(describeAction).join(', ') : '';
  };

  return (
    <div className="pg">
      <div className="ptitle">
        <h1 className="h1">Guard rules</h1>
        <span className="small t2">{policy ? `Version ${policy.version} · signed ${times.fmt(policy.confirmedAt)} ${times.label} · ${policy.policy.rules.length} rule${policy.policy.rules.length === 1 ? '' : 's'}` : connected ? 'No signed rules yet' : ''}</span>
        {g.exampleRules ? <span className="tag">Example rules</span> : null}
        <span className="sp" />
        <Link className="btn btn-sm" href="/app/simulator">
          Test in the simulator
        </Link>
      </div>

      {me.isError ? (
        <div className="banner b-crit">
          {Icon.alert()}
          <span>
            <b>Can’t reach Bulwark’s server.</b> Your signed rules keep running on the guard. Changes need the server; try again shortly.
          </span>
        </div>
      ) : null}
      {closed ? (
        <div className="banner">
          {Icon.moon()}
          <span>
            <b>A home market is closed.</b> Price and buffer rules keep running on trade.xyz’s off-hours prices. Time-window rules run at their window.
          </span>
        </div>
      ) : null}
      {!connected || !signedIn ? (
        <div className="banner">
          <span>
            Connect a wallet and sign in to see and change your rules. <Link href="/app/onboarding" style={{ textDecoration: 'underline' }}>Set up</Link>
          </span>
        </div>
      ) : me.data && !me.data.user ? (
        <div className="banner">
          <span>
            Finish setting up first. <Link href="/app/onboarding" style={{ textDecoration: 'underline' }}>Continue setup</Link>
          </span>
        </div>
      ) : null}

      <div className="grid2 w400">
        <div className="col" style={{ gap: 16 }}>
          <Translator enabled={Boolean(policy)} forced={review.state === 'loading' ? 'loading' : review.state === 'error' ? 'error' : null} s={draft} />
          <ActiveRules s={draft} status={(r) => ruleStatus(r, g)} loading={loading} />
        </div>

        <div className="col" style={{ gap: 16 }}>
          <section className="panel" aria-label="Your lines">
            <div className="ph">
              <h2>Your lines on the buffer</h2>
              {g.worst ? (
                <span className="tiny t3">
                  now <span className="num">{fmtBuffer(g.worst.buffer)}</span>
                  {g.worst.positions.length === 1 ? ` · ${tickerOf(g.worst.positions[0]!.position.coin)}` : ''}
                </span>
              ) : null}
            </div>
            <div className="pb">
              {loading ? (
                <span className="sk" style={{ width: '100%', height: 12 }} />
              ) : (
                <>
                  <BufferMeter buffer={g.worst?.buffer ?? null} lines={g.lines} draft={draftLines} state={g.state} labels does={doesAt} />
                  {!g.lines.length ? <span className="tiny t3">No lines yet. Your lines appear here as you add rules.</span> : null}
                </>
              )}
            </div>
          </section>

          {loading ? null : <RuleBuilder s={draft} held={held} disabled={!connected} />}
          <HowGuardTrades s={draft} />

          <section className="panel" aria-labelledby="retry-h">
            <div className="ph">
              <h2 id="retry-h">If an order doesn’t fill</h2>
            </div>
            <div className="pb small t2" style={{ lineHeight: 1.55 }}>
              In a fast market an order can miss or fill only partly. The guard then sends the rest again on the next price update, while this stage’s line is still crossed. Each retry is priced from the price at that moment, never beyond your slippage limit, and never larger than what is left. After 3 attempts that don’t fully fill, you get an alert. The guard keeps trying until the line is no longer crossed.{' '}
              <Link href="/app/audit" style={{ textDecoration: 'underline' }}>
                Each attempt is in the audit log.
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
