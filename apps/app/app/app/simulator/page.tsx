'use client';

import { assessRisk, linearPath, nextTimeIn, simulate, type GuardAction, type Policy, type SimResult, type WindowName } from '@bulwarkxyz/guard-core';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fmtBuffer, fmtPct, fmtPx, fmtUsd } from '@/components/app/format';
import { GuardChip } from '@/components/app/guard-ui';
import { Icon } from '@/components/app/icons';
import { useSignedIn } from '@/lib/api';
import { tickerOf, useGuardView, useNow } from '@/lib/guard';
import { useAccountView, useFills } from '@/lib/hl';
import { homeOpen, marketByCoin } from '@/lib/markets';
import { useMe } from '@/lib/me';
import { useReview, useViewer } from '@/lib/review';
import { loadDraft } from '@/lib/draft-store';
import { draftChanges, draftPolicy } from '@/lib/rule-builder';
import { AccountUnavailable } from '@/components/app/account-unavailable';

/** Path resolution: the guard looks once per step. */
const STEPS = 120;
const WHEN: Array<{ id: 'now' | WindowName; label: string }> = [
  { id: 'now', label: 'Now' },
  { id: 'weekend', label: 'Weekend gap' },
  { id: 'overnight', label: 'Overnight' },
  { id: 'us_session', label: 'US session' },
];

const sz = (n: number) => String(+n.toPrecision(6));
function actionText(a: GuardAction): string {
  const c = 'coin' in a ? tickerOf(a.coin) : '';
  switch (a.type) {
    case 'order':
      return `${a.isBuy ? 'Buy' : 'Sell'} ${sz(a.size)} ${c}, reduce-only (limit ${fmtPx(a.limitPx)})`;
    case 'trigger':
      return `Backstop: stop ${sz(a.size)} ${c} at ${fmtPx(a.triggerPx)}`;
    case 'transfer':
      return `Move ${fmtUsd(a.amount)} from ${a.source} to ${a.toDex || 'main dex'}`;
    case 'isolatedMargin':
      return `Add ${fmtUsd(a.amount)} margin to ${c}`;
    case 'cancel':
      return `Cancel order ${a.oid} on ${c}`;
    case 'alert':
      return `Alert: ${a.reason}`;
  }
}

