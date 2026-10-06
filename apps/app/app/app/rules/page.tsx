'use client';

import type { Policy, Rule } from '@bulwarkxyz/guard-core';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useSignTypedData } from 'wagmi';
import { fmtBuffer } from '@/components/app/format';
import { BufferMeter } from '@/components/app/guard-ui';
import { Icon } from '@/components/app/icons';
import { ActiveRules, HowGuardTrades, RuleBuilder, usePolicyDraft } from '@/components/app/rules-editor';
import { Translator } from '@/components/app/translator';
import { api, ApiError, useSignedIn } from '@/lib/api';
import { describeAction, tickerOf, useGuardView, useNow, type GuardView } from '@/lib/guard';
import { useAccountView } from '@/lib/hl';
import { homeOpen, marketByCoin } from '@/lib/markets';
import { useMe } from '@/lib/me';
import { useReview, useViewer } from '@/lib/review';
import { signPolicy, type SignTypedData } from '@/lib/signing';
import { useTimes } from '@/lib/time';

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

      {policy?.needsRepeatChoice?.length ? (
        <div className="banner b-warn" role="status">
          <span>
            <b>
              {policy.needsRepeatChoice.length} stage{policy.needsRepeatChoice.length > 1 ? 's need' : ' needs'} a choice: act once per fall, or every time the line is crossed.
            </b>{' '}
            Until you choose and sign, {policy.needsRepeatChoice.length > 1 ? 'they act' : 'it acts'} every time, as before.
          </span>
          <span className="sp" />
          <button type="button" className="btn btn-sm" onClick={() => document.getElementById(`need-${policy.needsRepeatChoice![0]}`)?.scrollIntoView({ block: 'center' })}>
            Choose
          </button>
        </div>
      ) : null}
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
          <Translator forced={review.state === 'loading' ? 'loading' : review.state === 'error' ? 'error' : null} s={draft} />
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
