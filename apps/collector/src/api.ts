import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { record, STREAMS, text, type AuthSession, type Route, type RouteStop, type Stream } from './model';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1').replace(/\/$/, '');
const AUTH_KEY = 'swachh.collector.session.v1';
const DEVICE_KEY = 'swachh.collector.device.v1';
let current: AuthSession | null = null;
let generation = 0;
let refreshing: Promise<AuthSession> | null = null;
let authWrites: Promise<unknown> = Promise.resolve();

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    let message = `HTTP ${status}`;
    try { const error = record(record(body).error); message = typeof error.message === 'string' ? error.message : message; if (typeof error.code === 'string') message = `${error.code}: ${message}`; } catch { /* Non-JSON upstream error. */ }
    super(message);
  }
}

async function http(path: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${API_URL}${path}`, { ...init, signal: controller.signal });
    const raw = await response.text();
    let body: unknown = null;
    try { body = raw ? JSON.parse(raw) as unknown : null; } catch { /* Do not expose HTML upstream responses. */ }
    if (!response.ok) throw new ApiError(response.status, body);
    return body;
  } finally { clearTimeout(timeout); }
}

export function scopeOf(auth: AuthSession): string {
  if (!auth.membershipId) throw new Error('membershipRequired');
  return `${auth.user.id}:${auth.membershipId}`;
}

function persist(auth: AuthSession): Promise<AuthSession> {
  const expectedGeneration = generation;
  const saved = authWrites.then(async () => {
    if (generation !== expectedGeneration) throw new Error('loginRequired');
    await SecureStore.setItemAsync(AUTH_KEY, JSON.stringify(auth));
    if (generation !== expectedGeneration) throw new Error('loginRequired');
    current = auth;
    return auth;
  });
  authWrites = saved.catch(() => undefined);
  return saved;
}

export async function restoreAuth(): Promise<AuthSession | null> {
  const value = await SecureStore.getItemAsync(AUTH_KEY);
  current = value ? JSON.parse(value) as AuthSession : null;
  return current;
}

let devicePromise: Promise<string> | null = null;
export function deviceId(): Promise<string> {
  devicePromise ??= (async () => {
    const stored = await SecureStore.getItemAsync(DEVICE_KEY);
    if (stored) return stored;
    const id = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_KEY, id);
    return id;
  })().catch((error: unknown) => { devicePromise = null; throw error; });
  return devicePromise;
}

export async function requestOtp(phone: string): Promise<void> {
  await http('/auth/otp/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
}

export async function verifyOtp(phone: string, code: string): Promise<AuthSession> {
  const body = record(await http('/auth/otp/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code }) }));
  const user = record(body.user);
  if (!Array.isArray(body.memberships)) throw new Error('invalidResponse');
  const memberships = body.memberships.map((item: unknown) => { const membership = record(item); return { id: text(membership.id), role: text(membership.role), ...(typeof membership.name === 'string' ? { name: membership.name } : {}) }; });
  generation += 1;
  return persist({ accessToken: text(body.accessToken), refreshToken: text(body.refreshToken), user: { id: text(user.id), ...(typeof user.name === 'string' ? { name: user.name } : {}) }, memberships, membershipId: null, registeredMemberships: [] });
}

export async function chooseMembership(id: string): Promise<AuthSession> {
  if (!current?.memberships.some((membership) => membership.id === id && membership.role === 'COLLECTOR')) throw new Error('membershipRequired');
  return persist({ ...current, membershipId: id });
}

export async function clearMembership(): Promise<AuthSession> {
  if (!current) throw new Error('loginRequired');
  return persist({ ...current, membershipId: null });
}

async function refresh(): Promise<AuthSession> {
  if (!current) throw new Error('loginRequired');
  const before = current;
  const beforeGeneration = generation;
  const body = record(await http('/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: before.refreshToken }) }));
  if (generation !== beforeGeneration || !current) throw new Error('loginRequired');
  return persist({ ...current, accessToken: text(body.accessToken), refreshToken: text(body.refreshToken) });
}

export class CollectorApi {
  readonly scope: string;
  constructor(auth: AuthSession) { this.scope = scopeOf(auth); }

  async request(path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const send = async (): Promise<unknown> => {
      const auth = current;
      if (!auth || scopeOf(auth) !== this.scope || !auth.membershipId) throw new Error('loginRequired');
      return http(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken}`, 'X-Membership-Id': auth.membershipId, ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
    const token = current?.accessToken;
    try { return await send(); } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      // Single-flight rotating refresh, including late 401s for the previous access token.
      if (current?.accessToken === token) {
        refreshing ??= refresh().finally(() => { refreshing = null; });
        await refreshing;
      }
      return send();
    }
  }

  async register(): Promise<AuthSession> {
    const id = await deviceId();
    const device = record(await this.request('/collector/devices', { deviceId: id, platform: 'android', appVersion: '0.1.0' }));
    if (device.deviceId !== id || device.revokedAt !== null) throw new Error('invalidResponse');
    if (!current || scopeOf(current) !== this.scope || !current.membershipId) throw new Error('loginRequired');
    return persist({ ...current, registeredMemberships: [...new Set([...current.registeredMemberships, current.membershipId])] });
  }
}

export async function logout(): Promise<void> {
  const token = current?.refreshToken;
  generation += 1;
  current = null;
  const deleted = authWrites.then(() => SecureStore.deleteItemAsync(AUTH_KEY));
  authWrites = deleted.catch(() => undefined);
  await deleted;
  if (token) {
    try { await http('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: token }) }); } catch { /* Local logout still succeeds offline. Server token expires normally. */ }
  }
}

export function parseRoutes(value: unknown): Route[] {
  const body = record(value);
  if (!Array.isArray(body.routes)) throw new Error('invalidResponse');
  return body.routes.map((raw: unknown) => {
    const route = record(raw);
    if (!Array.isArray(route.stops)) throw new Error('invalidResponse');
    const stops: RouteStop[] = route.stops.map((rawStop: unknown) => {
      const stop = record(rawStop);
      const property = record(stop.property);
      if (!Array.isArray(stop.streams) || stop.streams.some((stream: unknown) => !STREAMS.includes(stream as Stream)) || typeof stop.sequence !== 'number') throw new Error('invalidResponse');
      const id = text(property.id);
      if (id !== text(stop.propertyId)) throw new Error('invalidResponse');
      return {
        id: text(stop.id), propertyId: id,
        property: { id, unitNo: text(property.unitNo), block: typeof property.block === 'string' ? property.block : null, latitude: typeof property.latitude === 'number' ? property.latitude : null, longitude: typeof property.longitude === 'number' ? property.longitude : null, propertyCode: text(property.propertyCode), qrToken: property.qrToken === null ? null : text(property.qrToken) },
        sequence: stop.sequence, windowStart: text(stop.windowStart), windowEnd: text(stop.windowEnd), streams: stop.streams as Stream[], status: text(stop.status), lastPickup: stop.lastPickup ?? null,
      };
    });
    return { id: text(route.id), name: text(route.name), date: text(route.date), stops: stops.sort((a, b) => a.sequence - b.sequence) };
  });
}
