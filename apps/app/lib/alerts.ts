'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api, useSignedIn } from './api';
import { useMe } from './me';
import { type AlertEntry, type Notification, type ReadState, classify, isRead, markAll, markOne } from './notifications';
import { useReview, useViewer } from './review';

/**
 * In-app alerts (apps/api/CONTRACT.md, Alerts): the setting, the feed (audit entries of kind `alert` and
 * `degraded`, newest first) and Telegram's link state. The setting only decides whether the app shows
 * them; Telegram gets the same messages whenever it is linked.
 */
export interface AlertSettings {
  inApp: boolean;
  telegram: { linked: boolean };
}

export function useAlertSettings() {
  const signedIn = useSignedIn();
  const review = useReview();
  const me = useMe();
  return useQuery({
    queryKey: ['alert-settings', me.data?.account, review.on],
    enabled: Boolean((signedIn || review.on) && me.data?.user),
    // Review builds only: in-app on, Telegram not linked.
    queryFn: () => (review.on ? Promise.resolve<AlertSettings>({ inApp: true, telegram: { linked: false } }) : api<AlertSettings>('/v1/settings/alerts')),
  });
}

export function useAlertActions() {
  const qc = useQueryClient();
  return {
    setInApp: async (inApp: boolean) => {
      await api('/v1/settings/alerts', { method: 'PUT', body: { inApp } });
      await qc.invalidateQueries({ queryKey: ['alert-settings'] });
    },
    unlinkTelegram: async () => {
      await api('/v1/telegram', { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['alert-settings'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
  };
}


/** Review builds only: example alerts, labelled as examples on screen. */
function reviewAlerts(): AlertEntry[] {
  const t = Date.now();
  const e = (seq: number, mins: number, kind: string, what: string, why: string, link: { ruleId?: string; coin?: string; proof?: Record<string, unknown> } = {}) =>
    ({ seq, at: t - mins * 60_000, kind, what, why, hash: `example-${seq}`, prevHash: `example-${seq - 1}`, ruleId: link.ruleId ?? null, coin: link.coin ?? null, proof: link.proof }) as unknown as AlertEntry;
  // Links match the example rules (stage-1…3, lib/review.tsx) and the watched account's GOLD position.
  return [
    e(5, 4, 'alert', 'Example: GOLD pool buffer 2.96×, below your 3× line.', 'Your alert rule at 3×.', { ruleId: 'stage-1', coin: 'xyz:GOLD' }),
    e(4, 38, 'alert', 'Example: 1 of your stages (stage-3) needs a choice: act once per fall, or every time the line is crossed.', 'A new setting needs your choice', { ruleId: 'stage-3', proof: { ruleIds: ['stage-3'] } }),
    e(3, 60, 'degraded', 'Example: held off for 9 s after a reconnect.', 'Marks were 12 s old.'),
    e(2, 300, 'alert', 'Example: reduce order for GOLD has not fully filled after 3 attempts. The guard keeps trying while the line is crossed.', 'Buffer below your 2.5× line.', { ruleId: 'stage-2', coin: 'xyz:GOLD' }),
    e(1, 60 * 30, 'alert', 'Example: Hyperliquid liquidated 0.02 SILVER at 31.40.', 'Liquidation reported by the exchange', { coin: 'xyz:SILVER', proof: { fill: { coin: 'xyz:SILVER', sz: '0.02', px: '31.40' } } }),
  ];
}

// ------------------------------------------------------------------ notifications (the bell and its page)

const localKey = (address: string) => `bw-alerts-read.${address.toLowerCase()}`;
const readListeners = new Set<() => void>();
const localCache = new Map<string, number[]>();
function localSeqs(address: string): number[] {
  const k = localKey(address);
  if (!localCache.has(k)) {
    try {
      localCache.set(k, JSON.parse(localStorage.getItem(k) ?? '[]') as number[]);
    } catch {
      localCache.set(k, []);
    }
  }
  return localCache.get(k)!;
}
function setLocalSeqs(address: string, seqs: number[]) {
  const k = localKey(address);
  localCache.set(k, seqs);
  try {
    localStorage.setItem(k, JSON.stringify(seqs));
  } catch {
    // storage blocked: single reads last until reload
  }
  for (const fn of readListeners) fn();
}
const onRead = (fn: () => void) => {
  readListeners.add(fn);
  return () => {
    readListeners.delete(fn);
  };
};

/**
 * The bell and the notifications page share this: the feed sorted into notifications, which are read,
 * how many are not, and marking them. "Mark all read" moves the server's marker (POST /v1/alerts/seen),
 * so it holds on every device; opening one alert marks just that one, on this device.
 */
export function useNotifications({ limit = 50, since }: { limit?: number; since?: number | null } = {}) {
  const { address } = useViewer();
  const review = useReview();
  const signedIn = useSignedIn();
  const me = useMe();
  const settings = useAlertSettings();
  const qc = useQueryClient();
  const ready = Boolean(address && (signedIn || review.on) && me.data?.user);
  const on = ready && Boolean(settings.data?.inApp);
  const feed = useQuery({
    queryKey: ['alerts', address, review.on, limit, since ?? null],
    enabled: on,
    queryFn: () => (review.on ? Promise.resolve(reviewAlerts()) : api<AlertEntry[]>(`/v1/alerts?limit=${limit}${since ? `&since=${since}` : ''}`)),
    refetchInterval: 30_000,
  });
  const seen = useQuery({
    queryKey: ['alerts-seen', address, review.on],
    enabled: on,
    // Review builds: nothing read yet, kept in memory.
    queryFn: () => (review.on ? Promise.resolve({ upTo: 0, unread: 0 }) : api<{ upTo: number; unread: number }>('/v1/alerts/seen')),
    refetchInterval: 30_000,
  });
  const seqs = useSyncExternalStore(
    onRead,
    () => (address ? localSeqs(address) : EMPTY),
    () => EMPTY,
  );
  const state: ReadState = { upTo: seen.data?.upTo ?? 0, seqs };
  const items = (feed.data ?? []).map(classify).sort((a, b) => b.seq - a.seq);
  const unreadShown = items.filter((n) => !isRead(n, state)).length;
  // The server counts unread among the latest 500; the feed shows fewer. Use whichever is larger.
  const unread = on ? Math.max(unreadShown, seen.data ? Math.max(0, seen.data.unread - state.seqs.filter((s) => s > state.upTo).length) : 0) : 0;
  return {
    ready,
    on,
    settings,
    feed,
    items,
    unread,
    isRead: (n: Notification) => isRead(n, state),
    markRead: (seq: number) => address && setLocalSeqs(address, markOne(state, seq).seqs),
    markAllRead: async () => {
      if (!address || !items.length) return;
      const next = markAll(items, state);
      qc.setQueryData(['alerts-seen', address, review.on], { upTo: next.upTo, unread: 0 });
      setLocalSeqs(address, next.seqs);
      if (!review.on) await api('/v1/alerts/seen', { body: { upTo: next.upTo } }).catch(() => qc.invalidateQueries({ queryKey: ['alerts-seen'] }));
    },
  };
}
const EMPTY: number[] = [];
