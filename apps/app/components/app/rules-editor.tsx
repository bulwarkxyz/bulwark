'use client';

import { describeRule } from '@bulwarkxyz/compiler';
import type { Rule } from '@bulwarkxyz/guard-core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useAccount, useChainId, useSignTypedData } from 'wagmi';
import { ApiError, api } from '@/lib/api';
import { tickerOf } from '@/lib/guard';
import { MARKETS } from '@/lib/markets';
import { useMe } from '@/lib/me';
import { useReview } from '@/lib/review';
import {
  EMPTY_FORM,
  REPEAT_EVIDENCE,
  REPEAT_OLDER,
  REPEAT_OPTIONS,
  REPEAT_UNSET,
  TARGET_OPTIONS,
  THEN_OPTIONS,
  WHEN_OPTIONS,
  WINDOW_OPTIONS,
  buildRule,
  draftChanges,
  draftFrom,
  draftPolicy,
  formFromRule,
  needsTarget,
  nextRuleId,
  repeatChip,
  type PolicyDraft,
  type RuleForm,
} from '@/lib/rule-builder';
import { saveDraft } from '@/lib/draft-store';
import { signPolicy, type SignTypedData } from '@/lib/signing';
import { Icon } from './icons';
import { Select } from './select';

/**
 * The user's rules as they edit them: the signed version plus local changes (rules added by hand,
 * edited or removed, and the slippage). Nothing runs until the user signs the next version.
 */
