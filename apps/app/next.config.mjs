/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript-built ESM; let Next compile them with the app.
  transpilePackages: ['@bulwarkxyz/guard-core', '@bulwarkxyz/hyperliquid', '@bulwarkxyz/config', '@bulwarkxyz/store', '@bulwarkxyz/compiler'],
  devIndicators: false,
  // Served as a zone under the landing site: /app and /api/bw route here; assets live under /app-static.
  assetPrefix: '/app-static',
};

export default nextConfig;