/** A rule's action in two words, for markers and the Rule column. */
function shortRule(p: Policy, id: string): string {
  const a = p.rules.find((r) => r.id === id)?.then[0];
  if (!a) return id;
  switch (a.kind) {
    case 'alert':
      return 'alert';
    case 'reduce':
      return `trim ${+(a.fraction * 100).toFixed(2)}%`;
    case 'close':
      return 'close';
    case 'reduceToBuffer':
      return 'trim';
    case 'reduceToLeverage':
      return 'cut leverage';
    case 'topUp':
      return 'top up';
    case 'cancelOpeningOrders':
      return 'cancel orders';
  }
}
const fmtDur = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `+${m}m` : `+${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

/**
 * Where each marker's label goes: just above its dot, or a step higher, or below, whichever doesn't overlap
 * a label already placed. A label with no free spot is left off; its dot stays, and the table lists it.
 */
function placeLabels<T extends { label: string; cx: number; cy: number }>(marks: T[], W: number, H: number): Array<T & { at: { x: number; y: number } | null }> {
  const boxes: Array<{ x1: number; x2: number; y1: number; y2: number }> = [];
  return [...marks]
    .sort((a, b) => a.cx - b.cx)
    .map((m) => {
      if (!m.label) return { ...m, at: null };
      const w = m.label.length * 6.8 + 4;
      const x = Math.min(m.cx + 7, W - 12 - w);
      for (const y of [m.cy - 8, m.cy - 22, m.cy - 36, m.cy + 20]) {
        const box = { x1: x, x2: x + w, y1: y - 12, y2: y + 3 };
        if (box.y1 < 0 || box.y2 > H - 20) continue;
        if (boxes.some((o) => box.x1 < o.x2 && box.x2 > o.x1 && box.y1 < o.y2 && box.y2 > o.y1)) continue;
        boxes.push(box);
        return { ...m, at: { x, y } };
      }
      return { ...m, at: null };
    });
}

/** Buffer along the path (log scale, liquidation at the bottom), with the user's lines. */
type Marker = { step: number; label: string; tone: 'warn' | 'crit' };
function BufferChart({ guarded, unguarded, lines, markers }: { guarded: number[]; unguarded: number[]; lines: number[]; markers: Marker[] }) {
  const W = 760;
  const H = 230;
  const L = 44;
  const finite = [...guarded, ...unguarded, ...lines].filter((b) => Number.isFinite(b) && b > 0);
  const top = Math.max(2, ...finite) * 1.1;
  const y = (b: number) => H - 22 - (Math.log(Math.max(1, Math.min(b, top))) / Math.log(top)) * (H - 40);
  const x = (i: number) => L + (i / STEPS) * (W - L - 12);
  const line = (xs: number[]) => xs.map((b, i) => `${x(i).toFixed(1)},${y(Number.isFinite(b) ? b : top).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Buffer along the path, with and without the guard">
      <line x1={L} x2={W - 12} y1={y(1)} y2={y(1)} stroke="var(--crit)" strokeWidth="1.5" />
      <text x={L - 6} y={y(1) + 4} textAnchor="end" fontSize="11" fill="var(--crit)">1.00×</text>
      {lines.map((l) => (
        <g key={l}>
          <line x1={L} x2={W - 12} y1={y(l)} y2={y(l)} stroke="var(--warn)" strokeDasharray="4 4" />
          <text x={L - 6} y={y(l) + 4} textAnchor="end" fontSize="11" fill="var(--text-2)">{l}×</text>
        </g>
      ))}
      <polyline fill="none" stroke="var(--text-2)" strokeWidth="2" strokeDasharray="6 5" points={line(unguarded)} />
      <polyline fill="none" stroke="var(--guard-g)" strokeWidth="2.5" points={line(guarded)} />
      {placeLabels(
        markers.map((mk) => {
          const b = mk.tone === 'crit' ? 1 : guarded[mk.step]!;
          return { ...mk, cx: x(mk.step), cy: y(Number.isFinite(b) ? b : top) };
        }),
        W,
        H,
      ).map((mk) => (
        <g key={`${mk.step}-${mk.label}`}>
          <circle cx={mk.cx} cy={mk.cy} r="4.5" fill={mk.tone === 'crit' ? 'var(--crit)' : 'var(--warn)'} />
          {mk.at ? (
            <text x={mk.at.x} y={mk.at.y} fontSize="12" fill={mk.tone === 'crit' ? 'var(--crit)' : 'var(--text)'}>
              {mk.label}
            </text>
          ) : null}
        </g>
      ))}
      <text x={L} y={H - 4} fontSize="11" fill="var(--text-3)">start</text>
      <text x={W - 12} y={H - 4} textAnchor="end" fontSize="11" fill="var(--text-3)">end of path</text>
    </svg>
  );
}

