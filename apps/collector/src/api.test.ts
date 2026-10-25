import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession } from './model';
import { resolveIdentity } from './model';

const secure = vi.hoisted(() => ({ values: new Map<string, string>(), uuid: vi.fn(() => '0f7baf99-b496-4ce1-b1cb-97204692efed') }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => secure.values.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { secure.values.set(key, value); },
  deleteItemAsync: async (key: string) => { secure.values.delete(key); },
}));
vi.mock('expo-crypto', () => ({ randomUUID: secure.uuid }));

const sessionKey = 'swachh.collector.session.v1';
const deviceKey = 'swachh.collector.device.v1';
const boundId = 'b3a58d97-bfb4-4ce2-a7ec-293dcfc97237';
const membershipId = 'e9285e69-befc-436b-9bc9-c5afde5db42d';
const auth: AuthSession = {
  accessToken: 'access', refreshToken: 'refresh', user: { id: 'collector-user' },
  memberships: [{ id: membershipId, role: 'COLLECTOR' }, { id: 'other-membership', role: 'COLLECTOR' }],
  membershipId, registeredMemberships: [],
};
const network = vi.fn<typeof fetch>();
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.resetModules();
  secure.values.clear(); secure.uuid.mockClear(); network.mockReset();
  secure.values.set(sessionKey, JSON.stringify(auth));
  secure.values.set(deviceKey, boundId);
  vi.stubGlobal('fetch', network);
});
afterEach(() => vi.unstubAllGlobals());

describe('device binding and scoped API contract (mocked HTTP/SecureStore)', () => {
  it('registers the persisted UUID, not the server row ID, with the selected membership', async () => {
    const client = await import('./api');
    await client.restoreAuth();
    network.mockResolvedValue(response({ id: 'database-row-id', deviceId: boundId, collectorId: 'collector-row-id', platform: 'android', appVersion: '0.1.0', revokedAt: null }));
    const registered = await new client.CollectorApi(auth).register();
    const [url, init] = network.mock.calls[0];
    expect(url).toBe(`${client.API_URL}/collector/devices`);
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer access', 'X-Membership-Id': membershipId });
    expect(JSON.parse(String(init?.body))).toEqual({ deviceId: boundId, platform: 'android', appVersion: '0.1.0' });
    expect(registered.registeredMemberships).toEqual([membershipId]);
    expect(await client.deviceId()).toBe(boundId);
    expect(secure.uuid).not.toHaveBeenCalled();
    vi.resetModules();
    const restored = await import('./api');
    expect((await restored.restoreAuth())?.registeredMemberships).toEqual([membershipId]);
    expect(await restored.deviceId()).toBe(boundId);
  });
  it.each([
    [403, 'DEVICE_BOUND_OR_REVOKED'],
    [409, 'DEVICE_LIMIT'],
  ])('does not mark registration successful or replace the UUID for HTTP %s %s', async (status, code) => {
    const client = await import('./api');
    await client.restoreAuth();
    network.mockResolvedValue(response({ error: { code, message: 'Registration refused' } }, Number(status)));
    await expect(new client.CollectorApi(auth).register()).rejects.toThrow(String(code));
    expect((await client.restoreAuth())?.registeredMemberships).toEqual([]);
    expect(secure.values.get(deviceKey)).toBe(boundId);
    expect(secure.uuid).not.toHaveBeenCalled();
  });
  it.each([
    { deviceId: 'wrong-device', revokedAt: null },
    { deviceId: boundId, revokedAt: '2026-04-01T04:00:00Z' },
  ])('refuses an inconsistent successful binding response', async (body) => {
    const client = await import('./api');
    await client.restoreAuth();
    network.mockResolvedValue(response(body));
    await expect(new client.CollectorApi(auth).register()).rejects.toThrow('invalidResponse');
    expect((await client.restoreAuth())?.registeredMemberships).toEqual([]);
  });
  it('keeps the device UUID after logout and prevents the previous scoped client sending under another membership', async () => {
    const client = await import('./api');
    await client.restoreAuth();
    const original = new client.CollectorApi(auth);
    await client.chooseMembership('other-membership');
    await expect(original.request('/collector/today')).rejects.toThrow('loginRequired');
    expect(network).not.toHaveBeenCalled();
    network.mockResolvedValue(response({ status: 'LOGGED_OUT' }));
    await client.logout();
    expect(secure.values.has(sessionKey)).toBe(false);
    expect(await client.deviceId()).toBe(boundId);
  });
  it('generates a device UUID once when none exists and persists it before use', async () => {
    secure.values.delete(deviceKey);
    const client = await import('./api');
    const [first, second] = await Promise.all([client.deviceId(), client.deviceId()]);
    expect(first).toBe(second);
    expect(secure.values.get(deviceKey)).toBe(first);
    expect(secure.uuid).toHaveBeenCalledTimes(1);
  });
});

