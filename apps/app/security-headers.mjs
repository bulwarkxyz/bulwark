/**
 * Security headers for every app response. The Content Security Policy's main job is containment: the
 * trading key lives in this browser's storage, so even a script injected into the page must not be able
 * to send anything to a host that isn't listed here (connect-src, img-src, form-action, frame-src).
 *
 * BW_CSP switches the policy: "report" (the default) sends it as Content-Security-Policy-Report-Only, so a
 * browser blocks nothing and reports what it would have blocked to /app/csp-report; "enforce" sends it as
 * Content-Security-Policy; "off" leaves it out. The other headers don't depend on the switch.
 */
const HL = ['https://api.hyperliquid-testnet.xyz', 'wss://api.hyperliquid-testnet.xyz', 'https://api.hyperliquid.xyz', 'wss://api.hyperliquid.xyz'];
// WalletConnect and Reown: relay, RPC, wallet list and its images, verify iframe, analytics pulse.
const WC = ['https://*.walletconnect.com', 'wss://*.walletconnect.com', 'https://*.walletconnect.org', 'wss://*.walletconnect.org', 'https://*.reown.com', 'wss://*.reown.com', 'https://api.web3modal.org', 'https://api.web3modal.com'];
// The wallet's chains (viem's default RPCs for Arbitrum and Ethereum: signatures name a chain, ENS names).
const RPC = ['https://arb1.arbitrum.io', 'https://ethereum.reth.rs'];

export function contentSecurityPolicy({ dev = false } = {}) {
  const d = {
    'default-src': ["'self'"],
    // Next's pages carry inline bootstrap scripts; dev adds eval for fast refresh.
    'script-src': ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', ...WC.filter((h) => h.startsWith('https:'))],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", ...HL, ...WC, ...RPC, ...(dev ? ['ws://localhost:*'] : [])],
    'frame-src': ['https://verify.walletconnect.com', 'https://verify.walletconnect.org', 'https://secure.walletconnect.org', 'https://secure.walletconnect.com'],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'report-uri': ['/app/csp-report'],
  };
  return Object.entries(d)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}

export function securityHeaders({ mode = process.env.BW_CSP ?? 'report', dev = process.env.NODE_ENV !== 'production' } = {}) {
  const h = [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  ];
  if (mode === 'report') h.push({ key: 'Content-Security-Policy-Report-Only', value: contentSecurityPolicy({ dev }) });
  if (mode === 'enforce') h.push({ key: 'Content-Security-Policy', value: contentSecurityPolicy({ dev }) });
  return h;
}
