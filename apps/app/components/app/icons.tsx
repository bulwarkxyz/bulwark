const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const Icon = {
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

export function BrandMark() {
  return (
    <span className="mark">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />
      </svg>
    </span>
  );
}
