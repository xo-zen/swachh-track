import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { record, STREAMS, text, type Access, type AuthenticatedSession, type AuthSession, type Route, type RouteStop, type Stream } from './model';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1').replace(/\/$/, '');
const AUTH_KEY = 'swachh.collector.session.v1';
const ACCESS_KEY = 'swachh.collector.access.v1';
const DEVICE_KEY = 'swachh.collector.device.v1';
let current: AuthSession | null = null;
let accessMode: Access['mode'] | null = null;
let generation = 0;
let refreshing: { generation: number; promise: Promise<AuthenticatedSession> } | null = null;
let authWrites: Promise<unknown> = Promise.resolve();

class NetworkError extends Error {
  constructor() { super('offline'); }
}

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
    const response = await fetch(`${API_URL}${path}`, { credentials: 'omit', ...init, signal: controller.signal });
    const raw = await response.text();
    let body: unknown = null;
    try { body = raw ? JSON.parse(raw) as unknown : null; } catch { /* Do not expose HTML upstream responses. */ }
    if (!response.ok) throw new ApiError(response.status, body);
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new NetworkError();
  } finally { clearTimeout(timeout); }
}

export function scopeOf(auth: AuthSession): string {
  if (!auth.membershipId) throw new Error('membershipRequired');
  return `${auth.user.id}:${auth.membershipId}`;
}

function persist<T extends AuthSession>(auth: T): Promise<T> {
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
  await authWrites;
  const value = await SecureStore.getItemAsync(AUTH_KEY);
  current = null;
  if (!value) return null;
  const storedDevice = await SecureStore.getItemAsync(DEVICE_KEY);
  try {
    const saved = record(JSON.parse(value) as unknown);
    const identity = parseIdentity(saved);
    const membershipId = saved.membershipId === null ? null : text(saved.membershipId);
    if (membershipId && !identity.memberships.some((item) => item.id === membershipId && item.role === 'COLLECTOR')) return null;
    if (!Array.isArray(saved.registeredMemberships) || saved.registeredMemberships.some((id: unknown) => typeof id !== 'string')) return null;
    const registeredMemberships = (saved.registeredMemberships as string[]).filter((id) => identity.memberships.some((item) => item.id === id && item.role === 'COLLECTOR'));
    if (saved.mode === 'open-demo') {
      if (saved.demoRole !== 'collector' || saved.apiUrl !== API_URL || !storedDevice || saved.deviceId !== storedDevice || !membershipId || 'accessToken' in saved || 'refreshToken' in saved) return null;
      current = { mode: 'open-demo', demoRole: 'collector', apiUrl: API_URL, deviceId: storedDevice, ...identity, membershipId, registeredMemberships };
    } else if (saved.mode === undefined || saved.mode === 'authenticated') {
      // Shipped v1 token sessions had no discriminator; never infer a demo identity from them.
      current = { mode: 'authenticated', accessToken: text(saved.accessToken), refreshToken: text(saved.refreshToken), ...identity, membershipId, registeredMemberships };
    }
  } catch { /* Invalid saved sessions cannot authorize offline capture. Discovery may recover online. */ }
  return current;
}

function parseIdentity(body: Record<string, unknown>): Pick<AuthSession, 'user' | 'memberships'> {
  const user = record(body.user);
  if (!Array.isArray(body.memberships)) throw new Error('invalidResponse');
  const memberships = body.memberships.map((item: unknown) => {
    const membership = record(item);
    if (membership.userId !== undefined && membership.userId !== user.id) throw new Error('invalidResponse');
    if (membership.status !== undefined && membership.status !== 'ACTIVE') throw new Error('invalidResponse');
    return { id: text(membership.id), role: text(membership.role), ...(typeof membership.name === 'string' ? { name: membership.name } : {}) };
  });
  if (new Set(memberships.map((item) => item.id)).size !== memberships.length) throw new Error('invalidResponse');
  return { user: { id: text(user.id), ...(typeof user.name === 'string' ? { name: user.name } : {}) }, memberships };
}

