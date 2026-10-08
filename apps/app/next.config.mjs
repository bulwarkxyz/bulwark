import { securityHeaders } from './security-headers.mjs';

/**
 * Review mode (lib/review.tsx) is for design-review previews only. It is on only when the build sets
 * NEXT_PUBLIC_REVIEW_MODE=1 and the deployment is not Vercel production; the value is inlined at build
 * time, so in every other build the review code is a dead branch the bundler removes
 * (proved by scripts/review-mode-check.mjs).
 */
const reviewMode = process.env.VERCEL_ENV !== 'production' && process.env.NEXT_PUBLIC_REVIEW_MODE === '1' ? '1' : '0';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript-built ESM; let Next compile them with the app.
  transpilePackages: ['@bulwarkxyz/guard-core', '@bulwarkxyz/hyperliquid', '@bulwarkxyz/config', '@bulwarkxyz/store', '@bulwarkxyz/compiler'],
  devIndicators: false,
  // Source maps in the browser only for local CPU profiling (PROFILE_SOURCEMAPS=1 next build); never in a deploy.
  productionBrowserSourceMaps: process.env.PROFILE_SOURCEMAPS === '1',
  // Served as a zone under the landing site: /app and /api/bw route here; assets live under /app-static.
  assetPrefix: '/app-static',
  env: { NEXT_PUBLIC_REVIEW_MODE: reviewMode },
  // No smart-contract wallets (lib/wallet.tsx): their SDKs are replaced by an empty module, which also
  // keeps their optional dependencies (x402, Solana) out of the build.
  turbopack: { resolveAlias: { '@base-org/account': './lib/no-smart-wallets.js', '@coinbase/wallet-sdk': './lib/no-smart-wallets.js' } },
  // Security headers on every response (security-headers.mjs). Review previews are shared by link only:
  // never indexed, whatever the host does by default.
  headers: async () => [{ source: '/:path*', headers: [...securityHeaders(), ...(reviewMode === '1' ? [{ key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' }] : [])] }],
};

export default nextConfig;
