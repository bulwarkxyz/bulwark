/**
 * "Build a rule by hand": a form the user fills in, turned into one policy rule, and back again for
 * Edit. Every number comes from what the user typed; nothing here has a default value. A rule the form
 * can't express (for example one with several actions, from the translator) is kept as it is and
 * can be removed, not edited.
 */
import { FIXED_WINDOWS, Policy, Rule, type Action, type Target, type Trigger } from '@bulwarkxyz/guard-core';

export type WhenKind = Trigger['kind'];
export type ThenKind = Action['kind'];
export type TargetKind = Target['kind'];
export type WindowName = keyof typeof FIXED_WINDOWS;

export interface RuleForm {
  when: WhenKind;
  /** buffer: line (×) */
  line: string;
  /** drawdown: percent the account value falls */
  drawdownPct: string;
  /** priceMove / leverageAbove: the market (API coin, e.g. "xyz:CL") */
  market: string;
  direction: 'down' | 'up';
  movePct: string;
  /** leverageAbove: leverage (×) */
  leverage: string;
  /** Optional fixed window ('' = always). */
  window: WindowName | '';
  then: ThenKind;
  target: TargetKind;
  /** target = market: which market */
  targetMarket: string;
  /** reduce: percent of the position */
  share: string;
  /** reduceToBuffer: line (×) to trim back to */
  toBuffer: string;
  /** reduceToLeverage: market and leverage (×) */
  toLevMarket: string;
  toLeverage: string;
  /** topUp: USDC */
  usdc: string;
  /** After it acts: the user's explicit choice; '' until they choose (nothing is pre-selected). */
  repeat: '' | 'oncePerBreach' | 'everyCrossing';
  /** Optional limit: at most `limitTimes` actions within any `limitHours` hours, both typed. */
  limitTimes: string;
  limitHours: string;
}

/** An empty form: every number blank, so the user types each one. */
export const EMPTY_FORM: RuleForm = {
  when: 'buffer',
  line: '',
  drawdownPct: '',
  market: '',
  direction: 'down',
  movePct: '',
  leverage: '',
  window: '',
  then: 'reduce',
  target: 'first_position',
  targetMarket: '',
  share: '',
  toBuffer: '',
  toLevMarket: '',
  toLeverage: '',
  usdc: '',
  repeat: '',
  limitTimes: '',
  limitHours: '',
};

/** Copy for the choice (reports/B9.md), word for word. */
export const REPEAT_OPTIONS = [
  { mode: 'oncePerBreach', label: 'Once per fall', chip: 'Once per fall', text: 'Acts once when the line is crossed, then leaves the rest of the fall to your backstop. It acts again only once your buffer is back above the line and the price is back where it acted (or that position is closed).' },
  { mode: 'everyCrossing', label: 'Every time the line is crossed', chip: 'Every time', text: 'Acts each time your buffer comes back above the line and falls through it, including after its own trim.' },
] as const;
export const REPEAT_UNSET = 'Choose what this stage does after it acts';
export const REPEAT_OLDER = 'Until you choose and sign, it acts every time the line is crossed.';
/** The backtests section that replays the same days both ways. */
export const REPEAT_EVIDENCE = '/docs/backtests#once-per-fall-or-every-time';

/** The chip for a rule's choice: "Once per fall", "Every time", plus "≤ N in H h" with a limit; null if not chosen. */
export function repeatChip(r: Pick<Rule, 'repeat'>): string | null {
  if (!r.repeat) return null;
  const base = REPEAT_OPTIONS.find((o) => o.mode === r.repeat!.mode)!.chip;
  return r.repeat.limit ? `${base} · ≤ ${r.repeat.limit.times} in ${r.repeat.limit.perHours} h` : base;
}

