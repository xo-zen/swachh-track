import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@swachh/contracts', '@swachh/domain', '@swachh/ui'],
  poweredByHeader: false,
  async rewrites() {
    const origin = (process.env.API_INTERNAL_URL || 'http://localhost:4000').replace(/\/$/, '');
    return [{ source: '/api/v1/:path*', destination: `${origin}/api/v1/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }];
  },
};
export default config;
