/**
 * Region policy — the one place the lists live.
 *
 * blocked:  no access at all. Required by upstream terms (trade.xyz Restricted Persons:
 *           https://trade.xyz/terms ; Hyperliquid app terms: https://app.hyperliquid.xyz/terms),
 *           OFAC comprehensive sanctions (https://ofac.treasury.gov/sanctions-programs-and-country-information),
 *           plus Russia and Belarus (EU Reg. 833/2014 Art. 5b).
 * guardOff: trading and alerts allowed, automatic guard off (decision D4: EU/EEA).
 * Not blocked yet (with counsel): India, Singapore, mainland China, South Korea, Belgium.
 *
 * Codes are ISO 3166-1 alpha-2; subdivisions are ISO 3166-2.
 */
export const BLOCKED_COUNTRIES: ReadonlySet<string> = new Set([
  // United States and its territories
  'US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM',
  'CA', // Canada (all provinces; trade.xyz)
  'GB', // United Kingdom
  'CU', 'IR', 'KP', 'SY', 'MM', // sanctioned or named in upstream terms
  'RU', 'BY',
]);

/** Sanctioned subdivisions of countries that are otherwise allowed. */
export const BLOCKED_SUBDIVISIONS: ReadonlySet<string> = new Set([
  'UA-43', // Crimea
  'UA-40', // Sevastopol
  'UA-14', // Donetsk
  'UA-09', // Luhansk
]);

/** EU member states plus EEA (Iceland, Liechtenstein, Norway). */
export const GUARD_OFF_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
]);

export type RegionVerdict = 'blocked' | 'guardOff' | 'allowed';

/**
 * Verdict for a country and optional subdivision. Vercel sends the subdivision without the country
 * prefix (`x-vercel-ip-country-region`, https://vercel.com/docs/headers/request-headers), so both
 * `43` and `UA-43` are accepted.
 */
export function regionVerdict(country: string | null | undefined, subdivision?: string | null): RegionVerdict {
  const c = (country ?? '').trim().toUpperCase();
  if (!c) return 'blocked'; // unknown location: fail closed
  if (BLOCKED_COUNTRIES.has(c)) return 'blocked';
  if (subdivision) {
    const s = subdivision.trim().toUpperCase();
    const full = s.includes('-') ? s : `${c}-${s}`;
    if (BLOCKED_SUBDIVISIONS.has(full)) return 'blocked';
  }
  if (GUARD_OFF_COUNTRIES.has(c)) return 'guardOff';
  return 'allowed';
}

/**
 * The strictest of several signals (IP location, declared residency, declared citizenship).
 * Upstream terms also restrict citizens of restricted territories wherever they live.
 */
export function strictestVerdict(...verdicts: RegionVerdict[]): RegionVerdict {
  if (verdicts.includes('blocked')) return 'blocked';
  if (verdicts.includes('guardOff')) return 'guardOff';
  return 'allowed';
}

/**
 * The verdict for an account now: the strictest of its declared residency and citizenship and the country of its
 * latest request (the app's proxy). Checked at every guard action, not only at onboarding. An account with no
 * declarations (onboarded before they were asked) keeps its stored verdict as one of the signals.
 */
export function currentVerdict(u: { region?: RegionVerdict | null; residency?: string | null; citizenship?: string | null; lastCountry?: string | null; lastSubdivision?: string | null }): RegionVerdict {
  const signals: RegionVerdict[] = [];
  if (u.residency) signals.push(regionVerdict(u.residency));
  if (u.citizenship) signals.push(regionVerdict(u.citizenship));
  if (u.lastCountry) signals.push(regionVerdict(u.lastCountry, u.lastSubdivision));
  if (!u.residency && !u.citizenship && u.region) signals.push(u.region);
  return signals.length ? strictestVerdict(...signals) : 'blocked';
}
