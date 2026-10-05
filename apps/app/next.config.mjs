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
  // Served as a zone under the landing site: /app and /api/bw route here; assets live under /app-static.
  assetPrefix: '/app-static',
  env: { NEXT_PUBLIC_REVIEW_MODE: reviewMode },
  // Review previews are shared by link only: never indexed, whatever the host does by default.
  ...(reviewMode === '1' ? { headers: async () => [{ source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' }] }] } : {}),
};

export default nextConfig;
