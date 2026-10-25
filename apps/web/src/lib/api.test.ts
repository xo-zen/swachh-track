import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

afterEach(() => { api.clear(); api.onExpired = undefined; vi.unstubAllGlobals(); });
const auth = { accessToken: 'test-access', refreshToken: 'test-refresh', user: { id: 'test-user' }, memberships: [] };

describe('authenticated API client', () => {
  it('sends bearer and selected membership without cookies', async () => {
    const mocked = vi.fn().mockResolvedValue(Response.json({ data: [], nextCursor: null })); vi.stubGlobal('fetch', mocked);
    api.authenticate(auth); api.selectMembership('membership-a');
    expect(await api.list('/properties')).toEqual({ items: [], nextCursor: null });
    const init = mocked.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-access');
    expect(new Headers(init.headers).get('X-Membership-Id')).toBe('membership-a'); expect(init.credentials).toBe('omit');
  });
  it('refreshes and retries a 401 with rotated tokens', async () => {
    const mocked = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: 'expired' } }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh' }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal('fetch', mocked); api.authenticate(auth);
    expect(await api.json('/me')).toEqual({ ok: true }); expect(mocked).toHaveBeenCalledTimes(3);
    expect(new Headers((mocked.mock.calls[2][1] as RequestInit).headers).get('Authorization')).toBe('Bearer rotated-access');
  });
  it('fails visibly on unavailable routes and never returns mock data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'NOT_FOUND', message: 'Unavailable', requestId: 'request-1' } }, { status: 404 })));
    await expect(api.list('/missing')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND', requestId: 'request-1' });
  });
  it('rejects a malformed list envelope', async () => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true }))); await expect(api.list('/properties')).rejects.toBeInstanceOf(ApiError); });
});
