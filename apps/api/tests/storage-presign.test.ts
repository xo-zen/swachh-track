import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Storage } from '../src/storage.js';

describe.each([
  { name: 'internal endpoint', publicEndpoint: undefined, origin: 'http://storage-internal.invalid:9000', pathname: '/evidence/photo.upload' },
  { name: 'public signing endpoint', publicEndpoint: 'https://storage-public.invalid/storage/v1/s3', origin: 'https://storage-public.invalid', pathname: '/storage/v1/s3/evidence/photo.upload' },
])('S3 presigning via $name', ({ publicEndpoint, origin, pathname }) => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['GET', 'PUT'] as const)('keeps %s signed and expiring without a spurious upload checksum', async action => {
    vi.stubEnv('AWS_REQUEST_CHECKSUM_CALCULATION', 'WHEN_SUPPORTED');
    const storage = new Storage(loadConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'false',
      HOSTED_DEMO: 'false',
      DATABASE_URL: 'postgresql://localhost/test',
      JWT_SECRET: 'test-only-secret-with-more-than-32-bytes',
      QR_SECRET: 'test-only-qr-secret-with-more-than-32-bytes',
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: 'http://storage-internal.invalid:9000',
      S3_PUBLIC_ENDPOINT: publicEndpoint,
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'evidence',
      S3_ACCESS_KEY: 'dummy-access-key',
      S3_SECRET_KEY: 'dummy-secret-key',
    }));

    const url = new URL(await storage.url('photo.upload', action));
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe(pathname);
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^dummy-access-key\/\d{8}\/us-east-1\/s3\/aws4_request$/);
    expect(url.searchParams.get('X-Amz-Date')).toMatch(/^\d{8}T\d{6}Z$/);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Content-Sha256')).toBe('UNSIGNED-PAYLOAD');
    if (action === 'PUT') {
      expect([...url.searchParams.keys()].filter(key => /^x-amz-(checksum-|sdk-checksum-algorithm$)/i.test(key))).toEqual([]);
    }
  });
});
