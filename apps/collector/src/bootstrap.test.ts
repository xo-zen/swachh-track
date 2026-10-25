import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialQueueState, type AuthenticatedSession, type DemoSession } from './model';
import { SCHEMA } from './schema';

const secure = vi.hoisted(() => ({ values: new Map<string, string>(), uuid: vi.fn(() => 'new-device') }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => secure.values.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { secure.values.set(key, value); },
  deleteItemAsync: async (key: string) => { secure.values.delete(key); },
}));
vi.mock('expo-crypto', () => ({ randomUUID: secure.uuid }));

const sessionKey = 'swachh.collector.session.v1';
const accessKey = 'swachh.collector.access.v1';
const deviceKey = 'swachh.collector.device.v1';
const device = 'b3a58d97-bfb4-4ce2-a7ec-293dcfc97237';
const membership = { id: 'e9285e69-befc-436b-9bc9-c5afde5db42d', role: 'COLLECTOR' };
const me = { user: { id: 'seeded-collector', name: 'Demo Collector' }, memberships: [membership], activeMembership: membership };
const access = { mode: 'open-demo', roles: [{ alias: 'resident', role: 'RESIDENT' }, { alias: 'collector', role: 'COLLECTOR' }] };
const authenticated: AuthenticatedSession = { mode: 'authenticated', accessToken: 'real-access', refreshToken: 'real-refresh', user: me.user, memberships: me.memberships, membershipId: membership.id, registeredMemberships: [membership.id] };
const network = vi.fn<typeof fetch>();
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function cachedDemo(overrides: Record<string, unknown> = {}): Promise<DemoSession> {
  const { API_URL } = await import('./api');
  const saved: DemoSession = { mode: 'open-demo', demoRole: 'collector', apiUrl: API_URL, deviceId: device, user: me.user, memberships: me.memberships, membershipId: membership.id, registeredMemberships: [membership.id] };
  secure.values.set(sessionKey, JSON.stringify({ ...saved, ...overrides }));
  secure.values.set(accessKey, JSON.stringify({ mode: 'open-demo', apiUrl: API_URL }));
  return saved;
}

beforeEach(() => {
  vi.resetModules();
  secure.values.clear(); secure.uuid.mockClear(); network.mockReset();
  secure.values.set(deviceKey, device);
  vi.stubGlobal('fetch', network);
});
afterEach(() => vi.unstubAllGlobals());

