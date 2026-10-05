'use client';

import { Policy, type Action, type Rule } from '@bulwarkxyz/guard-core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAccount, useChainId, useSignTypedData } from 'wagmi';
import { api } from '@/lib/api';
import { useMe } from '@/lib/me';
import { signPolicy, type SignTypedData } from '@/lib/signing';

type Kind = 'alert' | 'topUp' | 'reduceToBuffer' | 'reduce' | 'close';
interface Stage {
  line: string;
  kind: Kind;
  param: string;
}

const KINDS: Array<{ kind: Kind; label: string; param?: string; unit?: string }> = [
  { kind: 'alert', label: 'Alert me' },
  { kind: 'topUp', label: 'Move idle USDC into the pool', param: 'Your amount', unit: 'USDC' },
  { kind: 'reduceToBuffer', label: 'Trim until buffer is back at', param: 'Your line', unit: '×' },
  { kind: 'reduce', label: 'Cut the biggest position by', param: 'Your share', unit: '%' },
  { kind: 'close', label: 'Close every position' },
];

function toAction(s: Stage): Action | null {
  const n = Number(s.param);
  switch (s.kind) {
    case 'alert':
      return { kind: 'alert' };
    case 'close':
      return { kind: 'close', target: { kind: 'all' } };
    case 'topUp':
      return n > 0 ? { kind: 'topUp', maxUsdc: n } : null;
    case 'reduceToBuffer':
      return n > 1 ? { kind: 'reduceToBuffer', buffer: n } : null;
    case 'reduce':
      return n > 0 && n <= 100 ? { kind: 'reduce', target: { kind: 'first_position' }, fraction: n / 100 } : null;
  }
}

/**
 * The structured rule editor: stages on the pool buffer, each typed by the user (no preset numbers).
 * Signing it in the wallet confirms the policy version the guard will run.
 */
/** The user's own saved stages, to edit (their numbers, not presets). */
function savedStages(rules: readonly Rule[]): Stage[] {
  const out: Stage[] = [];
  for (const r of rules) {
    if (!r.id.startsWith('stage-') || r.when.kind !== 'buffer' || r.then.length !== 1) continue;
    const a = r.then[0]!;
    const param = a.kind === 'topUp' ? a.maxUsdc : a.kind === 'reduceToBuffer' ? a.buffer : a.kind === 'reduce' ? +(a.fraction * 100).toFixed(6) : '';
    if (['alert', 'topUp', 'reduceToBuffer', 'reduce', 'close'].includes(a.kind)) out.push({ line: String(r.when.below), kind: a.kind as Kind, param: String(param) });
  }
  return out;
}

