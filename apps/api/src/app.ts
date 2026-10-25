import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { validatorCompiler, serializerCompiler, jsonSchemaTransform } from 'fastify-type-provider-zod';
import { Prisma, PrismaClient } from '@prisma/client';
import { ZodError } from 'zod';
import { batchSchema } from '@swachh/contracts';
import { loadConfig, type Config } from './config.js';
import { ApiError } from './core.js';
import { Storage, uploadRoutes } from './storage.js';
import { authRoutes } from './auth.js';
import { registryRoutes } from './registry.js';
import { pickupRoutes } from './pickups.js';
import { operationRoutes } from './operations.js';
import { billingRoutes } from './billing.js';
import { complianceRoutes } from './compliance.js';
import { reportingRoutes } from './reporting.js';

export async function buildApp(options: { db?: PrismaClient; config?: Partial<Config>; logger?: boolean } = {}) {
  const config = loadConfig(options.config);
  const db = options.db ?? new PrismaClient({ datasources: { db: { url: config.DATABASE_URL } } });
  const app = Fastify({ logger: options.logger === false ? false : { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'body.phone', 'body.code', 'body.refreshToken'] }, bodyLimit: 2 * 1024 * 1024, maxParamLength: 2048, trustProxy: false });
  app.decorate('db', db); app.decorate('config', config); app.decorate('storage', new Storage(config));
  app.decorateRequest('actor', null);
  app.decorateRequest('rawBody', null);
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = String(body); parseJson(request, String(body), done);
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cors, { origin: config.CORS_ORIGINS.split(',').map(x => x.trim()), allowedHeaders: ['Content-Type', 'Authorization', 'X-Membership-Id', 'Idempotency-Key'], exposedHeaders: ['Content-Disposition'] });
  await app.register(helmet);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(jwt, { secret: config.JWT_SECRET });
  await app.register(swagger, { openapi: { info: { title: 'Swachh-Track API', version: '0.1.0' }, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } } }, transform: options => jsonSchemaTransform({ ...options, schema: options.url.endsWith('/collector/pickups/batch') ? { ...options.schema, body: batchSchema } : options.schema }) });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.setErrorHandler((error, request, reply) => {
    let status = error.statusCode ?? 500; let code = 'INTERNAL_ERROR'; let message = 'The request could not be completed.'; let details: unknown;
    if (error instanceof ApiError) { status = error.statusCode; code = error.code; message = error.message; details = error.details; }
    else if (error.validation || error instanceof ZodError) { status = 422; code = 'VALIDATION_ERROR'; message = 'Request validation failed.'; details = error instanceof ZodError ? error.flatten() : error.validation; }
    else if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') { status = 409; code = 'CONFLICT'; message = 'A record with this identity already exists.'; }
      else if (error.code === 'P2025') { status = 404; code = 'NOT_FOUND'; message = 'Record not found.'; }
      else if (error.code === 'P2003') { status = 422; code = 'REFERENCE_INVALID'; message = 'A related record is invalid.'; }
    } else if (status < 500) { code = status === 429 ? 'RATE_LIMITED' : 'REQUEST_ERROR'; message = error.message; }
    if (status >= 500) request.log.error({ errorName: error.name, code, requestId: request.id }, 'Request failed');
    return reply.code(status).send({ error: { code, message, ...(details ? { details } : {}), requestId: request.id } });
  });
  await app.register(async api => {
    api.get('/healthz', async () => ({ status: 'ok' }));
    api.get('/readyz', async (_request, reply) => {
      try { await db.$queryRaw`SELECT 1`; return { status: 'ready', database: 'ok' }; }
      catch { return reply.code(503).send({ status: 'not_ready', database: 'unavailable' }); }
    });
    await authRoutes(api); await uploadRoutes(api); await registryRoutes(api); await pickupRoutes(api);
    await operationRoutes(api); await billingRoutes(api); await complianceRoutes(api); await reportingRoutes(api);
  }, { prefix: '/api/v1' });
  if (!options.db) app.addHook('onClose', async () => { await db.$disconnect(); });
  return app;
}
