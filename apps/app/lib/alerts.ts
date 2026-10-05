'use client';

import type { AuditEntry } from '@bulwarkxyz/store/audit';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, useSignedIn } from './api';
import { useMe } from './me';
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

export function useAlertFeed(enabled: boolean) {
  const { address } = useViewer();
  const review = useReview();
  return useQuery({
    queryKey: ['alerts', address, review.on],
    enabled,
    queryFn: () => (review.on ? Promise.resolve(reviewAlerts()) : api<AuditEntry[]>('/v1/alerts?limit=20')),
    refetchInterval: 30_000,
  });
}

/** Review builds only: example alerts, labelled as examples on screen. */
function reviewAlerts(): AuditEntry[] {
  const t = Date.now();
  const e = (seq: number, mins: number, kind: string, what: string, why: string) => ({ seq, at: t - mins * 60_000, kind, what, why, hash: `example-${seq}`, prevHash: `example-${seq - 1}` }) as unknown as AuditEntry;
  return [
    e(3, 4, 'alert', 'Example: GOLD pool buffer 2.96×, below your 3× line.', 'Your alert rule at 3×.'),
    e(2, 60, 'degraded', 'Example: held off for 9 s after a reconnect.', 'Marks were 12 s old.'),
    e(1, 300, 'alert', 'Example: reduce order for GOLD has not fully filled after 3 attempts. The guard keeps trying while the line is crossed.', 'Buffer below your 2.5× line.'),
  ];
}

/** Alerts newer than the last time the user looked, on this device. */
export function useUnseenAlerts() {
  const { address } = useViewer();
  const settings = useAlertSettings();
  const on = Boolean(settings.data?.inApp);
  const feed = useAlertFeed(on);
  const key = `bw-alerts-seen.${(address ?? '').toLowerCase()}`;
  const [seenAt, setSeenAt] = useState(0);
  useEffect(() => {
    try {
      setSeenAt(Number(localStorage.getItem(key) ?? 0));
    } catch {
      setSeenAt(0);
    }
  }, [key]);
  const unseen = on ? (feed.data ?? []).filter((e) => e.at > seenAt).length : 0;
  const markSeen = () => {
    const newest = Math.max(0, ...(feed.data ?? []).map((e) => e.at));
    setSeenAt(newest);
    try {
      localStorage.setItem(key, String(newest));
    } catch {
      // storage blocked: the count resets on reload
    }
  };
  return { on, unseen, markSeen };
}
