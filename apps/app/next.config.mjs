/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript-built ESM; let Next compile them with the app.
  transpilePackages: ['@bulwarkxyz/guard-core', '@bulwarkxyz/hyperliquid', '@bulwarkxyz/config', '@bulwarkxyz/store', '@bulwarkxyz/compiler'],
  devIndicators: false,
};

export default nextConfig;
