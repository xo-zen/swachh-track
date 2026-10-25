import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type DemoRole } from './api';

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

const roles = [
  { alias: 'resident', role: 'RESIDENT' }, { alias: 'society', role: 'SOCIETY_ADMIN' },
  { alias: 'collector', role: 'COLLECTOR' }, { alias: 'supervisor', role: 'SUPERVISOR' }, { alias: 'ulb', role: 'ULB_ADMIN' },
] as const;
function demoIdentity(alias: DemoRole) {
  const membership = { id: `membership-${alias}`, role: roles.find(item => item.alias === alias)!.role, status: 'ACTIVE' };
  return { user: { id: `user-${alias}` }, memberships: [membership], activeMembership: membership };
}
describe('open demo API client', () => {
  it.each(['open-demo', 'authenticated'])('discovers %s without credentials', async mode => {
    const access = { mode, roles: mode === 'open-demo' ? roles : [] };
    const mocked = vi.fn().mockResolvedValue(Response.json(access)); vi.stubGlobal('fetch', mocked);
    expect(await api.discoverAccess()).toEqual(access);
    expect(mocked.mock.calls[0][0]).toBe('/api/v1/access');
    expect(new Headers(mocked.mock.calls[0][1].headers).has('Authorization')).toBe(false);
  });
  it.each([
    {}, { mode: 'unknown', roles: [] }, { mode: 'open-demo', roles: [] },
    { mode: 'authenticated', roles }, { mode: 'open-demo', roles: [...roles, roles[0]] },
    { mode: 'open-demo', roles: [{ alias: 'ulb', role: 'SUPER_ADMIN' }] },
  ])('rejects malformed discovery instead of falling back to login: %j', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
    await expect(api.discoverAccess()).rejects.toMatchObject({ status: 502 });
  });
  it.each(roles)('opens $alias with no credentials or auth requests', async ({ alias }) => {
    const mocked = vi.fn().mockImplementation(async () => Response.json(demoIdentity(alias))); vi.stubGlobal('fetch', mocked);
    api.authenticate(auth); api.selectMembership('old-membership');
    expect(await api.openDemo(alias)).toEqual(demoIdentity(alias));
    await api.json('/notifications');
    const initial = new Headers(mocked.mock.calls[0][1].headers);
    expect(initial.get('X-Demo-Role')).toBe(alias);
    expect(initial.has('Authorization')).toBe(false);
    expect(initial.has('X-Membership-Id')).toBe(false);
    expect(new Headers(mocked.mock.calls[1][1].headers).get('X-Membership-Id')).toBe(`membership-${alias}`);
    expect(mocked.mock.calls.map(call => call[0])).toEqual(['/api/v1/me', '/api/v1/notifications']);
  });
  it('does not refresh demo requests on 401', async () => {
    const mocked = vi.fn().mockResolvedValueOnce(Response.json(demoIdentity('resident')))
      .mockResolvedValueOnce(Response.json({ error: { message: 'Demo unavailable' } }, { status: 401 }));
    vi.stubGlobal('fetch', mocked); await api.openDemo('resident');
    await expect(api.json('/notifications')).rejects.toMatchObject({ status: 401 });
    expect(mocked).toHaveBeenCalledTimes(2);
  });
  it('rejects a mismatched role or missing active membership', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(demoIdentity('ulb')))
      .mockResolvedValueOnce(Response.json({ user: { id: 'resident' }, memberships: [] })));
    await expect(api.openDemo('resident')).rejects.toMatchObject({ status: 502 });
    await expect(api.openDemo('resident')).rejects.toMatchObject({ status: 502 });
  });
  it('rejects an old response after switching demo roles', async () => {
    let resolve!: (response: Response) => void;
    const mocked = vi.fn().mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }))
      .mockResolvedValueOnce(Response.json(demoIdentity('society')))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal('fetch', mocked);
    const previous = api.openDemo('resident');
    const rejected = expect(previous).rejects.toThrow('changed');
    await api.openDemo('society'); resolve(Response.json(demoIdentity('resident'))); await rejected;
    await api.json('/notifications');
    expect(new Headers(mocked.mock.calls[2][1].headers).get('X-Demo-Role')).toBe('society');
    expect(new Headers(mocked.mock.calls[2][1].headers).get('X-Membership-Id')).toBe('membership-society');
  });
  it('does not submit a credential logout for a demo identity', async () => {
    const mocked = vi.fn().mockResolvedValue(Response.json(demoIdentity('resident'))); vi.stubGlobal('fetch', mocked);
    await api.openDemo('resident'); await api.logout();
    expect(mocked).toHaveBeenCalledTimes(1);
  });
});