export const WHEN_OPTIONS: Array<{ kind: WhenKind; label: string; description: string }> = [
  { kind: 'buffer', label: 'Buffer falls below', description: 'A margin pool’s equity ÷ maintenance; Hyperliquid liquidates at 1×' },
  { kind: 'drawdown', label: 'Account value falls by', description: 'A percentage fall since you signed, or since a window opened' },
  { kind: 'priceMove', label: 'A market’s price moves', description: 'Up or down by a percentage, on one market' },
  { kind: 'leverageAbove', label: 'Leverage on a market goes above', description: 'The position’s leverage, as Hyperliquid computes it' },
];
export const THEN_OPTIONS: Array<{ kind: ThenKind; label: string; description: string }> = [
  { kind: 'reduce', label: 'Reduce a position by a share', description: 'Reduce-only, within your slippage' },
  { kind: 'close', label: 'Close a position', description: 'Reduce-only, the whole position' },
  { kind: 'reduceToBuffer', label: 'Trim until the buffer is back at', description: 'Sells only as much as it takes to reach your number' },
  { kind: 'reduceToLeverage', label: 'Cut leverage on a market to', description: 'Reduce-only, down to your leverage' },
  { kind: 'topUp', label: 'Top up from idle USDC', description: 'Moves your own idle USDC into the pool, up to your amount' },
  { kind: 'cancelOpeningOrders', label: 'Cancel orders that would add to a position', description: 'Only orders that open or grow a position' },
  { kind: 'alert', label: 'Alert me', description: 'In the app, and on Telegram if you linked it; no order' },
];
export const TARGET_OPTIONS: Array<{ kind: TargetKind; label: string }> = [
  { kind: 'first_position', label: 'Using the most margin' },
  { kind: 'worst_pnl', label: 'With the worst PnL' },
  { kind: 'all', label: 'Every position' },
  { kind: 'market', label: 'A market I choose' },
];
export const WINDOW_OPTIONS: Array<{ name: WindowName | ''; label: string }> = [
  { name: '', label: 'Any time' },
  ...(Object.keys(FIXED_WINDOWS) as WindowName[]).map((name) => ({ name, label: FIXED_WINDOWS[name].label })),
];

export const needsTarget = (k: ThenKind) => k === 'reduce' || k === 'close';

