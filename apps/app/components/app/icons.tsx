const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const Icon = {
  shieldCheck: (s = 13) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base} strokeWidth={2.2}>
      <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </svg>
  ),
  shieldAlert: (s = 13) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base} strokeWidth={2.2}>
      <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  ),
  pause: (s = 13) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base} strokeWidth={2.2}>
      <path d="M9 5v14M15 5v14" />
    </svg>
  ),
  stop: (s = 12) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base} strokeWidth={2.4}>
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  ),
  moon: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />
    </svg>
  ),
  alert: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base} strokeWidth={2}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </svg>
  ),
  lock: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base} strokeWidth={2}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  ),
  lines: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base} strokeWidth={2}>
      <path d="M4 6h16M4 12h10M4 18h7" />
    </svg>
  ),
  check: (s = 12) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base} strokeWidth={2.4}>
      <path d="M5 12l4 4 10-10" />
    </svg>
  ),
  caret: (s = 12) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base} strokeWidth={2}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  shield: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base}>
      <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />
    </svg>
  ),
  markets: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base}>
      <path d="M3 3v18h18" />
      <path d="M7 15l4-4 3 3 5-6" />
    </svg>
  ),
  trade: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base}>
      <path d="M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3" />
    </svg>
  ),
  positions: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base}>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
    </svg>
  ),
  simulator: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base}>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </svg>
  ),
  account: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base}>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18M16 14.5h2" />
    </svg>
  ),
  audit: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base}>
      <path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  ),
  settings: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base}>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </svg>
  ),
  more: (s = 20) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base}>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  ),
  info: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8h.01M11 12h1v5h1" />
    </svg>
  ),
  clock: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
};

/** The logo is neutral: lime means "protected" and nothing else. */
export function BrandMark() {
  return (
    <span className="mark" style={{ display: 'grid', placeItems: 'center' }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />
      </svg>
    </span>
  );
}
