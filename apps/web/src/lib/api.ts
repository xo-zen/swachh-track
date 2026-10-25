import { endpoint, record, rows, safeUrl, text, type PageResult, type Row } from './data';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || '/api/v1').replace(/\/$/, '');
export class ApiError extends Error {
  constructor(message: string, public status: number, public code = '', public requestId = '') { super(message); this.name = 'ApiError'; }
}
export interface Membership { id: string; role: string; societyId?: string | null; ulbId?: string | null; contractorId?: string | null; society?: { name?: string }; ulb?: { name?: string }; status?: string }
export interface Identity { user: { id: string; name?: string; phone?: string; email?: string; locale?: string }; memberships: Membership[] }
export interface AuthResult extends Identity { accessToken: string; refreshToken: string }
const demoRoles = { resident: 'RESIDENT', society: 'SOCIETY_ADMIN', collector: 'COLLECTOR', supervisor: 'SUPERVISOR', ulb: 'ULB_ADMIN' } as const;
export type DemoRole = keyof typeof demoRoles;
export interface Access { mode: 'open-demo' | 'authenticated'; roles: { alias: DemoRole; role: string }[] }

class ApiClient {
  private accessToken = '';
  private refreshToken = '';
  private membershipId = '';
  private demoRole: DemoRole | null = null;
  private epoch = 0;
  private refreshPromise: Promise<void> | null = null;
  onExpired: (() => void) | undefined;