/** Parses a typed number; '' and anything not a finite number are null. */
const num = (s: string): number | null => {
  const t = s.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export type BuildResult = { ok: true; rule: Rule } | { ok: false; problem: string };

/** The form as a rule, or the first thing the user still has to type. */
export function buildRule(f: RuleForm, id: string): BuildResult {
  let when: Trigger;
  switch (f.when) {
    case 'buffer': {
      const line = num(f.line);
      if (line === null) return { ok: false, problem: 'Type the line.' };
      if (!(line > 1)) return { ok: false, problem: 'The line must be above 1× (liquidation).' };
      when = { kind: 'buffer', below: line };
      break;
    }
    case 'drawdown': {
      const pct = num(f.drawdownPct);
      if (pct === null) return { ok: false, problem: 'Type how far the account value falls, in %.' };
      if (!(pct > 0 && pct < 100)) return { ok: false, problem: 'The fall must be between 0% and 100%.' };
      when = { kind: 'drawdown', atLeastPct: pct, baseline: f.window ? 'window_start' : 'rule_confirmed' };
      break;
    }
    case 'priceMove': {
      const pct = num(f.movePct);
      if (!f.market) return { ok: false, problem: 'Choose the market.' };
      if (pct === null) return { ok: false, problem: 'Type how far the price moves, in %.' };
      if (!(pct > 0 && pct < 100)) return { ok: false, problem: 'The move must be between 0% and 100%.' };
      when = { kind: 'priceMove', market: f.market, direction: f.direction, movePct: pct, from: f.window ? 'window_start' : 'rule_confirmed' };
      break;
    }
    case 'leverageAbove': {
      const lev = num(f.leverage);
      if (!f.market) return { ok: false, problem: 'Choose the market.' };
      if (lev === null || !(lev > 0)) return { ok: false, problem: 'Type the leverage.' };
      when = { kind: 'leverageAbove', market: f.market, leverage: lev };
      break;
    }
  }

  let target: Target | null = null;
  if (needsTarget(f.then)) {
    if (f.target === 'market') {
      if (!f.targetMarket) return { ok: false, problem: 'Choose which position.' };
      target = { kind: 'market', market: f.targetMarket };
    } else target = { kind: f.target } as Target;
  }
  let action: Action;
  switch (f.then) {
    case 'reduce': {
      const share = num(f.share);
      if (share === null) return { ok: false, problem: 'Type the share to reduce, in %.' };
      if (!(share > 0 && share <= 100)) return { ok: false, problem: 'The share must be above 0% and at most 100%.' };
      action = { kind: 'reduce', target: target!, fraction: +(share / 100).toPrecision(12) };
      break;
    }
    case 'close':
      action = { kind: 'close', target: target! };
      break;
    case 'reduceToBuffer': {
      const b = num(f.toBuffer);
      if (b === null) return { ok: false, problem: 'Type the buffer to trim back to.' };
      if (!(b > 1)) return { ok: false, problem: 'The buffer to trim back to must be above 1×.' };
      if (when.kind === 'buffer' && !(b > when.below)) return { ok: false, problem: 'Trim back to a buffer above the line, or the trim would not lift it.' };
      action = { kind: 'reduceToBuffer', buffer: b };
      break;
    }
    case 'reduceToLeverage': {
      const lev = num(f.toLeverage);
      if (!f.toLevMarket) return { ok: false, problem: 'Choose the market to cut leverage on.' };
      if (lev === null || !(lev > 0)) return { ok: false, problem: 'Type the leverage to cut to.' };
      action = { kind: 'reduceToLeverage', market: f.toLevMarket, leverage: lev };
      break;
    }
    case 'topUp': {
      const usdc = num(f.usdc);
      if (usdc === null || !(usdc > 0)) return { ok: false, problem: 'Type the USDC to move.' };
      action = { kind: 'topUp', maxUsdc: usdc };
      break;
    }
    case 'cancelOpeningOrders':
      action = { kind: 'cancelOpeningOrders' };
      break;
    case 'alert':
      action = { kind: 'alert' };
      break;
  }
  if (!f.repeat) return { ok: false, problem: REPEAT_UNSET };
  let limit: { times: number; perHours: number } | undefined;
  if (f.limitTimes.trim() || f.limitHours.trim()) {
    const times = num(f.limitTimes);
    const hours = num(f.limitHours);
    if (times === null || !Number.isInteger(times) || times < 1) return { ok: false, problem: 'Enter a whole number of actions' };
    if (hours === null || !(hours > 0)) return { ok: false, problem: 'Enter hours above 0' };
    limit = { times, perHours: hours };
  }
  const rule = { id, when, then: [action], ...(f.window ? { window: f.window } : {}), repeat: { mode: f.repeat, ...(limit ? { limit } : {}) } };
  const parsed = Rule.safeParse(rule);
  return parsed.success ? { ok: true, rule: parsed.data } : { ok: false, problem: parsed.error.issues[0]?.message ?? 'This rule is not valid.' };
}

/** A rule back as the form, for Edit; null when the form can't express it (several actions). */
export function formFromRule(r: Rule): RuleForm | null {
  if (r.then.length !== 1) return null;
  const f: RuleForm = { ...EMPTY_FORM, when: r.when.kind, window: r.window ?? '' };
  const w = r.when;
  if (w.kind === 'buffer') f.line = String(w.below);
  if (w.kind === 'drawdown') {
    // The form ties the baseline to the window; a rule that doesn't follow that is kept, not edited.
    if ((w.baseline === 'window_start') !== Boolean(r.window)) return null;
    f.drawdownPct = String(w.atLeastPct);
  }
  if (w.kind === 'priceMove') {
    if ((w.from === 'window_start') !== Boolean(r.window)) return null;
    Object.assign(f, { market: w.market, direction: w.direction, movePct: String(w.movePct) });
  }
  if (w.kind === 'leverageAbove') Object.assign(f, { market: w.market, leverage: String(w.leverage) });
  const a = r.then[0]!;
  f.then = a.kind;
  if (a.kind === 'reduce' || a.kind === 'close') {
    f.target = a.target.kind;
    if (a.target.kind === 'market') f.targetMarket = a.target.market;
  }
  if (a.kind === 'reduce') f.share = String(+(a.fraction * 100).toPrecision(12));
  if (a.kind === 'reduceToBuffer') f.toBuffer = String(a.buffer);
  if (a.kind === 'reduceToLeverage') Object.assign(f, { toLevMarket: a.market, toLeverage: String(a.leverage) });
  if (a.kind === 'topUp') f.usdc = String(a.maxUsdc);
  // An older rule has no choice yet: the form shows it unset, so the user must choose.
  if (r.repeat) Object.assign(f, { repeat: r.repeat.mode, limitTimes: r.repeat.limit ? String(r.repeat.limit.times) : '', limitHours: r.repeat.limit ? String(r.repeat.limit.perHours) : '' });
  return f;
}

/** A fresh rule id that isn't in use. */
export function nextRuleId(rules: readonly Rule[], prefix = 'hand'): string {
  const used = new Set(rules.map((r) => r.id));
  for (let i = 1; ; i++) if (!used.has(`${prefix}-${i}`)) return `${prefix}-${i}`;
}

/** Rules and slippage as the user is editing them, against the signed version. */
export interface PolicyDraft {
  rules: Rule[];
  slippage: string;
}

export function draftFrom(signed: Policy | null | undefined): PolicyDraft {
  return { rules: signed ? [...signed.rules] : [], slippage: signed ? String(signed.execution.maxSlippagePct) : '' };
}

/** What differs from the signed version, rule by rule. */
export function draftChanges(signed: Policy | null | undefined, d: PolicyDraft): { added: string[]; changed: string[]; removed: string[]; slippage: boolean; any: boolean } {
  const before = new Map((signed?.rules ?? []).map((r) => [r.id, JSON.stringify(r)]));
  const after = new Map(d.rules.map((r) => [r.id, JSON.stringify(r)]));
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const changed = [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id));
  const slippage = (num(d.slippage) ?? NaN) !== (signed?.execution.maxSlippagePct ?? NaN);
  return { added, changed, removed, slippage, any: Boolean(added.length || changed.length || removed.length || (slippage && d.slippage.trim() !== '')) };
}

