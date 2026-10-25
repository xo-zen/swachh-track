import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const id = '00000000-0000-4000-8000-000000000001';
const paths = [
  '/societies/{societyId}/pickups',
  '/ulb/{ulbId}/pickups',
  '/pickups/{id}',
  '/societies/{societyId}/compliance/annual-returns',
  '/societies/{societyId}/invoices/export.csv',
  '/resident/properties',
];

describe('web read endpoint registration (no database required)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ logger: false, config: {
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
      JWT_SECRET: 'test-only-jwt-secret-with-more-than-32-bytes',
      QR_SECRET: 'test-only-qr-secret-with-more-than-32-bytes',
      NODE_ENV: 'test', DEMO_MODE: 'false', STORAGE_DRIVER: 'local',
    } });
    await app.ready();
  });
  afterAll(async () => { if (app) await app.close(); });

  it.each(paths)('requires authentication for GET %s', async path => {
    const response = await app.inject({ url: `/api/v1${path.replace(/\{[^}]+\}/g, id)}` });
    expect(response.statusCode, response.body).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
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