export default function SimulatorPage() {
  const review = useReview();
  const { address, connected } = useViewer();
  const signedIn = useSignedIn() || review.on;
  const view = useAccountView(address);
  const me = useMe();
  const g = useGuardView();
  const now = useNow();
  const fills = useFills(address);
  const [moves, setMoves] = useState<Record<string, string>>({});
  const [when, setWhen] = useState<'now' | WindowName>('now');
  const [hours, setHours] = useState('');
  const [withDraft, setWithDraft] = useState(false);
  const [res, setRes] = useState<{ sim: SimResult; unguarded: number[]; at: number; stepMs: number; policy: Policy; path: Array<Record<string, number>>; draft: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const positions = view.data?.snapshot.positions ?? [];
  const signedPolicy = me.data?.policy?.policy;
  // An unsigned draft from Guard rules (this tab only), if it was edited from the version now signed.
  const draft = address && signedPolicy && !review.on ? loadDraft(address, me.data?.policy?.hash ?? null) : null;
  const draftNext = draft && signedPolicy && address && draftChanges(signedPolicy, draft).any ? draftPolicy(signedPolicy, draft, address) : null;
  const policy = withDraft && draftNext?.ok ? draftNext.policy : signedPolicy;
  const loading = review.state === 'loading' || (connected && !view.data && !view.isError);
  // The user's realised fee rate across their own fills; none when they have no fills yet.
  const notional = (fills.data ?? []).reduce((s, f) => s + Number(f.px) * Number(f.sz), 0);
  const feeRate = notional ? (fills.data ?? []).reduce((s, f) => s + Number(f.fee), 0) / notional : 0;
  const typed = positions.filter((p) => moves[p.coin]?.trim());
  const bad = typed.find((p) => !(Number.isFinite(Number(moves[p.coin])) && Number(moves[p.coin]) > -100 && Number(moves[p.coin]) <= 500));
  const hoursN = Number(hours);
  const hoursOk = hours.trim() !== '' && hoursN > 0 && hoursN <= 24 * 14;
  const valid = typed.length > 0 && !bad && hoursOk;
  const closedNow = positions.some((p) => {
    const m = marketByCoin(p.coin);
    return m ? !homeOpen(m.session, now) : false;
  });

  function run() {
    setErr(null);
    if (!view.data || !policy) return;
    const at = when === 'now' ? Date.now() : nextTimeIn(when, Date.now());
    if (at === null) return setErr('No such time in the next week.');
    const start = Object.fromEntries(positions.map((p) => [p.coin, p.markAtSnapshot]));
    const pct = Object.fromEntries(typed.map((p) => [p.coin, Number(moves[p.coin])]));
    const path = linearPath(start, pct, STEPS);
    const stepMs = (hoursN * 3_600_000) / STEPS;
    // As the live guard runs: with its resting backstop, retries, and the per-minute action cap.
    const sim = simulate({ policy, snapshot: view.data.snapshot, path, now: at, feeRate, automationAllowed: me.data?.user?.region !== 'guardOff', backstops: true, stepMs });
    const unguarded = path.map((m) => assessRisk(view.data!.snapshot, m).worst?.buffer ?? Number.POSITIVE_INFINITY);
    setRes({ sim, unguarded, at, stepMs, policy, path, draft: Boolean(withDraft && draftNext?.ok) });
  }

  // Review builds only: example moves (labelled on screen) and one run, so the results can be reviewed.
  const [example, setExample] = useState(false);
  useEffect(() => {
    if (!review.on) return;
    if (review.state === 'closed') setWhen('weekend');
    if (review.state !== null && review.state !== 'closed') return;
    // The riskiest pool's first position, moved 10% past its liquidation price (so the run shows the guard acting).
    const row = view.data?.risk.worst?.positions[0];
    const first = row?.position ?? positions[0];
    if (first && !example && !res) {
      const liq = row?.liquidationPx;
      const pct = liq && row ? Math.round(((liq / row.mark - 1) * 100) * 1.1) : first.size > 0 ? -30 : 30;
      setMoves({ [first.coin]: String(pct) });
      setHours('6');
      setExample(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review.on, review.state, positions.length]);
  useEffect(() => {
    if (example && !res && valid && policy) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [example, valid, policy]);

  const acted = res?.sim.steps.filter((s) => s.actions.length) ?? [];
  // Every guard action and every resting-order fill, in order, with the mark, fill and fee.
  const rows = res
    ? [
        ...acted.flatMap((st) =>
          st.actions
            .filter((a) => a.type !== 'trigger')
            .map((a) => {
              const coin = 'coin' in a ? a.coin : null;
              const ev = coin ? res.sim.events.find((e) => e.step === st.step && e.coin === coin && e.kind === 'server') : undefined;
              return { step: st.step, ticker: coin ? tickerOf(coin) : '', mark: coin ? (res.path[st.step]?.[coin] ?? null) : null, buffer: st.buffer, rule: `${res.policy.rules.findIndex((r) => r.id === a.ruleId) + 1} · ${shortRule(res.policy, a.ruleId)}`, text: actionText(a), fill: ev ? ev.px : null, fee: ev ? ev.px * Math.abs(ev.size) * feeRate : null };
            }),
        ),
        ...res.sim.events
          .filter((e) => e.kind === 'backstop' || e.kind === 'stage')
          .map((e) => ({ step: e.step, ticker: tickerOf(e.coin), mark: e.mark, buffer: res.sim.steps[e.step]?.buffer ?? NaN, rule: 'backstop', text: `Resting stop filled: ${Math.abs(e.size)} ${tickerOf(e.coin)}, reduce-only`, fill: e.px, fee: e.px * Math.abs(e.size) * feeRate })),
      ].sort((a, b) => a.step - b.step)
    : [];
  const markers: Array<{ step: number; label: string; tone: 'warn' | 'crit' }> = [];
  // One dot per step that acted; a label only where the action changes (repeats of a trim share one).
  let lastLabel = '';
  for (const r of rows) {
    if (markers.some((m) => m.step === r.step)) continue;
    const label = r.rule.replace(/^\d+ · /, '').replace('backstop', 'backstop filled');
    markers.push({ step: r.step, label: label === lastLabel ? '' : label, tone: 'warn' });
    lastLabel = label;
  }
  if (res?.sim.unguardedLiquidatedAt != null) markers.push({ step: res.sim.unguardedLiquidatedAt, label: 'liquidated', tone: 'crit' });
  // Which pool the path liquidates without the guard, and at what price; and where the guard closed one.
  const unguardedPool = (() => {
    if (!res || res.sim.unguardedLiquidatedAt === null || !view.data) return null;
    const marks = res.path[res.sim.unguardedLiquidatedAt]!;
    const pool = assessRisk(view.data.snapshot, marks).pools.find((p) => p.buffer <= 1) ?? assessRisk(view.data.snapshot, marks).worst;
    const coin = pool?.positions[0]?.position.coin;
    return coin ? { ticker: tickerOf(coin), px: marks[coin]! } : null;
  })();
  const unguardedEnd = res && res.sim.unguardedLiquidatedAt === null && view.data ? assessRisk(view.data.snapshot, res.path[res.path.length - 1]!).accountValue : null;
  const guardedPool = (() => {
    if (!res) return null;
    const closed = positions.find((p) => !res.sim.final.positions.some((f) => f.coin === p.coin && f.size !== 0));
    if (!closed) return null;
    const last = [...res.sim.events].reverse().find((e) => e.coin === closed.coin && e.kind !== 'missed' && e.kind !== 'stage-missed');
    return last ? { ticker: tickerOf(closed.coin), px: last.px } : null;
  })();
  const forcedError = review.state === 'error';

  return (
    <div className="pg">
      <div className="ptitle">
        <h1 className="h1">Simulator</h1>
        <span className="small t2">Moves prices on your real positions and runs your signed rules through the same code the guard runs.</span>
        <span className="sp" />
        {g.exampleRules ? <span className="tag">Example rules</span> : null}
      </div>

      {when !== 'now' || closedNow ? (
        <div className="banner">
          {Icon.moon()}
          <span>
            <b>{when === 'weekend' ? 'Weekend path.' : closedNow ? 'A home market is closed now.' : 'Off-hours path.'}</b> Rules with a time window run as they would at that time. The simulator moves prices in a straight line; it does not model trade.xyz’s off-hours bounds or their re-anchors, so a real weekend can reach a line in jumps.
          </span>
        </div>
      ) : null}

      {!connected ? (
        <div className="panel">
          <div className="empty" style={{ padding: '80px 16px' }}>
            <div className="ico">{Icon.simulator(18)}</div>
            <b>No wallet connected.</b>
            <span className="small">Connect to simulate your own positions with your own rules.</span>
            <Link className="btn btn-sm btn-ink" href="/app/onboarding">
              Connect wallet
            </Link>
          </div>
        </div>
      ) : loading ? (
        <div className="grid2 lead400">
          <div className="panel pb col" style={{ gap: 14 }}>
            <span className="sk" style={{ width: '60%' }} />
            <span className="sk" style={{ width: '90%', height: 36 }} />
            <span className="sk" style={{ width: '90%', height: 36 }} />
          </div>
          <div className="panel pb">
            <div className="skb" style={{ height: 230 }} />
          </div>
        </div>
      ) : !signedIn || !policy ? (
        <div className="panel">
          <div className="empty" style={{ padding: '80px 16px' }}>
            <div className="ico">{Icon.shield(18)}</div>
            <b>No signed rules yet.</b>
            <span className="small">The simulator runs your rules; write them first.</span>
            <Link className="btn btn-sm btn-ink" href="/app/rules">
              Write rules
            </Link>
          </div>
        </div>
      ) : !view.data && view.isError ? (
        <div className="panel">
          <AccountUnavailable view={view} />
        </div>
      ) : !positions.length ? (
        <div className="panel">
          <div className="empty" style={{ padding: '80px 16px' }}>
            <div className="ico">{Icon.positions(18)}</div>
            <b>No open positions to simulate.</b>
            <Link className="btn btn-sm" href="/app">
              Browse markets
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="grid2 lead400">
            <section className="panel" aria-label="Scenario">
              <div className="ph">
                <h2>Scenario</h2>
                <span className="sp" />
                {example ? <span className="tag">Example moves</span> : <span className="tiny t3">nothing is pre-filled</span>}
              </div>
              <div className="pb col" style={{ gap: 10 }}>
                <span className="small t2">Type a move for each market you want to test. A negative number is a fall; empty markets stay where they are.</span>
                {positions.map((p) => (
                  <div key={p.coin} className="row nw">
                    <span className="glyph">{tickerOf(p.coin).slice(0, 2)}</span>
                    <span style={{ flex: 1 }}>
                      <b>{tickerOf(p.coin)}</b> <span className={p.size > 0 ? 'long' : 'short'}>{p.size > 0 ? 'Long' : 'Short'}</span> <span className="t3 num small">at {fmtPx(p.markAtSnapshot)}</span>
                    </span>
                    <div className="input" style={{ width: 140, minHeight: 36 }}>
                      <input aria-label={`${tickerOf(p.coin)} move in percent`} inputMode="decimal" placeholder="Your move" value={moves[p.coin] ?? ''} onChange={(e) => setMoves((m) => ({ ...m, [p.coin]: e.target.value }))} />
                      <span className="unit">%</span>
                    </div>
                  </div>
                ))}
                <div className="field">
                  <label htmlFor="sim-hours">Over how many hours</label>
                  <div className="input">
                    <input id="sim-hours" inputMode="decimal" placeholder="Your number" value={hours} onChange={(e) => setHours(e.target.value)} />
                    <span className="unit">h</span>
                  </div>
                </div>
                <div className="field">
                  <label>When it happens</label>
                  <div className="seg" role="radiogroup" aria-label="When" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gridAutoFlow: 'row' }}>
                    {WHEN.map((w) => (
                      <button key={w.id} type="button" className={when === w.id ? 'on' : ''} aria-pressed={when === w.id} onClick={() => setWhen(w.id)}>
                        {w.label}
                      </button>
                    ))}
                  </div>
                </div>
                {draftNext ? (
                  <label className="row nw small" style={{ gap: 8 }}>
                    <input type="checkbox" checked={withDraft} disabled={!draftNext.ok} onChange={(e) => setWithDraft(e.target.checked)} />
                    Include the draft rule{draft && signedPolicy ? `s` : ''} (not signed yet){draftNext.ok ? '' : `: ${draftNext.problem}`}
                  </label>
                ) : null}
                <div className="kv">
                  <span className="small">Fee rate used</span>
                  <span className="num small">{feeRate ? `${(feeRate * 100).toFixed(4)}% (your fills)` : 'none (no fills yet)'}</span>
                </div>
                <button type="button" className="btn btn-ink btn-block" disabled={!valid} onClick={run}>
                  Run the simulation
                </button>
                {forcedError || bad ? (
                  <div className="banner b-crit">
                    {Icon.alert()}
                    <span>
                      <b>Can’t run this one.</b> {bad ? `The move for ${tickerOf(bad.coin)} is ${moves[bad.coin]}%. ` : 'A move is out of range. '}Type a move between −99% and +500%.
                    </span>
                  </div>
                ) : null}
                {hours.trim() && !hoursOk ? <span className="small ct">Type the hours, above 0 and up to 336 (two weeks).</span> : null}
                {err ? <span className="small ct">{err}</span> : null}
                <div className="disclose">
                  {Icon.info(14)}
                  <span>Fills at the worst price your slippage allows; your real fee rate is charged. The resting backstop and retries run as in the live guard. Funding and book depth are not modelled, and time-window rules are checked at the start time. Not a forecast.</span>
                </div>
              </div>
            </section>

            <div className="col" style={{ gap: 16 }} aria-live="polite">
              {!res ? (
                <div className="panel">
                  <div className="empty" style={{ padding: '90px 16px' }}>
                    <div className="ico">{Icon.simulator(18)}</div>
                    <b>Type a move for at least one market, then run it.</b>
                    <span className="small" style={{ maxWidth: 440 }}>
                      You’ll see the account with and without the guard, side by side, and every action the guard would take.
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid2 even">
                    <section className="panel pb col" style={{ gap: 6 }} aria-label="Without the guard">
                      <div className="row nw">
                        <b>Without the guard</b>
                        <span className="sp" />
                        <span className={`chip chip-sm ${unguardedPool ? 'chip-risk' : 'chip-off'}`}>{unguardedPool ? `${unguardedPool.ticker} liquidated` : 'Not liquidated'}</span>
                      </div>
                      <div className="kv line">
                        <span className="small">{unguardedPool ? `${unguardedPool.ticker} pool` : 'Pools'}</span>
                        <span className="small num">{unguardedPool ? <span className="ct">liquidated at {fmtPx(unguardedPool.px)}</span> : 'none liquidated'}</span>
                      </div>
                      <div className="kv line">
                        <span className="small">Lowest buffer</span>
                        <span className="num small">{fmtBuffer(Math.max(1, Math.min(...res.unguarded)))}</span>
                      </div>
                      <div className="kv line">
                        <span className="small">Account value after</span>
                        <span className="num small">{unguardedEnd !== null ? fmtUsd(unguardedEnd) : <span className="t2">not modelled past liquidation</span>}</span>
                      </div>
                      <div className="kv">
                        <span className="small">Guard actions</span>
                        <span className="num small">0</span>
                      </div>
                    </section>
                    <section className="panel pb col" style={{ gap: 6 }} aria-label="With your rules">
                      <div className="row nw">
                        <b>With your rules{res.draft ? ' and the draft' : ''}</b>
                        <span className="sp" />
                        {res.sim.liquidatedAt !== null ? <span className="chip chip-sm chip-risk">Liquidated</span> : <GuardChip state="protected" sm label="Not liquidated" />}
                      </div>
                      <div className="kv line">
                        <span className="small">{guardedPool ? `${guardedPool.ticker} pool` : 'Pools'}</span>
                        <span className="small num">{guardedPool ? `closed by the guard at ${fmtPx(guardedPool.px)}` : res.sim.liquidatedAt !== null ? <span className="ct">liquidated</span> : 'still open'}</span>
                      </div>
                      <div className="kv line">
                        <span className="small">Lowest buffer</span>
                        <span className="num small">{fmtBuffer(Math.min(...res.sim.steps.map((x) => x.buffer)))}</span>
                      </div>
                      <div className="kv line">
                        <span className="small">Account value after</span>
                        <span className="num small">{fmtUsd(res.sim.final.accountValue)}</span>
                      </div>
                      <div className="kv">
                        <span className="small">Guard actions · fees</span>
                        <span className="num small">
                          {rows.length} · {fmtUsd(res.sim.feesPaid)}
                        </span>
                      </div>
                    </section>
                  </div>
                  <section className="panel">
                    <div className="ph">
                      <h2>Lowest pool buffer along the path</h2>
                      <span className="sp" />
                      <span className="row tiny t2" style={{ gap: 14 }}>
                        <span className="row nw" style={{ gap: 6 }}>
                          <span style={{ width: 18, height: 3, background: 'var(--guard-g)', display: 'inline-block' }} />
                          with your rules
                        </span>
                        <span className="row nw" style={{ gap: 6 }}>
                          <span style={{ width: 18, borderTop: '2px dashed var(--text-2)', display: 'inline-block' }} />
                          without the guard
                        </span>
                      </span>
                    </div>
                    <div className="pb">
                      <BufferChart guarded={res.sim.steps.map((s) => s.buffer)} unguarded={res.unguarded} lines={g.lines} markers={markers} />
                    </div>
                  </section>
                </>
              )}
            </div>
          </div>

          {res ? (
            <section className="panel">
              <div className="ph">
                <h2>What the guard did</h2>
                <span className="tiny t3">in order</span>
              </div>
              {rows.length ? (
                <div className="tblw">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th className="r">Mark</th>
                        <th className="r">Buffer</th>
                        <th>Rule</th>
                        <th>Action</th>
                        <th className="r">Fill</th>
                        <th className="r">Fee</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i}>
                          <td className="num">{fmtDur(r.step * res.stepMs)}</td>
                          <td className="r num">{r.mark !== null ? `${r.ticker} ${fmtPx(r.mark)}` : '—'}</td>
                          <td className="r num">{fmtBuffer(r.buffer)}</td>
                          <td>{r.rule}</td>
                          <td style={{ whiteSpace: 'normal' }}>{r.text}</td>
                          <td className="r num">{r.fill !== null ? fmtPx(r.fill) : '—'}</td>
                          <td className="r num">{r.fee !== null ? fmtUsd(r.fee) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="pb small t2">Nothing fired on this path.</div>
              )}
            </section>
          ) : null}

        </>
      )}
    </div>
  );
}
