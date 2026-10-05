import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Served as a zone under the main site at /docs (the landing forwards /docs here).
  basePath: '/docs',
  devIndicators: false,
};

export default withMDX(config);
