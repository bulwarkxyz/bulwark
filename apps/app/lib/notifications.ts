import type { AuditEntry } from '@bulwarkxyz/store/audit';
import { marketByCoin } from './markets';

/**
 * Notifications are the alerts feed (audit entries of kind `alert` and `degraded`, CONTRACT.md › Alerts),
 * sorted into the kinds a trader needs to tell apart at a glance, each with a link to what it is about.
 * What the worker writes (apps/worker/src/guard.ts):
 * - a liquidation Hyperliquid reported: proof.fill with the coin;
 * - stages that need a choice: why = "A new setting needs your choice", proof.ruleIds;
 * - an alert rule firing, or the guard unable to act: proof.ruleId;
 * - the guard holding off on stale data: kind `degraded`.
 */
export type NotificationType = 'liquidation' | 'choice' | 'alert' | 'heldOff';

export const TYPE_LABEL: Record<NotificationType, string> = { liquidation: 'Liquidation', choice: 'Needs your choice', alert: 'Alert', heldOff: 'Held off' };
/** Chip class by the app's colour rule: red for danger and the guard paused, amber for lines near. */
export const TYPE_CHIP: Record<NotificationType, string> = { liquidation: 'chip-risk', choice: 'chip-acting', alert: 'chip-acting', heldOff: 'chip-risk' };

export interface Notification {
  seq: number;
  at: number;
  type: NotificationType;
  /** One line: what happened. */
  title: string;
  /** Why, in one line. */
  detail: string;
  /** What it's about: the position, the rule, or the audit entry itself. */
  href: string;
  hrefLabel: string;
  /** The entry in the audit log, always. */
  auditHref: string;
  example: boolean;
}

const CHOICE_WHY = 'A new setting needs your choice';

/** A feed entry: an audit entry plus the API's link fields (null when unknown). */
export type AlertEntry = AuditEntry & { ruleId?: string | null; coin?: string | null };

export function classify(e: AlertEntry): Notification {
  const proof = (e.proof ?? {}) as { fill?: { coin?: string }; ruleIds?: string[]; ruleId?: string; coin?: string };
  // The API's fields first; older entries carry the same in proof.
  const ruleId = e.ruleId ?? proof.ruleId ?? proof.ruleIds?.[0] ?? null;
  const coin = e.coin ?? proof.fill?.coin ?? proof.coin ?? null;
  const auditHref = `/app/audit?seq=${e.seq}`;
  const base = { seq: e.seq, at: e.at, title: e.what, detail: e.why, auditHref, example: String(e.hash).startsWith('example-') };
  if (e.kind === 'degraded') return { ...base, type: 'heldOff', href: auditHref, hrefLabel: 'Audit entry' };
  if (proof.fill) {
    const m = coin ? marketByCoin(coin) : undefined;
    return { ...base, type: 'liquidation', href: m ? `/app/positions?coin=${encodeURIComponent(m.coin)}` : '/app/positions', hrefLabel: m ? `${m.ticker} in Positions` : 'Positions' };
  }
  if (e.why === CHOICE_WHY || proof.ruleIds?.length) return { ...base, type: 'choice', href: ruleId ? `/app/rules#rule-${ruleId}` : '/app/rules', hrefLabel: 'Choose in Guard rules' };
  if (ruleId) return { ...base, type: 'alert', href: `/app/rules#rule-${ruleId}`, hrefLabel: 'The rule' };
  if (coin) {
    const m = marketByCoin(coin);
    if (m) return { ...base, type: 'alert', href: `/app/positions?coin=${encodeURIComponent(m.coin)}`, hrefLabel: `${m.ticker} in Positions` };
  }
  return { ...base, type: 'alert', href: auditHref, hrefLabel: 'Audit entry' };
}

/** The badge: the number up to 99, then "99+". */
export const badge = (n: number) => (n > 99 ? '99+' : String(n));

export type DateRange = 'today' | '7d' | '30d' | 'all';
export const RANGE_LABEL: Record<DateRange, string> = { today: 'Today', '7d': '7 days', '30d': '30 days', all: 'All' };
/** The start of a range, in ms (local midnight for "today"). */
export function rangeStart(r: DateRange, now: number): number | null {
  if (r === 'all') return null;
  if (r === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return now - (r === '7d' ? 7 : 30) * 86_400_000;
}

/**
 * Read state: everything up to an alert seq (the server's marker, GET/POST /v1/alerts/seen, so it follows
 * the user across devices), plus single alerts opened since, kept on this device.
 */
export interface ReadState {
  upTo: number;
  seqs: number[];
}
export const isRead = (n: Pick<Notification, 'seq'>, r: ReadState) => n.seq <= r.upTo || r.seqs.includes(n.seq);
export const markOne = (r: ReadState, seq: number): ReadState => (r.seqs.includes(seq) ? r : { ...r, seqs: [...r.seqs, seq].slice(-200) });
export const markAll = (items: readonly Pick<Notification, 'seq'>[], r: ReadState): ReadState => {
  const upTo = Math.max(r.upTo, ...items.map((n) => n.seq));
  return { upTo, seqs: r.seqs.filter((s) => s > upTo) };
};
