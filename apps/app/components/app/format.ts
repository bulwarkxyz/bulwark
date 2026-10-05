// Number formatters, one per digit count: toLocaleString with options builds a new one on every call,
// and the order book and tables format hundreds of numbers per update.
const NF = new Map<number, Intl.NumberFormat>();
export function fixed(n: number, digits: number): string {
  let f = NF.get(digits);
  if (!f) NF.set(digits, (f = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })));
  return f.format(n);
}

export const shortAddr = (a: string) => `${a.slice(0, 5)}…${a.slice(-4)}`;

export function fmtUsd(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${fixed(abs, digits)}`;
}

export function fmtSignedUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '−'}${fmtUsd(Math.abs(n)).replace('$', '$')}`;
}

export function fmtPct(n: number, digits = 2, signed = true): string {
  if (!Number.isFinite(n)) return '—';
  const v = n.toFixed(digits);
  return `${signed && n > 0 ? '+' : n < 0 ? '−' : ''}${v.replace('-', '')}%`;
}

/** Prices: as many significant digits as the exchange shows (5), no trailing noise. */
export function fmtPx(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const digits = n >= 10000 ? 0 : n >= 1000 ? 1 : n >= 100 ? 2 : n >= 1 ? 3 : 6;
  return fixed(n, digits);
}

export function fmtBuffer(b: number): string {
  if (!Number.isFinite(b)) return '—';
  return `${b >= 100 ? b.toFixed(0) : b.toFixed(2)}×`;
}

export const upDown = (n: number) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
