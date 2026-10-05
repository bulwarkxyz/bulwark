'use client';

import { createContext, useContext, useEffect, useState } from 'react';

/**
 * Times across the app: UTC (the default) or the viewer's local time, chosen in Settings and kept in
 * this browser. Every timestamp the app shows goes through `useTimes().fmt`, and every "(UTC)" label
 * through `useTimes().label`, so the setting can't leave a stray UTC time behind.
 */
export type Zone = 'utc' | 'local';
const KEY = 'bw-times';
const TimesCtx = createContext<{ zone: Zone; setZone: (z: Zone) => void }>({ zone: 'utc', setZone: () => {} });

export function TimesProvider({ children }: { children: React.ReactNode }) {
  const [zone, setZoneState] = useState<Zone>('utc');
  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === 'local') setZoneState('local');
    } catch {
      // storage blocked: stay on UTC
    }
  }, []);
  const setZone = (z: Zone) => {
    setZoneState(z);
    try {
      localStorage.setItem(KEY, z);
    } catch {
      // storage blocked: the choice lasts for this visit
    }
  };
  return <TimesCtx.Provider value={{ zone, setZone }}>{children}</TimesCtx.Provider>;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Formats in the chosen zone. Shapes: 'full' 2026-10-05 08:00:00 · 'minute' 2026-10-05 08:00 · 'short' 10-05 08:00 · 'date' 2026-10-05 · 'clock' 08:00:00 */
export function formatTime(t: number, zone: Zone, shape: 'full' | 'minute' | 'short' | 'date' | 'clock'): string {
  const d = new Date(t);
  const [y, mo, da, h, mi, s] = zone === 'utc' ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()] : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  const date = `${y}-${pad(mo)}-${pad(da)}`;
  const hm = `${pad(h)}:${pad(mi)}`;
  switch (shape) {
    case 'full':
      return `${date} ${hm}:${pad(s)}`;
    case 'minute':
      return `${date} ${hm}`;
    case 'short':
      return `${pad(mo)}-${pad(da)} ${hm}`;
    case 'date':
      return date;
    case 'clock':
      return `${hm}:${pad(s)}`;
  }
}

export function useTimes() {
  const { zone, setZone } = useContext(TimesCtx);
  return {
    zone,
    setZone,
    utc: zone === 'utc',
    /** "UTC" or "local", for column headers: "Time (UTC)". */
    label: zone === 'utc' ? 'UTC' : 'local',
    fmt: (t: number, shape: Parameters<typeof formatTime>[2] = 'minute') => formatTime(t, zone, shape),
  };
}