/**
 * What stops the translator's draft from being signed as it is: edited, added or removed rules (signing the
 * draft would drop them), or a slippage the user typed that differs from the one the draft carries. On a
 * first policy the draft is made with the slippage the user typed, so that slippage alone never blocks it.
 */
export function translatorBlock(changes: ReturnType<typeof draftChanges>, d: PolicyDraft, draftSlippagePct: number): 'rules' | 'slippage' | null {
  if (changes.added.length || changes.changed.length || changes.removed.length) return 'rules';
  if (changes.slippage && d.slippage.trim() !== '' && num(d.slippage) !== draftSlippagePct) return 'slippage';
  return null;
}

export type DraftPolicyResult = { ok: true; policy: Policy } | { ok: false; problem: string };

/** The next policy version to sign, or what is still missing. */
export function draftPolicy(signed: Policy | null | undefined, d: PolicyDraft, account: string): DraftPolicyResult {
  const unchosen = d.rules.filter((r) => !r.repeat).length;
  if (unchosen) return { ok: false, problem: `${unchosen} rule${unchosen > 1 ? 's need' : ' needs'} your choice: once per fall, or every time the line is crossed.` };
  const slip = num(d.slippage);
  if (slip === null) return { ok: false, problem: 'Type the max slippage for guard orders.' };
  if (!(slip > 0 && slip <= 10)) return { ok: false, problem: 'Max slippage must be above 0% and at most 10%.' };
  const parsed = Policy.safeParse({ version: (signed?.version ?? 0) + 1, account: account.toLowerCase(), rules: d.rules, execution: { maxSlippagePct: slip } });
  return parsed.success ? { ok: true, policy: parsed.data } : { ok: false, problem: parsed.error.issues[0]?.message ?? 'This policy is not valid.' };
}