describe('current route API and cached JSON contract', () => {
  const now = Date.parse('2026-04-01T04:00:00Z');
  const stop = {
    id: 'stop-1', propertyId: 'property-1', sequence: 1,
    property: { id: 'property-1', unitNo: '101', block: null, latitude: 18.52, longitude: 73.85, propertyCode: '001234', qrToken: 'v1.signed-property-token' },
    windowStart: '2026-04-01T03:30:00.000Z', windowEnd: '2026-04-01T06:30:00.000Z', streams: ['WET', 'DRY'], status: 'PENDING',
    lastPickup: { id: 'previous-pickup', capturedAt: '2026-03-31T04:00:00.000Z', status: 'VERIFIED', streams: [{ stream: 'WET', kg: '4.200' }] },
  };
  it('preserves ISO windows, coordinates, leading-zero codes and last-pickup data through cached JSON', async () => {
    const { parseRoutes } = await import('./api');
    const routes = parseRoutes({ routes: [{ id: 'route', name: 'Morning', date: '2026-04-01', stops: [stop] }] });
    const cached = parseRoutes(JSON.parse(JSON.stringify({ routes })) as unknown);
    expect(cached).toEqual(routes);
    expect(cached[0].stops[0]).toEqual(stop);
    expect(resolveIdentity(cached[0], stop.id, '001234', 'CODE', now)).toBe(stop.property.qrToken);
  });
  it('keeps a route with a null/rotated QR, blocks both identity paths for it, and preserves usable stops', async () => {
    const { parseRoutes } = await import('./api');
    const rotated = { ...stop, id: 'stop-2', propertyId: 'property-2', sequence: 2, property: { ...stop.property, id: 'property-2', propertyCode: '001235', qrToken: null }, lastPickup: null };
    const [route] = parseRoutes({ routes: [{ id: 'route', name: 'Morning', date: '2026-04-01', stops: [rotated, stop] }] });
    expect(route.stops.map((item) => item.id)).toEqual(['stop-1', 'stop-2']);
    expect(route.stops[1].property.qrToken).toBeNull();
    expect(resolveIdentity(route, 'stop-2', '001235', 'CODE', now)).toBeNull();
    expect(resolveIdentity(route, 'stop-2', 'old-token', 'QR', now)).toBeNull();
    expect(resolveIdentity(route, 'stop-1', stop.property.qrToken, 'QR', now)).toBe(stop.property.qrToken);
  });
  it('still rejects a mismatched property or unsupported stream rather than caching fabricated evidence', async () => {
    const { parseRoutes } = await import('./api');
    expect(() => parseRoutes({ routes: [{ id: 'route', name: 'Morning', date: '2026-04-01', stops: [{ ...stop, propertyId: 'different-property' }] }] })).toThrow('invalidResponse');
    expect(() => parseRoutes({ routes: [{ id: 'route', name: 'Morning', date: '2026-04-01', stops: [{ ...stop, streams: ['UNKNOWN'] }] }] })).toThrow('invalidResponse');
  });
});
