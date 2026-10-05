import { describe, expect, it } from 'vitest';
import { formatTime } from '@/lib/time';

const T = Date.UTC(2026, 9, 5, 8, 7, 9);

describe('times: UTC or local, one formatter for every timestamp', () => {
  it('formats every shape in UTC', () => {
    expect(formatTime(T, 'utc', 'full')).toBe('2026-10-05 08:07:09');
    expect(formatTime(T, 'utc', 'minute')).toBe('2026-10-05 08:07');
    expect(formatTime(T, 'utc', 'short')).toBe('10-05 08:07');
    expect(formatTime(T, 'utc', 'date')).toBe('2026-10-05');
    expect(formatTime(T, 'utc', 'clock')).toBe('08:07:09');
  });
  it('local follows the viewer’s offset', () => {
    const d = new Date(T);
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(formatTime(T, 'local', 'clock')).toBe(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
  });
  it('no place in the app shows a time formatted on its own (file names aside)', async () => {
    const { execSync } = await import('node:child_process');
    const hits = execSync("grep -rn 'toISOString()' app components lib || true", { cwd: new URL('..', import.meta.url).pathname })
      .toString()
      .split('\n')
      .filter((l) => l && !l.includes('.download ='));
    expect(hits).toEqual([]);
  });
});
