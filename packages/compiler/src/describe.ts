import { FIXED_WINDOWS, type Action, type Rule, type Target, type Trigger } from '@bulwarkxyz/guard-core';

/**
 * Deterministic plain-English text for a rule, built from its structure only. The UI shows this,
 * never the model's own wording, so every number on screen comes from the rule (and so from the user).
 */

const coin = (c: string) => c.replace(/^xyz:/, '');
const pct = (n: number) => `${+(n * 100).toFixed(6)}%`;

function target(t: Target): string {
  switch (t.kind) {
    case 'first_position':
      return 'the position using the most margin';
    case 'worst_pnl':
      return 'the position with the worst unrealised PnL';
    case 'all':
      return 'every position';
    case 'market':
      return `the ${coin(t.market)} position`;
  }
}

export function describeTrigger(w: Trigger): string {
  switch (w.kind) {
    case 'buffer':
      return `the buffer falls below ${w.below}×`;
    case 'drawdown':
      return `account value is down ${w.atLeastPct}% or more since ${w.baseline === 'window_start' ? 'the window opened' : 'you signed the rule'}`;
    case 'priceMove':
      return `${coin(w.market)} moves ${w.direction} ${w.movePct}% or more since ${w.from === 'window_start' ? 'the window opened' : 'you signed the rule'}`;
    case 'leverageAbove':
      return `${coin(w.market)} leverage is above ${w.leverage}×`;
  }
}

export function describeAction(a: Action): string {
  switch (a.kind) {
    case 'reduce':
      return `cut ${target(a.target)} by ${pct(a.fraction)}`;
    case 'close':
      return `close ${target(a.target)}`;
    case 'reduceToBuffer':
      return `trim until the buffer is back at ${a.buffer}×`;
    case 'reduceToLeverage':
      return `trim ${coin(a.market)} to ${a.leverage}× leverage`;
    case 'topUp':
      return `move ${a.maxUsdc} USDC from your idle balance into the pool`;
    case 'cancelOpeningOrders':
      return 'cancel orders that would add to a position';
    case 'alert':
      return 'alert you';
  }
}

export function describeRepeat(r: Pick<Rule, 'repeat'>): string {
  if (!r.repeat) return 'Repeat not chosen yet: acts every time the line is crossed until you choose.';
  const limit = r.repeat.limit ? ` At most ${r.repeat.limit.times} time${r.repeat.limit.times > 1 ? 's' : ''} in ${r.repeat.limit.perHours} hours.` : '';
  return (r.repeat.mode === 'oncePerBreach' ? 'Acts once per fall, then leaves the rest to the backstop.' : 'Acts every time the line is crossed.') + limit;
}

export function describeRule(r: Pick<Rule, 'when' | 'then' | 'window'> & Partial<Pick<Rule, 'repeat'>>): string {
  const during = r.window ? `${FIXED_WINDOWS[r.window].label}: w` : 'W';
  const acts = r.then.map(describeAction);
  const list = acts.length > 1 ? `${acts.slice(0, -1).join(', ')} and ${acts[acts.length - 1]}` : acts[0];
  return `${during}hen ${describeTrigger(r.when)}, ${list}.${'repeat' in r ? ` ${describeRepeat(r)}` : ''}`;
}
