import { z } from 'zod';
import { errorEnvelopeSchema, type ErrorEnvelope } from './index';

export class ApiError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | undefined;
  constructor(readonly status: number, envelope: ErrorEnvelope) {
    super(envelope.error.message);
    this.name = 'ApiError';
    this.code = envelope.error.code;
    this.details = envelope.error.details;
    this.requestId = envelope.error.requestId;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getAccessToken?: () => string | undefined | Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
}
export interface ApiRequestOptions<T = unknown> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  signal?: AbortSignal;
  schema?: z.ZodType<T>;
}

export function createApiClient(options: ApiClientOptions) {
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async request<T = unknown>(path: string, request: ApiRequestOptions<T> = {}): Promise<T> {
      // Do not allow a caller-supplied path to send the bearer token to another origin.
      if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\r\n]/.test(path)) throw new Error('API path must be origin-relative');
      const token = await options.getAccessToken?.();
      const headers = new Headers(request.headers);
      headers.set('Accept', 'application/json');
      if (token) headers.set('Authorization', `Bearer ${token}`);
      if (request.idempotencyKey) headers.set('Idempotency-Key', request.idempotencyKey);
      if (request.body !== undefined) headers.set('Content-Type', 'application/json');
      const response = await fetcher(`${options.baseUrl.replace(/\/$/, '')}${path}`, {
        method: request.method ?? 'GET', headers, signal: request.signal,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: 'error',
      });
      const text = await response.text();
      let payload: unknown;
      try { payload = text ? JSON.parse(text) as unknown : undefined; } catch { payload = undefined; }
      if (!response.ok) {
        const parsed = errorEnvelopeSchema.safeParse(payload);
        throw new ApiError(response.status, parsed.success ? parsed.data : {
          error: { code: 'HTTP_ERROR', message: `Request failed (${response.status})`, requestId: response.headers.get('x-request-id') ?? undefined },
        });
      }
      if (text && payload === undefined) throw new ApiError(response.status, { error: { code: 'INVALID_RESPONSE', message: 'Expected a JSON response' } });
      return request.schema ? request.schema.parse(payload) : payload as T;
    },
  };
}