  authenticate(result: AuthResult) { this.clear(); this.accessToken = result.accessToken; this.refreshToken = result.refreshToken; }
  selectMembership(id: string) { this.membershipId = id; }
  clear() { this.epoch++; this.accessToken = ''; this.refreshToken = ''; this.membershipId = ''; this.demoRole = null; this.refreshPromise = null; }
  async discoverAccess(): Promise<Access> {
    const body = record(await this.json('/access'));
    if (!['open-demo', 'authenticated'].includes(String(body.mode)) || !Array.isArray(body.roles)) throw new ApiError('Invalid access mode from API.', 502);
    const roles = body.roles.map(value => {
      const item = record(value);
      const alias = text(item.alias) as DemoRole;
      if (!Object.hasOwn(demoRoles, alias) || item.role !== demoRoles[alias]) throw new ApiError('Invalid demo role from API.', 502);
      return { alias, role: demoRoles[alias] };
    });
    if (new Set(roles.map(item => item.alias)).size !== roles.length || (body.mode === 'authenticated' ? roles.length !== 0 : roles.length !== Object.keys(demoRoles).length)) throw new ApiError('Invalid demo roles from API.', 502);
    return { mode: body.mode as Access['mode'], roles };
  }
  async openDemo(alias: DemoRole): Promise<Identity> {
    if (!Object.hasOwn(demoRoles, alias)) throw new ApiError('Unknown demo role.', 400);
    this.clear(); this.demoRole = alias;
    const epoch = this.epoch;
    try {
      const current = await this.json<Identity & { activeMembership?: Membership }>('/me');
      if (epoch !== this.epoch) throw new ApiError('Demo role changed. Please retry.', 409);
      const membership = current.memberships?.find(item => item.id === current.activeMembership?.id && item.role === demoRoles[alias] && item.status === 'ACTIVE');
      if (!current.user?.id || current.memberships?.length !== 1 || !membership) throw new ApiError('The demo identity is not configured. Check the fictional seed.', 502);
      this.selectMembership(membership.id);
      return current;
    } catch (error) { if (epoch === this.epoch) this.clear(); throw error; }
  }
  private async error(response: Response): Promise<ApiError> {
    const body: unknown = await response.json().catch(() => ({}));
    const error = record(record(body).error);
    return new ApiError(text(error.message) || `API request failed (${response.status})`, response.status, text(error.code), text(error.requestId));
  }
  private async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const epoch = this.epoch;
    this.refreshPromise = (async () => {
      const response = await fetch(`${API_URL}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: this.refreshToken }), credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw await this.error(response);
      const result = record(await response.json());
      if (epoch !== this.epoch) throw new ApiError('Session changed. Please retry.', 401);
      if (!text(result.accessToken) || !text(result.refreshToken)) throw new ApiError('Invalid refresh response. Sign in again.', 401);
      this.accessToken = text(result.accessToken); this.refreshToken = text(result.refreshToken);
    })().catch(error => { if (epoch === this.epoch) { this.clear(); this.onExpired?.(); } throw error; }).finally(() => { if (epoch === this.epoch) this.refreshPromise = null; });
    return this.refreshPromise;
  }
  async request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const epoch = this.epoch;
    const membershipId = this.membershipId;
    const headers = new Headers(init.headers);
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    if (this.demoRole) { headers.delete('Authorization'); headers.set('X-Demo-Role', this.demoRole); }
    else if (this.accessToken) headers.set('Authorization', `Bearer ${this.accessToken}`);
    if (this.membershipId) headers.set('X-Membership-Id', this.membershipId);
    let response: Response;
    try { response = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: 'omit', cache: 'no-store' }); }
    catch (error) { if (error instanceof Error && error.name === 'AbortError') throw error; throw new ApiError('Cannot reach the API. Check the server connection and try again.', 0, 'NETWORK_ERROR'); }
    if (epoch !== this.epoch || membershipId !== this.membershipId) throw new ApiError('Session or membership changed. Please retry.', 401);
    if (response.status === 401 && retry && this.refreshToken && !path.startsWith('/auth/')) { await this.refresh(); return this.request(path, init, false); }
    if (!response.ok) throw await this.error(response);
    return response;
  }
  async json<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }
  async list(path: string, signal?: AbortSignal): Promise<PageResult> {
    const result = record(await this.json(path, { signal }));
    if (!Array.isArray(result.data)) throw new ApiError('Invalid API list response: expected {data, nextCursor}.', 502);
    return { items: rows(result.data), nextCursor: text(result.nextCursor) || null };
  }
  async all(path: string, signal?: AbortSignal): Promise<Row[]> {
    const items: Row[] = []; const seen = new Set<string>(); let cursor: string | undefined;
    do {
      const page = await this.list(endpoint(path, { limit: '100', cursor }), signal);
      items.push(...page.items); cursor = page.nextCursor || undefined;
      if (cursor && seen.has(cursor)) throw new ApiError('The API returned a repeated pagination cursor.', 502);
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
  async mutate<T = unknown>(path: string, body: unknown, method = 'POST', idempotencyKey?: string): Promise<T> {
    return this.json<T>(path, { method, body: JSON.stringify(body), headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined });
  }
  async logout() { try { if (!this.demoRole) await this.mutate('/auth/logout', { refreshToken: this.refreshToken }); } finally { this.clear(); } }
  async download(path: string, filename: string, signed = false) {
    let response = await this.request(path);
    if (signed) {
      const url = safeUrl(record(await response.json()).url);
      if (!url) throw new ApiError('The API did not return a private document URL.', 502);
      response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new ApiError('The private document link expired or failed. Retry to renew it.', response.status);
    }
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async upload(file: File, purpose: string): Promise<string> {
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type) || file.size <= 0 || file.size > 8 * 1024 * 1024) throw new ApiError('Upload a JPEG, PNG, WebP or PDF of at most 8 MiB.', 422);
    const reservation = record(await this.mutate('/files/presign', { filename: file.name, contentType: file.type, size: file.size, purpose }));
    const uploadUrl = text(reservation.uploadUrl);
    const id = text(reservation.fileId) || text(reservation.id);
    if (!uploadUrl || !id) throw new ApiError('The API did not return an upload URL and file ID.', 502);
    const response = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type }, credentials: 'omit' });
    if (!response.ok) throw new ApiError('File upload failed. Nothing has been submitted.', response.status);
    await this.mutate(`/files/${encodeURIComponent(id)}/confirm`, {});
    return id;
  }
}
// Credentials stay in memory. Open-demo aliases are resolved to seeded identities by the API.
export const api = new ApiClient();
export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? `${error.message}${error.code ? ` [${error.code}]` : ''}${error.requestId ? ` · ${error.requestId}` : ''}` : error instanceof Error ? error.message : 'Unexpected error';
}