export async function discoverAccess(): Promise<Access> {
  const body = record(await http('/access', { method: 'GET', headers: { 'X-Demo-Role': 'collector' } }));
  if (!['open-demo', 'authenticated'].includes(String(body.mode)) || !Array.isArray(body.roles)) throw new Error('invalidResponse');
  const roles = body.roles.map((raw: unknown) => {
    const item = record(raw);
    if (!['resident', 'society', 'collector', 'supervisor', 'ulb'].includes(String(item.alias))) throw new Error('invalidResponse');
    return { alias: item.alias as Access['roles'][number]['alias'], role: text(item.role) };
  });
  if (body.mode === 'authenticated' && roles.length) throw new Error('invalidResponse');
  return { mode: body.mode as Access['mode'], roles };
}

function unavailable(error: unknown): boolean {
  return error instanceof NetworkError || (error instanceof ApiError && error.status >= 500);
}

export interface CollectorBoot { mode: Access['mode']; session: AuthSession | null; cached: boolean }
export async function bootstrapCollector(): Promise<CollectorBoot> {
  generation += 1;
  let saved = await restoreAuth();
  current = null;
  accessMode = null;
  const marker = await SecureStore.getItemAsync(ACCESS_KEY);
  if (marker) {
    try {
      const known = record(JSON.parse(marker) as unknown);
      if (known.apiUrl === API_URL && (known.mode === 'open-demo' || known.mode === 'authenticated')) accessMode = known.mode;
      else saved = null;
    } catch { saved = null; }
  }
  if (accessMode && saved?.mode !== accessMode) saved = null;
  let access: Access;
  try { access = await discoverAccess(); }
  catch (error) {
    // A later offline retry must not resurrect an explicitly denied identity.
    if (error instanceof ApiError && [401, 403].includes(error.status)) await discardSession();
    if (!unavailable(error) || !saved) throw error;
    current = saved;
    accessMode = saved.mode;
    return { mode: saved.mode, session: saved, cached: true };
  }
  accessMode = access.mode;
  // Persist discovery before /me. A failed first demo boot must not revive a previous login on restart.
  await SecureStore.setItemAsync(ACCESS_KEY, JSON.stringify({ mode: access.mode, apiUrl: API_URL }));
  if (saved?.mode !== access.mode) {
    saved = null;
    await discardSession();
  }
  if (access.mode === 'authenticated') {
    current = saved;
    return { mode: access.mode, session: saved, cached: false };
  }
  if (!access.roles.some((role) => role.alias === 'collector' && role.role === 'COLLECTOR')) throw new Error('noMembership');
  let body: Record<string, unknown>;
  try { body = record(await http('/me', { method: 'GET', headers: { 'X-Demo-Role': 'collector' } })); }
  catch (error) {
    if (error instanceof ApiError && [401, 403].includes(error.status)) await discardSession();
    if (!unavailable(error) || saved?.mode !== 'open-demo') throw error;
    current = saved;
    return { mode: 'open-demo', session: saved, cached: true };
  }
  const identity = parseIdentity(body);
  const active = record(body.activeMembership);
  if (!identity.memberships.some((item) => item.id === active.id && item.role === active.role && item.role === 'COLLECTOR')) throw new Error('noMembership');
  const previous = saved?.mode === 'open-demo' && saved.user.id === identity.user.id ? saved : null;
  const membershipId = identity.memberships.find((item) => item.role === 'COLLECTOR' && item.id === previous?.membershipId)?.id ?? text(active.id);
  const registeredMemberships = previous?.registeredMemberships.filter((id) => identity.memberships.some((item) => item.id === id && item.role === 'COLLECTOR')) ?? [];
  const session = await persist({ mode: 'open-demo', demoRole: 'collector', apiUrl: API_URL, deviceId: await deviceId(), ...identity, membershipId, registeredMemberships });
  return { mode: 'open-demo', session, cached: false };
}