export function usePolicyDraft() {
  const me = useMe();
  const review = useReview();
  const signed = me.data?.policy?.policy ?? null;
  const { address } = useAccount();
  const chainId = useChainId();
  const { signTypedDataAsync } = useSignTypedData();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<PolicyDraft>(() => draftFrom(signed));
  const [editing, setEditing] = useState<{ id: string | null; form: RuleForm }>({ id: null, form: EMPTY_FORM });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Rule ids the API refused for want of the repeat choice (400 { needsChoice }).
  const [refused, setRefused] = useState<string[]>([]);
  // A newly signed (or first loaded) version replaces the draft.
  const signedKey = me.data?.policy?.hash ?? 'none';
  useEffect(() => {
    setDraft(draftFrom(signed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedKey]);

  const changes = useMemo(() => draftChanges(signed, draft), [signed, draft]);
  const account = address ?? me.data?.account;
  // Kept for this browser session so the simulator can test the draft before it is signed.
  useEffect(() => {
    if (account) saveDraft(account, me.data?.policy?.hash ?? null, changes.any ? draft : null);
  }, [account, draft, changes.any, me.data?.policy?.hash]);
  const next = account ? draftPolicy(signed, draft, account) : ({ ok: false, problem: 'Connect a wallet first.' } as const);

  async function sign() {
    if (!next.ok || !address || review.on) return;
    setBusy(true);
    setMsg(null);
    try {
      const signature = await signPolicy(signTypedDataAsync as unknown as SignTypedData, chainId, next.policy);
      await api('/v1/policy', { body: { policy: next.policy, signature, chainId } });
      await qc.invalidateQueries({ queryKey: ['me'] });
      setMsg({ ok: true, text: `Version ${next.policy.version} signed. The guard runs it from now.` });
      setRefused([]);
    } catch (e) {
      const need = e instanceof ApiError && Array.isArray(e.body.needsChoice) ? (e.body.needsChoice as string[]) : [];
      setRefused(need);
      setMsg({ ok: false, text: need.length ? `Not signed: ${need.length} rule${need.length > 1 ? 's need' : ' needs'} your choice, marked below.` : (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return {
    signed,
    signedVersion: me.data?.policy?.version ?? 0,
    draft,
    setDraft,
    changes,
    next,
    sign,
    busy,
    msg,
    editing,
    edit: (r: Rule) => {
      const f = formFromRule(r);
      if (f) setEditing({ id: r.id, form: f });
    },
    startFrom: (r: Rule) => {
      // A translated draft, loaded into the form as a new rule.
      const f = formFromRule(r);
      if (f) setEditing({ id: null, form: f });
    },
    setForm: (form: RuleForm) => setEditing((e) => ({ ...e, form })),
    cancelEdit: () => setEditing({ id: null, form: EMPTY_FORM }),
    save: (rule: Rule) => {
      setDraft((d) => ({ ...d, rules: editing.id ? d.rules.map((r) => (r.id === editing.id ? { ...rule, id: editing.id! } : r)) : [...d.rules, rule] }));
      // An edited rule no longer matches the sentence it came from, so the sentence is not kept.
      setEditing({ id: null, form: EMPTY_FORM });
    },
    refused,
    /** Set the once / every-time choice on one rule in the draft (older rules, or any rule). */
    choose: (id: string, mode: 'oncePerBreach' | 'everyCrossing') =>
      setDraft((d) => ({ ...d, rules: d.rules.map((r) => (r.id === id ? { ...r, repeat: { ...r.repeat, mode } } : r)) })),
    remove: (id: string) => setDraft((d) => ({ ...d, rules: d.rules.filter((r) => r.id !== id) })),
    restore: (r: Rule) => setDraft((d) => (d.rules.some((x) => x.id === r.id) ? d : { ...d, rules: [...d.rules, r] })),
    reset: () => {
      setDraft(draftFrom(signed));
      setEditing({ id: null, form: EMPTY_FORM });
    },
  };
}
export type PolicyDraftState = ReturnType<typeof usePolicyDraft>;

/** Markets a rule can name: the curated list, plus any market the account holds. */
function useMarketOptions(held: readonly string[]): Array<{ coin: string; label: string }> {
  return useMemo(() => {
    const out = new Map(MARKETS.map((m) => [m.coin, `${m.ticker} · ${m.name}`]));
    for (const c of held) if (!out.has(c)) out.set(c, tickerOf(c));
    return [...out].map(([coin, label]) => ({ coin, label }));
  }, [held]);
}

function Num({ id, label, unit, value, onChange }: { id: string; label: string; unit: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field" style={{ flex: 1, minWidth: 0 }}>
      <label htmlFor={id}>{label}</label>
      <div className="input">
        <input id={id} inputMode="decimal" placeholder="Your number" value={value} onChange={(e) => onChange(e.target.value)} />
        <span className="unit">{unit}</span>
      </div>
    </div>
  );
}
function Pick<T extends string>({ id, label, value, options, onChange }: { id: string; label: string; value: T; options: Array<{ value: T; label: string; description?: string }>; onChange: (v: T) => void }) {
  return (
    <div className="field" style={{ flex: 1, minWidth: 0 }}>
      <label htmlFor={id}>{label}</label>
      <Select id={id} label={label} value={value} options={options} onChange={onChange} />
    </div>
  );
}

/** A panel, or (bare) just its content, for use inside a setup step. */
function Box({ bare, id, title, right, children }: { bare?: boolean; id: string; title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  if (bare)
    return (
      <div className="col" style={{ gap: 10 }} aria-labelledby={id}>
        <div className="row nw" style={{ alignItems: 'center' }}>
          <b id={id} className="small">
            {title}
          </b>
          {right}
        </div>
        {children}
      </div>
    );
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="ph">
        <h2 id={id}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

/** "Build a rule by hand": one trigger and one action, every number typed by the user. */
export function RuleBuilder({ s, held = [], disabled, bare }: { s: PolicyDraftState; held?: readonly string[]; disabled?: boolean; bare?: boolean }) {
  const f = s.editing.form;
  const set = (patch: Partial<RuleForm>) => s.setForm({ ...f, ...patch });
  const markets = useMarketOptions(held);
  const marketOpts = [{ value: '', label: 'Choose a market' }, ...markets.map((m) => ({ value: m.coin, label: m.label }))];
  const [tried, setTried] = useState(false);
  const built = buildRule(f, s.editing.id ?? nextRuleId(s.draft.rules));
  const add = () => {
    setTried(true);
    if (built.ok) {
      s.save(built.rule);
      setTried(false);
    }
  };
  return (
    <Box
      bare={bare}
      id="build-h"
      title={s.editing.id ? 'Edit rule' : 'Build a rule by hand'}
      right={
        s.editing.id ? (
          <>
            <span className="sp" />
            <button type="button" className="btn btn-sm btn-ghost" onClick={s.cancelEdit}>
              Cancel
            </button>
          </>
        ) : null
      }
    >
      <div className={bare ? 'col' : 'pb col'} style={{ gap: 10 }}>
        <Pick id="rb-when" label="When" value={f.when} options={WHEN_OPTIONS.map((o) => ({ value: o.kind, label: o.label, description: o.description }))} onChange={(when) => set({ when })} />
        {f.when === 'buffer' ? (
          <>
            <Num id="rb-line" label="Line" unit="×" value={f.line} onChange={(line) => set({ line })} />
            <span className="tiny t3">Every margin pool is checked against this line on its own.</span>
          </>
        ) : f.when === 'drawdown' ? (
          <Num id="rb-dd" label="Fall in account value" unit="%" value={f.drawdownPct} onChange={(drawdownPct) => set({ drawdownPct })} />
        ) : f.when === 'priceMove' ? (
          <>
            <Pick id="rb-mkt" label="Market" value={f.market} options={marketOpts} onChange={(market) => set({ market })} />
            <div className="row nw">
              <Pick id="rb-dir" label="Direction" value={f.direction} options={[{ value: 'down', label: 'Falls' }, { value: 'up', label: 'Rises' }]} onChange={(direction) => set({ direction })} />
              <Num id="rb-move" label="By" unit="%" value={f.movePct} onChange={(movePct) => set({ movePct })} />
            </div>
          </>
        ) : (
          <div className="row nw">
            <Pick id="rb-mkt" label="Market" value={f.market} options={marketOpts} onChange={(market) => set({ market })} />
            <Num id="rb-lev" label="Leverage" unit="×" value={f.leverage} onChange={(leverage) => set({ leverage })} />
          </div>
        )}
        <Pick id="rb-win" label="Only during" value={f.window} options={WINDOW_OPTIONS.map((o) => ({ value: o.name, label: o.label }))} onChange={(window) => set({ window })} />
        {f.when === 'drawdown' || f.when === 'priceMove' ? (
          <span className="tiny t3">{f.window ? 'Measured from the start of each window.' : 'Measured from the moment you sign.'}</span>
        ) : null}
        <Pick id="rb-then" label="Then" value={f.then} options={THEN_OPTIONS.map((o) => ({ value: o.kind, label: o.label, description: o.description }))} onChange={(then) => set({ then })} />
        {needsTarget(f.then) ? (
          <div className="row nw">
            <Pick id="rb-which" label="Which position" value={f.target} options={TARGET_OPTIONS.map((o) => ({ value: o.kind, label: o.label }))} onChange={(target) => set({ target })} />
            {f.then === 'reduce' ? <Num id="rb-share" label="Share" unit="%" value={f.share} onChange={(share) => set({ share })} /> : null}
          </div>
        ) : null}
        {needsTarget(f.then) && f.target === 'market' ? <Pick id="rb-tm" label="Market" value={f.targetMarket} options={marketOpts} onChange={(targetMarket) => set({ targetMarket })} /> : null}
        {f.then === 'reduceToBuffer' ? <Num id="rb-tb" label="Back at" unit="×" value={f.toBuffer} onChange={(toBuffer) => set({ toBuffer })} /> : null}
        {f.then === 'reduceToLeverage' ? (
          <div className="row nw">
            <Pick id="rb-tlm" label="Market" value={f.toLevMarket} options={marketOpts} onChange={(toLevMarket) => set({ toLevMarket })} />
            <Num id="rb-tl" label="Leverage" unit="×" value={f.toLeverage} onChange={(toLeverage) => set({ toLeverage })} />
          </div>
        ) : null}
        {f.then === 'topUp' ? <Num id="rb-usdc" label="Amount" unit="USDC" value={f.usdc} onChange={(usdc) => set({ usdc })} /> : null}
        <RepeatChoice f={f} set={set} />
        {built.ok ? <span className="small t2">{describeRule(built.rule)}</span> : tried ? <span className="small ct">{built.problem}</span> : null}
        <button type="button" className="btn btn-block" disabled={disabled || !f.repeat} aria-describedby="rp-help" onClick={add}>
          {s.editing.id ? 'Update rule' : 'Add to rules'}
        </button>
        <span className="tiny t3">Nothing runs until you sign the new version{bare ? ' below' : ' under Active rules'}.</span>
      </div>
    </Box>
  );
}

/**
 * "After it acts": the user's explicit choice, required, nothing pre-selected; and the optional limit,
 * both numbers typed. Copy from reports/B9.md.
 */
function RepeatChoice({ f, set }: { f: RuleForm; set: (p: Partial<RuleForm>) => void }) {
  return (
    <fieldset className="choice" aria-describedby="rp-help">
      <legend className="lbl">After it acts</legend>
      {REPEAT_OPTIONS.map((o) => (
        <label key={o.mode} className={`opt ${f.repeat === o.mode ? 'on' : ''}`}>
          <input type="radio" name="rb-repeat" checked={f.repeat === o.mode} onChange={() => set({ repeat: o.mode })} />
          <span className="col" style={{ gap: 2 }}>
            <b className="small">{o.label}</b>
            <span className="tiny t2">{o.text}</span>
          </span>
        </label>
      ))}
      <span id="rp-help" className="tiny t3">
        {f.repeat ? null : <span className="wt">{REPEAT_UNSET}. </span>}
        <a href={REPEAT_EVIDENCE} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
          See both on real crash days
        </a>
      </span>
      <div className="col" style={{ gap: 4 }}>
        <span className="lbl">Limit (optional)</span>
        <div className="row nw" style={{ alignItems: 'center', gap: 6 }}>
          <span className="small t2">At most</span>
          <div className="input" style={{ width: 84 }}>
            <input aria-label="Most actions" inputMode="numeric" value={f.limitTimes} onChange={(e) => set({ limitTimes: e.target.value })} />
          </div>
          <span className="small t2">actions in</span>
          <div className="input" style={{ width: 84 }}>
            <input aria-label="Hours" inputMode="decimal" value={f.limitHours} onChange={(e) => set({ limitHours: e.target.value })} />
          </div>
          <span className="small t2">hours</span>
        </div>
      </div>
    </fieldset>
  );
}

/** "How the guard trades": the one execution setting, typed by the user. */
export function HowGuardTrades({ s, bare }: { s: PolicyDraftState; bare?: boolean }) {
  return (
    <Box bare={bare} id="how-h" title="How the guard trades">
      <div className={bare ? 'col' : 'pb col'} style={{ gap: 10 }}>
        <Num id="g-slip" label="Max slippage for guard orders" unit="%" value={s.draft.slippage} onChange={(slippage) => s.setDraft({ ...s.draft, slippage })} />
        <span className="tiny t3">Guard orders are reduce-only IOC orders within this distance of the mark. Top-ups move the USDC amount you typed, once per breach.</span>
        <div className="disclose">
          {Icon.shield(14)}
          <span>
            The guard only ever reduces risk: reduce-only orders, cancels of orders that would add to a position, and moves of your own idle USDC. It cannot open or grow a position and cannot withdraw. <b>Reduce-only is enforced by our engine, not by Hyperliquid.</b>
          </span>
        </div>
      </div>
    </Box>
  );
}

/** "Active rules": the draft, rule by rule, with Edit and Remove, and the button to sign the next version. */
export function ActiveRules({ s, status, loading, bare, title = 'Active rules' }: { s: PolicyDraftState; status: (r: Rule) => { text: string; cls: string }; loading: boolean; bare?: boolean; title?: string }) {
  const signedRules = s.signed?.rules ?? [];
  const removed = signedRules.filter((r) => s.changes.removed.includes(r.id));
  const nChanges = s.changes.added.length + s.changes.changed.length + s.changes.removed.length + (s.changes.slippage ? 1 : 0);
  const nextVersion = s.signedVersion + 1;
  return (
    <Box
      bare={bare}
      id="cur-h"
      title={title}
      right={
        <>
        <span className="tiny t3">
          {s.signed ? `version ${s.signedVersion}` : 'not signed yet'}
          {s.changes.any ? ` · ${nChanges} change${nChanges === 1 ? '' : 's'} not signed` : ''}
        </span>
        <span className="sp" />
        {s.changes.any ? (
          <>
            <button type="button" className="btn btn-sm btn-ghost" disabled={s.busy} onClick={s.reset}>
              Discard changes
            </button>
            <button type="button" className="btn btn-sm btn-ink" disabled={!s.next.ok || s.busy} onClick={s.sign}>
              {s.busy ? 'Waiting for signature…' : `Sign version ${nextVersion}`}
            </button>
          </>
        ) : null}
        </>
      }
    >
      {loading ? (
        <div className="pb col" style={{ gap: 16 }}>
          <span className="sk" style={{ width: '90%' }} />
          <span className="sk" style={{ width: '80%' }} />
          <span className="sk" style={{ width: '85%' }} />
        </div>
      ) : s.draft.rules.length || removed.length ? (
        <div className="pb" style={{ paddingTop: 0, paddingBottom: 0 }}>
          {s.draft.rules.map((r, i) => {
            const isNew = s.changes.added.includes(r.id);
            const isChanged = s.changes.changed.includes(r.id);
            const st = isNew || isChanged ? { text: 'Not active until you sign', cls: 'wt' } : status(r);
            const editable = Boolean(formFromRule(r));
            return (
              <div key={r.id} className="rulerow">
                <span className="n">{i + 1}</span>
                <div className="col" style={{ gap: 3 }}>
                  <span style={{ fontSize: 14 }}>
                    {describeRule({ when: r.when, then: r.then, window: r.window })} {isNew ? <span className="tag">new</span> : isChanged ? <span className="tag">edited</span> : null}
                  </span>
                  {r.source ? <span className="small t3">You wrote: “{r.source.text}”</span> : null}
                  {repeatChip(r) ? (
                    <span className="row nw" style={{ gap: 6 }}>
                      <span className="chip chip-sm">{repeatChip(r)}</span>
                    </span>
                  ) : (
                    <span className="col" style={{ gap: 6, alignItems: 'flex-start' }} id={`need-${r.id}`}>
                      <span className={`chip chip-sm ${s.refused.includes(r.id) ? 'chip-risk' : 'chip-acting'}`}>Needs your choice</span>
                      <span className="tiny t2">{REPEAT_OLDER}</span>
                      <span className="row" style={{ gap: 6 }}>
                        {REPEAT_OPTIONS.map((o) => (
                          <button key={o.mode} type="button" className="btn btn-sm" onClick={() => s.choose(r.id, o.mode)}>
                            {o.label}
                          </button>
                        ))}
                        <a className="tiny" href={REPEAT_EVIDENCE} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline', alignSelf: 'center' }}>
                          See both outcomes
                        </a>
                      </span>
                    </span>
                  )}
                  <span className={`tiny ${st.cls}`}>{st.text}</span>
                </div>
                <div className="row nw">
                  {editable ? (
                    <button type="button" className="btn btn-sm" aria-label={`Edit rule ${i + 1}`} onClick={() => s.edit(r)}>
                      Edit
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove rule ${i + 1}`} onClick={() => s.remove(r.id)}>
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
          {removed.map((r) => (
            <div key={`rm-${r.id}`} className="rulerow" style={{ opacity: 0.7 }}>
              <span className="n">–</span>
              <div className="col" style={{ gap: 3 }}>
                <span style={{ fontSize: 14, textDecoration: 'line-through' }}>{describeRule(r)}</span>
                <span className="tiny wt">Removed when you sign</span>
              </div>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => s.restore(r)}>
                Undo
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty" style={{ padding: '48px 16px' }}>
          <div className="ico">{Icon.shield(18)}</div>
          <b>No rules yet, so the guard is not armed.</b>
          <span className="small" style={{ maxWidth: 460 }}>
            {bare ? 'Add your first rule above. It shows here until you sign.' : 'Write your first rule above, or build one by hand.'} There are no default lines: every number comes from you.
          </span>
        </div>
      )}
      {s.changes.any && !s.next.ok ? <div className="pb tiny ct" style={{ paddingTop: 0 }}>{s.next.problem}</div> : null}
      {s.msg ? <div className={`pb small ${s.msg.ok ? '' : 'ct'}`} style={{ paddingTop: 0 }}>{s.msg.text}</div> : null}
    </Box>
  );
}

