import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, createApiClient } from './index';

describe('minimal authenticated API client', () => {
  it('attaches auth/idempotency, JSON-encodes camelCase and validates response schemas', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'e1' }), { status: 201 }));
    const client = createApiClient({ baseUrl: 'https://example.test/api/v1/', getAccessToken: async () => 'fixture-token', fetch: fetcher });
    const result = await client.request('/collector/pickups/batch', { method: 'POST', body: { events: [] }, idempotencyKey: 'fixture-key', schema: z.object({ id: z.string() }).strict() });
    expect(result.id).toBe('e1');
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://example.test/api/v1/collector/pickups/batch');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer fixture-token');
    expect(headers.get('idempotency-key')).toBe('fixture-key');
    expect(init?.body).toBe('{"events":[]}');
    expect(init?.redirect).toBe('error');
  });
  it('retains server error code, details and request ID', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'INVALID_QR', message: 'Invalid QR', details: { propertyId: 'p1' }, requestId: 'req-1' } }), { status: 422 }));
    const client = createApiClient({ baseUrl: 'https://example.test', fetch: fetcher });
    await expect(client.request('/pickups')).rejects.toMatchObject({ name: 'ApiError', status: 422, code: 'INVALID_QR', message: 'Invalid QR', details: { propertyId: 'p1' }, requestId: 'req-1' });
  });
  it('normalizes non-JSON HTTP errors and rejects non-JSON success', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502, headers: { 'x-request-id': 'req-2' } }))
      .mockResolvedValueOnce(new Response('<html>Not JSON</html>', { status: 200 }));
    const client = createApiClient({ baseUrl: 'https://example.test', fetch: fetcher });
    await expect(client.request('/first')).rejects.toMatchObject({ status: 502, code: 'HTTP_ERROR', requestId: 'req-2' });
    await expect(client.request('/second')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('supports 204, propagates network errors and refuses cross-origin credential paths', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 })).mockRejectedValueOnce(new TypeError('Network unavailable'));
    const client = createApiClient({ baseUrl: 'https://example.test', fetch: fetcher });
    expect(await client.request('/logout', { method: 'POST' })).toBeUndefined();
    await expect(client.request('/offline')).rejects.toThrow('Network unavailable');
    for (const path of ['https://other.test', '//other.test', '/\\other.test', '/x\n']) await expect(client.request(path)).rejects.toThrow('origin-relative');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new ApiError(400, { error: { code: 'BAD', message: 'Invalid' } })).toBeInstanceOf(Error);
  });
});