describe('API-discovered collector bootstrap', () => {
  it('discovers open demo, loads only collector /me and persists a tokenless, automatically selected session', async () => {
    secure.values.set(sessionKey, JSON.stringify(authenticated));
    const client = await import('./api');
    network.mockResolvedValueOnce(response(access)).mockResolvedValueOnce(response(me));
    const boot = await client.bootstrapCollector();
    expect(boot).toMatchObject({ mode: 'open-demo', cached: false, session: { mode: 'open-demo', demoRole: 'collector', membershipId: membership.id, deviceId: device, registeredMemberships: [] } });
    expect(network.mock.calls.map(([url]) => url)).toEqual([`${client.API_URL}/access`, `${client.API_URL}/me`]);
    for (const [, init] of network.mock.calls) {
      expect(init?.headers).toEqual({ 'X-Demo-Role': 'collector' });
      expect(init?.credentials).toBe('omit');
    }
    expect(JSON.parse(secure.values.get(sessionKey)!)).toEqual(boot.session);
    expect(boot.session).not.toHaveProperty('accessToken');
    expect(boot.session).not.toHaveProperty('refreshToken');
    expect(secure.uuid).not.toHaveBeenCalled();
  });

  it.each([{ mode: 'authenticated', roles: [] }, access])('validates discovery mode $mode', async (body) => {
    const client = await import('./api');
    network.mockResolvedValue(response(body));
    expect(await client.discoverAccess()).toEqual(body);
  });

  it.each([{}, { mode: 'open-demo' }, { mode: 'unknown', roles: [] }, { mode: 'authenticated', roles: access.roles }, { mode: 'open-demo', roles: [{ alias: 'admin', role: 'COLLECTOR' }] }])('rejects malformed discovery rather than guessing authentication: %j', async (body) => {
    await cachedDemo();
    const client = await import('./api');
    network.mockResolvedValue(response(body));
    await expect(client.bootstrapCollector()).rejects.toThrow('invalidResponse');
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('does not bootstrap a role the server has not advertised', async () => {
    const client = await import('./api');
    network.mockResolvedValue(response({ mode: 'open-demo', roles: [{ alias: 'resident', role: 'RESIDENT' }] }));
    await expect(client.bootstrapCollector()).rejects.toThrow('noMembership');
    expect(network).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...me, activeMembership: { id: 'foreign', role: 'COLLECTOR' } },
    { ...me, memberships: [{ ...membership, userId: 'foreign-user' }] },
    { ...me, memberships: [{ ...membership, status: 'DISABLED' }] },
    { ...me, memberships: [{ ...membership, role: 'RESIDENT' }] },
  ])('fails closed for invalid collector /me membership data', async (body) => {
    const client = await import('./api');
    network.mockResolvedValueOnce(response(access)).mockResolvedValueOnce(response(body));
    await expect(client.bootstrapCollector()).rejects.toThrow();
    expect(secure.values.has(sessionKey)).toBe(false);
  });

  it('retries a failed first bootstrap without reviving the old authenticated identity after restart', async () => {
    secure.values.set(sessionKey, JSON.stringify(authenticated));
    let client = await import('./api');
    network.mockResolvedValueOnce(response(access)).mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(client.bootstrapCollector()).rejects.toThrow('offline');
    expect(secure.values.has(sessionKey)).toBe(false);
    expect(JSON.parse(secure.values.get(accessKey)!)).toMatchObject({ mode: 'open-demo' });
    vi.resetModules(); client = await import('./api');
    network.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(client.bootstrapCollector()).rejects.toThrow('offline');
    await expect(client.requestOtp('+919000000003')).rejects.toThrow('startupRequired');
    network.mockResolvedValueOnce(response(access)).mockResolvedValueOnce(response(me));
    expect((await client.bootstrapCollector()).session?.mode).toBe('open-demo');
    expect(network.mock.calls.every(([url]) => !String(url).includes('/auth/'))).toBe(true);
  });

  it('does not interpret an unavailable discovery endpoint as a request to show Login', async () => {
    const client = await import('./api');
    network.mockRejectedValue(new TypeError('offline'));
    await expect(client.bootstrapCollector()).rejects.toThrow('offline');
    await expect(client.verifyOtp('+919000000003', '123456')).rejects.toThrow('startupRequired');
    expect(network).toHaveBeenCalledTimes(1);
  });
});

describe('tokenless transport and device registration', () => {
  async function apiFactory() {
    const saved = await cachedDemo({ registeredMemberships: [] });
    const client = await import('./api');
    await client.restoreAuth();
    return { client, api: new client.CollectorApi(saved) };
  }

  it.each(['/collector/today', '/collector/pickups/event/photos/presign', '/collector/pickups/event/photos/photo/confirm', '/collector/pickups/batch', '/collector/sync/status'])('uses collector headers and never tokens for %s', async (path) => {
    const { api } = await apiFactory();
    network.mockResolvedValue(response({}));
    await api.request(path, {}, { Authorization: 'Bearer stale', authorization: 'Bearer stale', 'x-demo-role': 'ulb', 'x-membership-id': 'foreign', Cookie: 'token=old', 'Idempotency-Key': 'event' });
    expect(network.mock.calls[0][1]?.headers).toEqual({ 'Content-Type': 'application/json', 'X-Demo-Role': 'collector', 'X-Membership-Id': membership.id, 'Idempotency-Key': 'event' });
    expect(network.mock.calls[0][1]?.credentials).toBe('omit');
  });

  it('does not refresh, retry with a token, clear the session or call auth endpoints on demo 401', async () => {
    const { client, api } = await apiFactory();
    const stored = secure.values.get(sessionKey);
    network.mockResolvedValue(response({ error: { code: 'UNAUTHORIZED', message: 'Access changed' } }, 401));
    await expect(api.request('/collector/today')).rejects.toMatchObject({ status: 401 });
    expect(network).toHaveBeenCalledTimes(1);
    expect(secure.values.get(sessionKey)).toBe(stored);
    await expect(client.requestOtp('+919000000003')).rejects.toThrow('startupRequired');
    await expect(client.verifyOtp('+919000000003', '123456')).rejects.toThrow('startupRequired');
    await expect(client.logout()).rejects.toThrow('startupRequired');
    await expect(client.clearMembership()).rejects.toThrow('startupRequired');
    await expect(client.chooseMembership(membership.id)).rejects.toThrow('startupRequired');
    await expect(api.request('/auth/refresh', {})).rejects.toThrow('startupRequired');
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('registers the same bound device with the selected demo membership and restores it offline', async () => {
    const { client, api } = await apiFactory();
    network.mockResolvedValueOnce(response({ id: 'row-id', deviceId: device, revokedAt: null }));
    const registered = await api.register();
    expect(registered.registeredMemberships).toEqual([membership.id]);
    expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toEqual({ deviceId: device, platform: 'android', appVersion: '0.1.0' });
    expect(network.mock.calls[0][1]?.headers).toMatchObject({ 'X-Demo-Role': 'collector', 'X-Membership-Id': membership.id });
    expect(network.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
    expect(client.scopeOf(registered)).toBe(`${me.user.id}:${membership.id}`);
    vi.resetModules();
    const restarted = await import('./api');
    network.mockRejectedValue(new TypeError('offline'));
    expect(await restarted.bootstrapCollector()).toEqual({ mode: 'open-demo', session: registered, cached: true });
    expect(await restarted.deviceId()).toBe(device);
    expect(secure.uuid).not.toHaveBeenCalled();
  });

  it.each([
    [403, { error: { code: 'DEVICE_BOUND_OR_REVOKED' } }],
    [409, { error: { code: 'DEVICE_LIMIT' } }],
    [200, { deviceId: 'wrong-device', revokedAt: null }],
    [200, { deviceId: device, revokedAt: '2026-04-01T00:00:00Z' }],
  ])('does not bypass binding constraints for HTTP %s', async (status, body) => {
    const { api } = await apiFactory();
    network.mockResolvedValue(response(body, Number(status)));
    await expect(api.register()).rejects.toThrow();
    expect(JSON.parse(secure.values.get(sessionKey)!)).toMatchObject({ registeredMemberships: [] });
    expect(secure.values.get(deviceKey)).toBe(device);
    expect(secure.uuid).not.toHaveBeenCalled();
  });
});

describe('offline restoration and access-mode changes', () => {
  it.each([
    ['/access', 'network'], ['/me', 'network'], ['/access', '503'], ['/me', '503'],
  ])('restores a validated cached demo after %s %s and subsequent offline restart', async (path, failure) => {
    const saved = await cachedDemo();
    const client = await import('./api');
    if (path === '/me') network.mockResolvedValueOnce(response(access));
    if (failure === '503') network.mockResolvedValueOnce(response({}, 503));
    else network.mockRejectedValueOnce(new TypeError('offline'));
    expect(await client.bootstrapCollector()).toEqual({ mode: 'open-demo', session: saved, cached: true });
    expect(client.scopeOf(saved)).toBe(`${me.user.id}:${membership.id}`);
    expect(JSON.parse(secure.values.get(sessionKey)!)).toEqual(saved);
    vi.resetModules();
    const restarted = await import('./api');
    network.mockRejectedValueOnce(new TypeError('offline'));
    expect(await restarted.bootstrapCollector()).toEqual({ mode: 'open-demo', session: saved, cached: true });
  });

  it.each([
    { mode: undefined }, { demoRole: 'resident' }, { apiUrl: 'https://other.invalid/api/v1' },
    { deviceId: 'different-device' }, { membershipId: 'foreign' }, { membershipId: null },
    { accessToken: 'fabricated', refreshToken: 'fabricated' }, { registeredMemberships: 'invalid' },
    { memberships: [{ ...membership, role: 'RESIDENT' }] },
  ])('does not restore an invalid cached demo offline: %j', async (overrides) => {
    await cachedDemo(overrides);
    const client = await import('./api');
    network.mockRejectedValue(new TypeError('offline'));
    await expect(client.bootstrapCollector()).rejects.toThrow('offline');
  });

  it.each([
    { path: '/me', status: 401, mode: 'open-demo' },
    { path: '/me', status: 403, mode: 'open-demo' },
    { path: '/access', status: 401, mode: 'open-demo' },
    { path: '/access', status: 403, mode: 'open-demo' },
    { path: '/access', status: 401, mode: 'authenticated' },
    { path: '/access', status: 403, mode: 'authenticated' },
  ])('invalidates $mode offline eligibility after $path HTTP $status, including retry and reload', async ({ path, status, mode }) => {
    const saved = await cachedDemo();
    const client = await import('./api');
    if (mode === 'authenticated') {
      secure.values.set(sessionKey, JSON.stringify(authenticated));
      secure.values.set(accessKey, JSON.stringify({ mode, apiUrl: client.API_URL }));
    }
    await client.restoreAuth();
    const oldApi = new client.CollectorApi(mode === 'authenticated' ? authenticated : saved);
    const marker = secure.values.get(accessKey);
    if (path === '/me') network.mockResolvedValueOnce(response(access));
    const denial = { error: { code: status === 403 ? 'HOSTED_DEMO_IDENTITY_FORBIDDEN' : 'UNAUTHORIZED', message: 'Identity access denied' } };
    network.mockResolvedValueOnce(response(denial, status));
    await expect(client.bootstrapCollector()).rejects.toMatchObject({ status, body: denial });
    expect(secure.values.has(sessionKey)).toBe(false);
    expect(secure.values.get(accessKey)).toBe(marker);
    expect(await client.restoreAuth()).toBeNull();
    await expect(oldApi.request('/collector/today')).rejects.toThrow(mode === 'authenticated' ? 'loginRequired' : 'startupRequired');

    network.mockRejectedValue(new TypeError('offline'));
    await expect(client.bootstrapCollector()).rejects.toThrow('offline');
    vi.resetModules();
    const restarted = await import('./api');
    await expect(restarted.bootstrapCollector()).rejects.toThrow('offline');
    expect(await restarted.restoreAuth()).toBeNull();
    expect(await restarted.deviceId()).toBe(device);
    expect(secure.uuid).not.toHaveBeenCalled();
    expect(network.mock.calls.every(([url]) => !String(url).includes('/auth/'))).toBe(true);
    expect(network).toHaveBeenCalledTimes(path === '/me' ? 4 : 3);
  });

  it('fails startup for /me 404 without treating a missing endpoint as an identity denial', async () => {
    const saved = await cachedDemo();
    const client = await import('./api');
    network.mockResolvedValueOnce(response(access)).mockResolvedValueOnce(response({}, 404));
    await expect(client.bootstrapCollector()).rejects.toMatchObject({ status: 404 });
    expect(network).toHaveBeenCalledTimes(2);
    expect(JSON.parse(secure.values.get(sessionKey)!)).toEqual(saved);
  });

  it('preserves the last valid collector membership and registration only for the same demo user/device', async () => {
    const second = { id: 'second-collector-membership', role: 'COLLECTOR' };
    await cachedDemo({ membershipId: second.id, memberships: [membership, second], registeredMemberships: [second.id] });
    const client = await import('./api');
    network.mockResolvedValueOnce(response(access)).mockResolvedValueOnce(response({ ...me, memberships: [membership, second] }));
    expect((await client.bootstrapCollector()).session).toMatchObject({ membershipId: second.id, registeredMemberships: [second.id] });
    network.mockResolvedValueOnce(response(access)).mockResolvedValueOnce(response(me));
    expect((await client.bootstrapCollector()).session).toMatchObject({ membershipId: membership.id, registeredMemberships: [] });
    await cachedDemo();
    network.mockResolvedValueOnce(response(access)).mockResolvedValueOnce(response({ ...me, user: { id: 'reseeded-collector' } }));
    expect((await client.bootstrapCollector()).session).toMatchObject({ user: { id: 'reseeded-collector' }, registeredMemberships: [] });
  });

  it('switches demo to authenticated without treating the demo session as login, including the next offline restart', async () => {
    const demo = await cachedDemo();
    const client = await import('./api');
    await client.restoreAuth();
    const oldApi = new client.CollectorApi(demo);
    network.mockResolvedValueOnce(response({ mode: 'authenticated', roles: [] }));
    expect(await client.bootstrapCollector()).toEqual({ mode: 'authenticated', session: null, cached: false });
    expect(secure.values.has(sessionKey)).toBe(false);
    await expect(oldApi.request('/collector/today')).rejects.toThrow('startupRequired');
    expect(network).toHaveBeenCalledTimes(1);
    vi.resetModules();
    const restarted = await import('./api');
    network.mockRejectedValueOnce(new TypeError('offline'));
    await expect(restarted.bootstrapCollector()).rejects.toThrow('offline');
  });

  it('honours the persisted mode even if a crash left the incompatible old session on disk', async () => {
    const client = await import('./api');
    secure.values.set(sessionKey, JSON.stringify(authenticated));
    secure.values.set(accessKey, JSON.stringify({ mode: 'open-demo', apiUrl: client.API_URL }));
    network.mockRejectedValue(new TypeError('offline'));
    await expect(client.bootstrapCollector()).rejects.toThrow('offline');
    await cachedDemo();
    secure.values.set(accessKey, JSON.stringify({ mode: 'authenticated', apiUrl: client.API_URL }));
    await expect(client.bootstrapCollector()).rejects.toThrow('offline');
  });

  it('invalidates old transport clients on a mode change even when user and membership IDs match', async () => {
    const client = await import('./api');
    secure.values.set(sessionKey, JSON.stringify(authenticated));
    await client.restoreAuth();
    const oldApi = new client.CollectorApi(authenticated);
    network.mockResolvedValueOnce(response(access)).mockResolvedValueOnce(response(me));
    const boot = await client.bootstrapCollector();
    expect(client.scopeOf(boot.session!)).toBe(oldApi.scope);
    await expect(oldApi.request('/collector/today')).rejects.toThrow('loginRequired');
    expect(network).toHaveBeenCalledTimes(2);
    expect(boot.session?.registeredMemberships).toEqual([]);
  });

  it('retains real SQLite evidence and scope across offline boot, identity denial and online recovery', async () => {
    const saved = await cachedDemo();
    const client = await import('./api');
    const scope = client.scopeOf(saved);
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(SCHEMA);
      db.prepare('INSERT INTO drafts VALUES (?,?,?,?)').run('draft', scope, 'draft-stop', '{"offline":true}');
      db.prepare('INSERT INTO routes VALUES (?,?,?)').run(scope, '[]', '2026-04-01T00:00:00Z');
      db.prepare('INSERT INTO events(uuid,scope,stop_id,capture_json,state_json,created_at) VALUES (?,?,?,?,?,?)').run('event', scope, 'stop', '{"offline":true}', JSON.stringify(initialQueueState), '2026-04-01T00:00:00Z');
      db.prepare('INSERT INTO photos(local_id,event_uuid,uri,kind,stage,photo_id) VALUES (?,?,?,?,?,?)').run('photo', 'event', 'file:///evidence.jpg', 'DOORSTEP', 'UPLOADED', 'server-photo');
      vi.resetModules();
      const restarted = await import('./api');
      network.mockRejectedValue(new TypeError('offline'));
      const boot = await restarted.bootstrapCollector();
      const restoredScope = restarted.scopeOf(boot.session!);
      expect(restoredScope).toBe(scope);
      network.mockResolvedValueOnce(response(access)).mockResolvedValueOnce(response({ error: { code: 'HOSTED_DEMO_IDENTITY_FORBIDDEN' } }, 403));
      await expect(restarted.bootstrapCollector()).rejects.toMatchObject({ status: 403 });
      await expect(restarted.bootstrapCollector()).rejects.toThrow('offline');
      expect(secure.values.has(sessionKey)).toBe(false);
      network.mockResolvedValueOnce(response(access)).mockResolvedValueOnce(response(me));
      const recovered = await restarted.bootstrapCollector();
      expect(recovered).toMatchObject({ mode: 'open-demo', cached: false, session: { registeredMemberships: [], deviceId: device } });
      expect(restarted.scopeOf(recovered.session!)).toBe(scope);
      expect(secure.values.get(deviceKey)).toBe(device);
      for (const table of ['drafts', 'routes', 'events']) {
        expect(db.prepare(`SELECT * FROM ${table} WHERE scope=?`).all(restoredScope)).toHaveLength(1);
        expect(db.prepare(`SELECT * FROM ${table} WHERE scope=?`).all('other:membership')).toHaveLength(0);
      }
      expect(db.prepare('SELECT stage,photo_id,uri FROM photos').get()).toMatchObject({ stage: 'UPLOADED', photo_id: 'server-photo', uri: 'file:///evidence.jpg' });
    } finally { db.close(); }
  });
});

describe('shipped authenticated-session compatibility', () => {
  it.each([true, false])('restores %s legacy untagged session with original tokens, scope and registration', async (legacy) => {
    secure.values.set(sessionKey, JSON.stringify({ ...authenticated, ...(legacy ? { mode: undefined } : {}) }));
    const client = await import('./api');
    network.mockResolvedValueOnce(response({ mode: 'authenticated', roles: [] }));
    const boot = await client.bootstrapCollector();
    expect(boot).toEqual({ mode: 'authenticated', session: authenticated, cached: false });
    network.mockResolvedValueOnce(response({ routes: [] }));
    await new client.CollectorApi(boot.session!).request('/collector/today');
    expect(network.mock.calls[1][1]?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer real-access', 'X-Membership-Id': membership.id });
  });

  it('preserves OTP login, explicit membership selection and real-token refresh in authenticated mode', async () => {
    const client = await import('./api');
    network.mockResolvedValueOnce(response({ mode: 'authenticated', roles: [] }));
    expect((await client.bootstrapCollector()).session).toBeNull();
    network.mockResolvedValueOnce(response({ status: 'OTP_SENT' }));
    await client.requestOtp('+919000000003');
    network.mockResolvedValueOnce(response({ ...me, accessToken: 'real-access', refreshToken: 'real-refresh' }));
    expect(await client.verifyOtp('+919000000003', '123456')).toMatchObject({ mode: 'authenticated', membershipId: null, registeredMemberships: [] });
    const selected = await client.chooseMembership(membership.id);
    network.mockResolvedValueOnce(response({}, 401)).mockResolvedValueOnce(response({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh' })).mockResolvedValueOnce(response({ routes: [] }));
    await new client.CollectorApi(selected).request('/collector/today');
    expect(network.mock.calls.map(([url]) => String(url).replace(client.API_URL, ''))).toEqual(['/access', '/auth/otp/request', '/auth/otp/verify', '/collector/today', '/auth/refresh', '/collector/today']);
    expect(network.mock.calls[5][1]?.headers).toMatchObject({ Authorization: 'Bearer rotated-access' });
    expect(JSON.parse(secure.values.get(sessionKey)!)).toMatchObject({ mode: 'authenticated', refreshToken: 'rotated-refresh' });
  });
});

describe('in-flight responses across session changes', () => {
  it('does not refresh a delayed authenticated 401 after switching to demo', async () => {
    secure.values.set(sessionKey, JSON.stringify(authenticated));
    const client = await import('./api');
    await client.restoreAuth();
    const oldResponse = deferred<Response>();
    network.mockReturnValueOnce(oldResponse.promise);
    const request = new client.CollectorApi(authenticated).request('/collector/today');
    const rejected = expect(request).rejects.toMatchObject({ status: 401 });
    network.mockResolvedValueOnce(response(access)).mockResolvedValueOnce(response(me));
    const demo = await client.bootstrapCollector();
    oldResponse.resolve(response({}, 401));
    await rejected;
    expect(network.mock.calls.map(([url]) => String(url).replace(client.API_URL, ''))).toEqual(['/collector/today', '/access', '/me']);
    expect(JSON.parse(secure.values.get(sessionKey)!)).toEqual(demo.session);
  });

  it('does not apply a delayed device registration to the new demo session with the same scope', async () => {
    secure.values.set(sessionKey, JSON.stringify(authenticated));
    const client = await import('./api');
    await client.restoreAuth();
    const started = deferred<void>();
    const oldResponse = deferred<Response>();
    network.mockImplementationOnce(() => { started.resolve(); return oldResponse.promise; });
    const registration = new client.CollectorApi(authenticated).register();
    const rejected = expect(registration).rejects.toThrow('loginRequired');
    await started.promise;
    network.mockResolvedValueOnce(response(access)).mockResolvedValueOnce(response(me));
    const demo = await client.bootstrapCollector();
    oldResponse.resolve(response({ deviceId: device, revokedAt: null }));
    await rejected;
    expect(demo.session?.registeredMemberships).toEqual([]);
    expect(JSON.parse(secure.values.get(sessionKey)!)).toEqual(demo.session);
  });

  it('does not share an old refresh with a new authenticated session or let its completion clear the new flight', async () => {
    secure.values.set(sessionKey, JSON.stringify(authenticated));
    const client = await import('./api');
    await client.restoreAuth();
    const oldStarted = deferred<void>();
    const oldResponse = deferred<Response>();
    network.mockResolvedValueOnce(response({}, 401)).mockImplementationOnce(() => { oldStarted.resolve(); return oldResponse.promise; });
    const oldRequest = new client.CollectorApi(authenticated).request('/collector/today');
    const oldRejected = expect(oldRequest).rejects.toThrow('loginRequired');
    await oldStarted.promise;

    network.mockResolvedValueOnce(response(access)).mockResolvedValueOnce(response(me));
    await client.bootstrapCollector();
    network.mockResolvedValueOnce(response({ mode: 'authenticated', roles: [] }));
    await client.bootstrapCollector();
    network.mockResolvedValueOnce(response({ ...me, accessToken: 'new-access', refreshToken: 'new-refresh' }));
    await client.verifyOtp('+919000000003', '123456');
    const selected = await client.chooseMembership(membership.id);
    const api = new client.CollectorApi(selected);
    const newResponse = deferred<Response>();
    network.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) return newResponse.promise;
      return response({}, 401);
    });
    const newRequest = api.request('/collector/today');
    let concurrent: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(network.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(2));
      oldResponse.resolve(response({ accessToken: 'old-rotated-access', refreshToken: 'old-rotated-refresh' }));
      await oldRejected;
      expect(JSON.parse(secure.values.get(sessionKey)!)).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' });
      concurrent = api.request('/collector/sync/status');
      // Flush the immediate mocked 401 while the new refresh is deliberately held pending.
      await new Promise((done) => setTimeout(done, 0));
      expect(network.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(2);
      network.mockImplementation(async () => response({ ok: true }));
      newResponse.resolve(response({ accessToken: 'new-rotated-access', refreshToken: 'new-rotated-refresh' }));
      await expect(Promise.all([newRequest, concurrent])).resolves.toEqual([{ ok: true }, { ok: true }]);
      expect(network.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(2);
      expect(JSON.parse(secure.values.get(sessionKey)!)).toMatchObject({ accessToken: 'new-rotated-access', refreshToken: 'new-rotated-refresh' });
    } finally {
      oldResponse.resolve(response({ accessToken: 'old-rotated-access', refreshToken: 'old-rotated-refresh' }));
      newResponse.resolve(response({ accessToken: 'new-rotated-access', refreshToken: 'new-rotated-refresh' }));
      await Promise.allSettled([oldRequest, oldRejected, newRequest, concurrent]);
    }
  });
});
