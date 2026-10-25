import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { DEMO_USERS } from '../src/demo.js';

const id = '00000000-0000-4000-8000-000000000001';
const paths = [
  '/societies/{societyId}/pickups',
  '/ulb/{ulbId}/pickups',
  '/pickups/{id}',
  '/societies/{societyId}/compliance/annual-returns',
  '/societies/{societyId}/invoices/export.csv',
  '/resident/properties',
];

describe.each(['false', 'true'] as const)('endpoint registration with NO_AUTH=%s (no database required)', NO_AUTH => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ logger: false, config: {
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
      JWT_SECRET: 'test-only-jwt-secret-with-more-than-32-bytes',
      QR_SECRET: 'test-only-qr-secret-with-more-than-32-bytes',
      NODE_ENV: NO_AUTH === 'true' ? 'development' : 'test', DEMO_MODE: NO_AUTH, NO_AUTH, HOSTED_DEMO: 'false', STORAGE_DRIVER: 'local', CORS_ORIGINS: 'http://localhost:3000',
    } });
    await app.ready();
  });
  afterAll(async () => { if (app) await app.close(); });

  it.each(paths)('requires an explicit actor for GET %s', async path => {
    const response = await app.inject({ url: `/api/v1${path.replace(/\{[^}]+\}/g, id)}` });
    expect(response.statusCode, response.body).toBe(NO_AUTH === 'true' ? 403 : 401);
    expect(response.json().error.code).toBe(NO_AUTH === 'true' ? 'DEMO_ROLE_INVALID' : 'UNAUTHENTICATED');
  });
  it('discovers the configured mode publicly without reading the database or exposing identities', async () => {
    const response = await app.inject({ url: '/api/v1/access' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(NO_AUTH === 'true'
      ? { mode: 'open-demo', roles: DEMO_USERS.map(({ alias, role }) => ({ alias, role })) }
      : { mode: 'authenticated', roles: [] });
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ url: '/api/v1/access', headers: { authorization: 'Bearer invalid', 'x-demo-role': 'SUPER_ADMIN' } })).json()).toEqual(response.json());
  });
  it.each(['', 'Resident', 'RESIDENT', 'SUPER_ADMIN', 'super_admin', 'unknown', 'resident,society', DEMO_USERS[0].id, DEMO_USERS[0].email])('does not accept alias %j or fall back to JWT', async alias => {
    const response = await app.inject({ url: '/api/v1/me', headers: { 'x-demo-role': alias, authorization: 'Bearer invalid' } });
    expect(response.statusCode, response.body).toBe(NO_AUTH === 'true' ? 403 : 401);
    expect(response.json().error.code).toBe(NO_AUTH === 'true' ? 'DEMO_ROLE_INVALID' : 'UNAUTHENTICATED');
  });
  it.each(['otp/request', 'otp/verify', 'refresh', 'logout'])('disables auth/%s before validating the body only in open demo', async path => {
    const response = await app.inject({ method: 'POST', url: `/api/v1/auth/${path}`, payload: {} });
    expect(response.statusCode, response.body).toBe(NO_AUTH === 'true' ? 403 : 422);
    expect(response.json().error.code).toBe(NO_AUTH === 'true' ? 'AUTH_DISABLED' : 'VALIDATION_ERROR');
  });
  it('allows X-Demo-Role in browser preflight requests', async () => {
    const response = await app.inject({ method: 'OPTIONS', url: '/api/v1/me', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-demo-role,x-membership-id' } });
    expect(response.statusCode, response.body).toBe(204);
    expect(response.headers['access-control-allow-headers']?.toString().toLowerCase().split(',').map(header => header.trim())).toContain('x-demo-role');
  });
  it.skipIf(NO_AUTH === 'true')('never accepts any demo alias as authentication when NO_AUTH is off', async () => {
    for (const user of DEMO_USERS) {
      const response = await app.inject({ url: '/api/v1/me', headers: { 'x-demo-role': user.alias } });
      expect(response.statusCode, response.body).toBe(401);
    }
  });
  it('publishes all six endpoints and their query contracts in OpenAPI', async () => {
    const response = await app.inject({ url: '/docs/json' });
    expect(response.statusCode, response.body).toBe(200);
    const spec = response.json();
    for (const path of paths) expect(spec.paths[`/api/v1${path}`]?.get).toBeDefined();
    const parameters = spec.paths['/api/v1/societies/{societyId}/pickups'].get.parameters;
    expect(parameters.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(['societyId', 'wardId', 'cursor', 'limit', 'from', 'to', 'status']));
  });
});
