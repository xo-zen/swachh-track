import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../../next.config';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('same-origin API routing', () => {
  it('defaults browser requests to the web origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', ''); vi.resetModules();
    expect((await import('./api')).API_URL).toBe('/api/v1');
  });
  it('preserves an explicit public API override', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test/api/v1/'); vi.resetModules();
    expect((await import('./api')).API_URL).toBe('https://api.example.test/api/v1');
  });
  it('rewrites API requests to the default internal server', async () => {
    vi.stubEnv('API_INTERNAL_URL', '');
    expect(await config.rewrites?.()).toEqual([
      { source: '/api/v1/:path*', destination: 'http://localhost:4000/api/v1/:path*' },
    ]);
  });
  it('uses the server-only origin override without a duplicate slash', async () => {
    vi.stubEnv('API_INTERNAL_URL', 'http://api:4000/');
    expect(await config.rewrites?.()).toEqual([
      { source: '/api/v1/:path*', destination: 'http://api:4000/api/v1/:path*' },
    ]);
  });
});