export function StageForm({ onDone }: { onDone?: () => void }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const { signTypedDataAsync } = useSignTypedData();
  const me = useMe();
  const qc = useQueryClient();
  const saved = me.data?.policy?.policy;
  const [stages, setStages] = useState<Stage[]>(() => (saved && savedStages(saved.rules).length ? savedStages(saved.rules) : [{ line: '', kind: 'alert', param: '' }]));
  const [slip, setSlip] = useState(saved ? String(saved.execution.maxSlippagePct) : '');
  // Rules that are not buffer stages (for example AI-translated ones) are kept as they are.
  const kept = saved?.rules.filter((r) => !r.id.startsWith('stage-')) ?? [];
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const rules: Array<Rule | null> = stages.map((s, i) => {
    const line = Number(s.line);
    const action = toAction(s);
    return line > 1 && action ? { id: `stage-${i + 1}`, when: { kind: 'buffer', below: line }, then: [action] } : null;
  });
  const lines = stages.map((s) => Number(s.line));
  const decreasing = lines.every((l, i) => i === 0 || l < lines[i - 1]!);
  const problem = !address
    ? 'Connect a wallet first.'
    : !me.data
      ? 'Sign in first.'
      : rules.some((r) => !r)
        ? 'Each stage needs a line above 1 and, where asked, a number.'
        : !decreasing
          ? 'Each line must be lower than the one before it.'
          : !(Number(slip) > 0 && Number(slip) <= 10)
            ? 'Type the furthest from the mark the guard may trade (up to 10%).'
            : null;

  async function confirm() {
    if (problem || !address) return;
    setBusy(true);
    setMsg(null);
    try {
      const policy = Policy.parse({
        version: (me.data?.policy?.version ?? 0) + 1,
        account: address.toLowerCase(),
        rules: [...(rules as Rule[]), ...kept],
        execution: { maxSlippagePct: Number(slip) },
      });
      const signature = await signPolicy(signTypedDataAsync as unknown as SignTypedData, chainId, policy);
      await api('/v1/policy', { body: { policy, signature, chainId } });
      await qc.invalidateQueries({ queryKey: ['me'] });
      setMsg({ ok: true, text: `Policy v${policy.version} signed. The guard runs it from now.` });
      onDone?.();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const set = (i: number, patch: Partial<Stage>) => setStages((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="col" style={{ gap: 16 }}>
      <span className="t2" style={{ fontSize: 13 }}>
        Buffer is pool equity divided by maintenance margin. Liquidation happens at 1×. Pick the lines where the guard steps in and what it does at each.
      </span>
      {stages.map((s, i) => {
        const k = KINDS.find((x) => x.kind === s.kind)!;
        return (
          <div key={i} className="stage" style={{ gridTemplateColumns: '28px minmax(0,1fr)' }}>
            <span className="n">{i + 1}</span>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div className="field" style={{ width: 130 }}>
                <label htmlFor={`line-${i}`}>When buffer is below</label>
                <div className="input">
                  <input id={`line-${i}`} inputMode="decimal" placeholder="Your line" value={s.line} onChange={(e) => set(i, { line: e.target.value })} />
                  <span className="unit">×</span>
                </div>
              </div>
              <div className="field" style={{ flex: 1, minWidth: 180 }}>
                <label htmlFor={`act-${i}`}>Do this</label>
                <div className="input">
                  <select id={`act-${i}`} value={s.kind} onChange={(e) => set(i, { kind: e.target.value as Kind, param: '' })}>
                    {KINDS.map((x) => (
                      <option key={x.kind} value={x.kind}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {k.param ? (
                <div className="field" style={{ width: 150 }}>
                  <label htmlFor={`p-${i}`}>{k.param.replace('Your ', '')}</label>
                  <div className="input">
                    <input id={`p-${i}`} inputMode="decimal" placeholder={k.param} value={s.param} onChange={(e) => set(i, { param: e.target.value })} />
                    <span className="unit">{k.unit}</span>
                  </div>
                </div>
              ) : null}
              {stages.length > 1 ? (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setStages((xs) => xs.filter((_, j) => j !== i))} aria-label={`Remove stage ${i + 1}`}>
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
      {stages.length < 6 ? (
        <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setStages((xs) => [...xs, { line: '', kind: 'alert', param: '' }])}>
          Add a stage
        </button>
      ) : null}
      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="g-slip">Furthest from the mark the guard may trade</label>
        <div className="input">
          <input id="g-slip" inputMode="decimal" placeholder="Your number" value={slip} onChange={(e) => setSlip(e.target.value)} />
          <span className="unit">%</span>
        </div>
      </div>
      {kept.length ? (
        <span className="t3" style={{ fontSize: 12 }}>
          Your {kept.length} other rule{kept.length > 1 ? 's are' : ' is'} kept as {kept.length > 1 ? 'they are' : 'it is'}.
        </span>
      ) : null}
      <div className="disclose">
        <span>
          The guard only ever reduces risk: reduce-only orders, cancels of orders that would add to a position, and moves of your own idle USDC. It cannot open or grow a position and cannot withdraw. <b>Reduce-only is enforced by our engine, not by Hyperliquid.</b>
        </span>
      </div>
      <button type="button" className="btn btn-ink" disabled={Boolean(problem) || busy} onClick={confirm}>
        {busy ? 'Waiting for signature…' : 'Sign and turn on'}
      </button>
      {problem ? <span className="t3" style={{ fontSize: 12 }}>{problem}</span> : null}
      {msg ? <span className={msg.ok ? '' : 'err'} style={{ fontSize: 13 }}>{msg.text}</span> : null}
    </div>
  );
}
