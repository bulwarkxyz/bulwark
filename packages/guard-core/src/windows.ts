/**
 * The fixed table: plain-language time words map to fixed windows here, never to numbers the AI picks.
 * Times follow the US equity session in America/New_York, so daylight saving is handled.
 * NYSE regular hours are 9:30–16:00 ET: https://www.nyse.com/markets/hours-calendars
 * (Exchange holidays are not modelled: a window still opens on a holiday; this only makes rules act earlier.)
 */
export const FIXED_WINDOWS = {
  /** Friday US close → Monday US open. */
  weekend: { label: 'Fri US close → Mon US open' },
  /** Each US close → next US open (weekday nights and the weekend). */
  overnight: { label: 'US close → next US open' },
  /** US regular session, weekdays 9:30–16:00 ET. */
  us_session: { label: 'US session, 9:30–16:00 ET weekdays' },
} as const;

export type WindowName = keyof typeof FIXED_WINDOWS;

const NY = 'America/New_York';
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

interface NyParts {
  weekday: number; // 0 Sun … 6 Sat
  minutes: number; // minutes since local midnight
}

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: NY, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function nyParts(t: number): NyParts {
  const parts = fmt.formatToParts(new Date(t));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return { weekday: WD[get('weekday')] ?? 0, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

function inSession(p: NyParts): boolean {
  return p.weekday >= 1 && p.weekday <= 5 && p.minutes >= OPEN_MIN && p.minutes < CLOSE_MIN;
}

export function windowContains(name: WindowName, t: number): boolean {
  const p = nyParts(t);
  switch (name) {
    case 'us_session':
      return inSession(p);
    case 'overnight':
      return !inSession(p);
    case 'weekend':
      return (p.weekday === 5 && p.minutes >= CLOSE_MIN) || p.weekday === 6 || p.weekday === 0 || (p.weekday === 1 && p.minutes < OPEN_MIN);
  }
}

/**
 * Start time of the window instance containing `t` (ms), found by stepping back minute by minute.
 * Returns null when `t` is not inside the window.
 */
export function windowStart(name: WindowName, t: number): number | null {
  if (!windowContains(name, t)) return null;
  const minute = 60_000;
  let cur = Math.floor(t / minute) * minute;
  for (let i = 0; i < 4 * 24 * 60; i++) {
    const prev = cur - minute;
    if (!windowContains(name, prev)) return cur;
    cur = prev;
  }
  return cur;
}
