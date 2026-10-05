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
};

export const WHEN_OPTIONS: Array<{ kind: WhenKind; label: string }> = [
  { kind: 'buffer', label: 'Buffer falls below' },
  { kind: 'drawdown', label: 'Account value falls by' },
  { kind: 'priceMove', label: 'A market’s price moves' },
  { kind: 'leverageAbove', label: 'Leverage on a market goes above' },
];
export const THEN_OPTIONS: Array<{ kind: ThenKind; label: string }> = [
  { kind: 'reduce', label: 'Reduce a position by a share' },
  { kind: 'close', label: 'Close a position' },
  { kind: 'reduceToBuffer', label: 'Trim until the buffer is back at' },
  { kind: 'reduceToLeverage', label: 'Cut leverage on a market to' },
  { kind: 'topUp', label: 'Top up from idle USDC' },
  { kind: 'cancelOpeningOrders', label: 'Cancel orders that would add to a position' },
  { kind: 'alert', label: 'Alert me' },
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
  const rule = { id, when, then: [action], ...(f.window ? { window: f.window } : {}) };
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

export type DraftPolicyResult = { ok: true; policy: Policy } | { ok: false; problem: string };

/** The next policy version to sign, or what is still missing. */
export function draftPolicy(signed: Policy | null | undefined, d: PolicyDraft, account: string): DraftPolicyResult {
  const slip = num(d.slippage);
  if (slip === null) return { ok: false, problem: 'Type the max slippage for guard orders.' };
  if (!(slip > 0 && slip <= 10)) return { ok: false, problem: 'Max slippage must be above 0% and at most 10%.' };
  const parsed = Policy.safeParse({ version: (signed?.version ?? 0) + 1, account: account.toLowerCase(), rules: d.rules, execution: { maxSlippagePct: slip } });
  return parsed.success ? { ok: true, policy: parsed.data } : { ok: false, problem: parsed.error.issues[0]?.message ?? 'This policy is not valid.' };
}