async function discardSession(): Promise<void> {
  generation += 1;
  current = null;
  const deleted = authWrites.then(() => SecureStore.deleteItemAsync(AUTH_KEY));
  authWrites = deleted.catch(() => undefined);
  await deleted;
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
  if (accessMode !== 'authenticated') throw new Error('startupRequired');
  await http('/auth/otp/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
}

export async function verifyOtp(phone: string, code: string): Promise<AuthenticatedSession> {
  if (accessMode !== 'authenticated') throw new Error('startupRequired');
  const beforeGeneration = generation;
  const body = record(await http('/auth/otp/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code }) }));
  if (generation !== beforeGeneration || accessMode !== 'authenticated') throw new Error('startupRequired');
  const identity = parseIdentity(body);
  generation += 1;
  return persist({ mode: 'authenticated', accessToken: text(body.accessToken), refreshToken: text(body.refreshToken), ...identity, membershipId: null, registeredMemberships: [] });
}

export async function chooseMembership(id: string): Promise<AuthSession> {
  if (current?.mode === 'open-demo') throw new Error('startupRequired');
  if (!current?.memberships.some((membership) => membership.id === id && membership.role === 'COLLECTOR')) throw new Error('membershipRequired');
  return persist({ ...current, membershipId: id });
}

export async function clearMembership(): Promise<AuthSession> {
  if (!current) throw new Error('loginRequired');
  if (current.mode === 'open-demo') throw new Error('startupRequired');
  return persist({ ...current, membershipId: null });
}

async function refresh(): Promise<AuthenticatedSession> {
  if (current?.mode !== 'authenticated') throw new Error('loginRequired');
  const before = current;
  const beforeGeneration = generation;
  const body = record(await http('/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: before.refreshToken }) }));
  if (generation !== beforeGeneration || current?.mode !== 'authenticated') throw new Error('loginRequired');
  return persist({ ...current, accessToken: text(body.accessToken), refreshToken: text(body.refreshToken) });
}

export class CollectorApi {
  readonly scope: string;
  readonly mode: AuthSession['mode'];
  private readonly generation: number;
  constructor(auth: AuthSession) { this.scope = scopeOf(auth); this.mode = auth.mode; this.generation = generation; }

  async request(path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const send = async (): Promise<unknown> => {
      const auth = current;
      if (!auth || auth.mode !== this.mode || generation !== this.generation || scopeOf(auth) !== this.scope || !auth.membershipId) throw new Error(this.mode === 'open-demo' ? 'startupRequired' : 'loginRequired');
      if (auth.mode === 'open-demo' && path.startsWith('/auth/')) throw new Error('startupRequired');
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...Object.fromEntries(Object.entries(extraHeaders).filter(([key]) => !['authorization', 'x-demo-role', 'x-membership-id', 'cookie'].includes(key.toLowerCase()))), 'X-Membership-Id': auth.membershipId };
      if (auth.mode === 'open-demo') headers['X-Demo-Role'] = 'collector';
      else headers.Authorization = `Bearer ${auth.accessToken}`;
      return http(path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
    const token = current?.mode === 'authenticated' ? current.accessToken : null;
    try { return await send(); } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401 || this.mode === 'open-demo' || generation !== this.generation || current?.mode !== 'authenticated') throw error;
      // Single-flight rotating refresh, including late 401s for the previous access token.
      if (current.accessToken === token) {
        if (refreshing?.generation !== this.generation) {
          const flight = { generation: this.generation, promise: refresh() };
          refreshing = flight;
          // A previous session's completion must not clear the new session's flight.
          flight.promise = flight.promise.finally(() => { if (refreshing === flight) refreshing = null; });
        }
        await refreshing.promise;
      }
      return send();
    }
  }

  async register(): Promise<AuthSession> {
    const id = await deviceId();
    const device = record(await this.request('/collector/devices', { deviceId: id, platform: 'android', appVersion: '0.1.0' }));
    if (device.deviceId !== id || device.revokedAt !== null) throw new Error('invalidResponse');
    if (!current || current.mode !== this.mode || generation !== this.generation || scopeOf(current) !== this.scope || !current.membershipId) throw new Error(this.mode === 'open-demo' ? 'startupRequired' : 'loginRequired');
    return persist({ ...current, registeredMemberships: [...new Set([...current.registeredMemberships, current.membershipId])] });
  }
}

export async function logout(): Promise<void> {
  if (current?.mode === 'open-demo' || accessMode === 'open-demo') throw new Error('startupRequired');
  const token = current?.mode === 'authenticated' ? current.refreshToken : null;
  await discardSession();
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
