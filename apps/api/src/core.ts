import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma, type Membership, type PrismaClient, type Role, type User } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import type { Storage } from './storage.js';
import { DEMO_SEED_ACTION, DEMO_ULB_CODE, DEMO_ULB_ID, DEMO_USERS } from './demo.js';

export type App = FastifyInstance;
export type Db = PrismaClient | Prisma.TransactionClient;
export type Actor = { user: User; membership: Membership };
declare module 'fastify' {
  interface FastifyInstance {
    db: PrismaClient;
    config: Config;
    storage: Storage;
  }
  interface FastifyRequest { actor: Actor | null; rawBody: string | null }
}

export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const fail = (status: number, code: string, message: string, details?: unknown): never => {
  throw new ApiError(status, code, message, details);
};
export const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const hmac = (value: string, secret: string) => createHmac('sha256', secret).update(value).digest('base64url');
export function constantEqual(a: string, b: string) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export const uuid = z.string().uuid();
export const idParams = z.object({ id: uuid }).strict();
export const societyParams = z.object({ societyId: uuid }).strict();
export const societyIdParams = societyParams.extend({ id: uuid });
export const streamSchema = z.enum(['WET', 'DRY', 'SANITARY', 'SPECIAL_CARE']);
export const pagination = z.object({
  cursor: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
  from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
  status: z.string().max(40).optional(), societyId: uuid.optional(), wardId: uuid.optional(),
  search: z.string().max(100).optional(),
}).strict();
export function pageArgs(q: { cursor?: string; limit: number }) {
  return { take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}), orderBy: { id: 'asc' as const } };
}
export function page<T extends { id: string }>(rows: T[], limit: number) {
  const data = rows.slice(0, limit);
  return { data, nextCursor: rows.length > limit ? data.at(-1)?.id ?? null : null };
}
export function dateRange(q: { from?: string; to?: string }) {
  if (q.from && q.to && Date.parse(q.from) > Date.parse(q.to)) fail(422, 'DATE_RANGE_INVALID', 'from must not follow to.');
  return { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
}
export const api = (app: App) => app.withTypeProvider<ZodTypeProvider>();

export async function hostedDemoActor(db: Db, userId: string): Promise<Actor> {
  const expected = DEMO_USERS.find(user => user.id === userId);
  if (!expected) return fail(403, 'HOSTED_DEMO_IDENTITY_FORBIDDEN', 'Only the unchanged primary seeded demo accounts may sign in.');
  const user = await db.user.findFirst({
    where: { id: expected.id, phone: expected.phone, email: expected.email, status: 'ACTIVE' },
    include: { memberships: { where: {
      id: expected.membershipId, ulbId: DEMO_ULB_ID, status: 'ACTIVE', role: expected.role,
      societyId: expected.societyId, contractorId: expected.contractorId, ulb: { code: DEMO_ULB_CODE },
    } } },
  });
  const membership = user?.memberships[0];
  const seeded = membership && await db.auditLog.findFirst({
    where: { ulbId: DEMO_ULB_ID, action: DEMO_SEED_ACTION, entity: 'Ulb', entityId: DEMO_ULB_ID }, select: { id: true },
  });
  if (!user || !membership || !seeded) return fail(403, 'HOSTED_DEMO_IDENTITY_FORBIDDEN', 'Only the unchanged primary seeded demo accounts may sign in.');
  return { user, membership };
}

export async function authenticate(request: FastifyRequest) {
  const app = request.server;
  if (app.config.NO_AUTH === 'true') {
    const alias = request.headers['x-demo-role'];
    const expected = typeof alias === 'string' ? DEMO_USERS.find(user => user.alias === alias) : undefined;
    if (!expected) return fail(403, 'DEMO_ROLE_INVALID', 'X-Demo-Role must be exactly resident, society, collector, supervisor, or ulb.');
    const actor = await hostedDemoActor(app.db, expected.id);
    const selected = request.headers['x-membership-id'];
    if (selected !== undefined && (typeof selected !== 'string' || !uuid.safeParse(selected).success)) {
      return fail(400, 'MEMBERSHIP_INVALID', 'X-Membership-Id must be a UUID.');
    }
    if (selected !== undefined && selected !== actor.membership.id) return fail(403, 'MEMBERSHIP_FORBIDDEN', 'No active membership authorizes this request.');
    request.actor = actor;
    return;
  }
  let payload: { sub: string; type: string };
  try { payload = await request.jwtVerify<{ sub: string; type: string }>(); }
  catch { return fail(401, 'UNAUTHENTICATED', 'A valid access token is required.'); }
  if (payload.type !== 'access') fail(401, 'TOKEN_TYPE', 'An access token is required.');
  const hosted = app.config.HOSTED_DEMO === 'true' ? await hostedDemoActor(app.db, payload.sub) : null;
  const user = hosted?.user ?? await app.db.user.findFirst({ where: { id: payload.sub, status: 'ACTIVE' } });
  if (!user) return fail(401, 'USER_INACTIVE', 'The account is inactive.');
  const selected = request.headers['x-membership-id'];
  if (selected && (typeof selected !== 'string' || !uuid.safeParse(selected).success)) {
    fail(400, 'MEMBERSHIP_INVALID', 'X-Membership-Id must be a UUID.');
  }
  const memberships = hosted ? [hosted.membership] : await app.db.membership.findMany({ where: { userId: user.id, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  const membership = selected ? memberships.find(m => m.id === selected) : memberships[0];
  if (!membership) return fail(403, 'MEMBERSHIP_FORBIDDEN', 'No active membership authorizes this request.');
  request.actor = { user, membership };
}

export function authorize(...roles: Role[]) {
  return async (request: FastifyRequest) => {
    await authenticate(request);
    if (!request.actor || !roles.includes(request.actor.membership.role)) fail(403, 'ROLE_FORBIDDEN', 'This role cannot perform this operation.');
  };
}

// All operational lookup predicates originate here; tenant identifiers never come from bodies.
export class Scope {
  readonly actor: Actor;
  readonly ulbId: string;
  readonly userId: string;
  readonly membership: Membership;
  constructor(readonly request: FastifyRequest, readonly db: Db = request.server.db) {
    if (!request.actor) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in first.');
    this.actor = request.actor;
    this.membership = request.actor.membership;
    this.ulbId = this.membership.ulbId;
    this.userId = this.actor.user.id;
  }
  societyFilter(): Prisma.SocietyWhereInput {
    const m = this.membership;
    return { ulbId: this.ulbId, deletedAt: null,
      ...(['SOCIETY_ADMIN', 'RESIDENT'].includes(m.role) ? { id: m.societyId ?? '00000000-0000-0000-0000-000000000000' } : {}),
      ...(m.role === 'SUPERVISOR' ? { properties: { some: { ulbId: this.ulbId, routeStops: { some: { ulbId: this.ulbId, route: { contractorId: m.contractorId ?? '00000000-0000-0000-0000-000000000000' } } } } } } : {}),
    };
  }
  propertyFilter(): Prisma.PropertyWhereInput {
    const m = this.membership;
    return { ulbId: this.ulbId, deletedAt: null,
      ...(['SOCIETY_ADMIN', 'RESIDENT'].includes(m.role) ? { societyId: m.societyId ?? '00000000-0000-0000-0000-000000000000' } : {}),
      ...(m.role === 'RESIDENT' ? { residents: { some: { ulbId: this.ulbId, userId: this.userId, active: true } } } : {}),
      ...(m.role === 'SUPERVISOR' ? { routeStops: { some: { ulbId: this.ulbId, route: { contractorId: m.contractorId ?? '00000000-0000-0000-0000-000000000000' } } } } : {}),
      ...(m.role === 'COLLECTOR' ? { routeStops: { some: { ulbId: this.ulbId, route: { date: new Date(istDate()), collectorId: { in: [] } } } } } : {}),
    };
  }
  async society(id: string) {
    const row = await this.db.society.findFirst({ where: { AND: [this.societyFilter(), { id }] } });
    return row ?? fail(404, 'NOT_FOUND', 'Society not found.');
  }
  async property(id: string) {
    const row = await this.db.property.findFirst({ where: { AND: [this.propertyFilter(), { id }] } });
    return row ?? fail(404, 'NOT_FOUND', 'Property not found.');
  }
  async collector() {
    const row = await this.db.collector.findFirst({ where: { ulbId: this.ulbId, userId: this.userId, status: 'ACTIVE', ...(this.membership.contractorId ? { contractorId: this.membership.contractorId } : {}) } });
    return row ?? fail(403, 'COLLECTOR_NOT_BOUND', 'No active collector record for this membership.');
  }
  async pickupFilter(): Promise<Prisma.PickupEventWhereInput> {
    const m = this.membership;
    const base: Prisma.PickupEventWhereInput = { ulbId: this.ulbId };
    if (m.role === 'RESIDENT') {
      const properties = await this.db.property.findMany({ where: this.propertyFilter(), select: { id: true } });
      base.propertyId = { in: properties.map(p => p.id) };
    } else if (m.role === 'SOCIETY_ADMIN') base.societyId = m.societyId ?? '00000000-0000-0000-0000-000000000000';
    else if (m.role === 'COLLECTOR') base.collectorId = (await this.collector()).id;
    else if (m.role === 'SUPERVISOR') {
      const collectors = await this.db.collector.findMany({ where: { ulbId: this.ulbId, contractorId: m.contractorId ?? '00000000-0000-0000-0000-000000000000' }, select: { id: true } });
      base.collectorId = { in: collectors.map(c => c.id) };
    }
    return base;
  }
  async pickup(id: string) {
    const row = await this.db.pickupEvent.findFirst({ where: { AND: [await this.pickupFilter(), { id }] }, include: { streams: true } });
    return row ?? fail(404, 'NOT_FOUND', 'Pickup not found.');
  }
  ulb(id: string) { if (id !== this.ulbId) fail(404, 'NOT_FOUND', 'ULB not found.'); }
  async feature(name: string) {
    const ulb = await this.db.ulb.findUniqueOrThrow({ where: { id: this.ulbId } });
    if ((ulb.flags as Record<string, unknown>)[name] !== true) fail(403, 'FEATURE_DISABLED', `${name} is disabled for this ULB.`);
  }
  async photo(id: string, kind?: string) {
    const photo = await this.db.photo.findFirst({ where: { id, ulbId: this.ulbId, ownerId: this.userId, status: 'CONFIRMED', ...(kind ? { kind } : {}) } });
    return photo ?? fail(422, 'PHOTO_UNCONFIRMED', 'A confirmed photo owned by the current user is required.');
  }
  async audit(action: string, entity: string, entityId: string, before?: unknown, after?: unknown) {
    return this.db.auditLog.create({ data: { ulbId: this.ulbId, actorId: this.userId, action, entity, entityId,
      ...(before !== undefined ? { before: json(before) } : {}), ...(after !== undefined ? { after: json(after) } : {}), ip: this.request.ip } });
  }
  async notify(template: string, entityId: string, payload: unknown, userId = this.userId) {
    const notification = await this.db.notification.upsert({ where: { dedupeKey: `${this.ulbId}:${template}:${entityId}:${userId}` }, update: {},
      create: { ulbId: this.ulbId, userId, dedupeKey: `${this.ulbId}:${template}:${entityId}:${userId}`, template, payload: json(payload) } });
    const user = userId === this.userId ? this.actor.user : await this.db.user.findUnique({ where: { id: userId } });
    const preferences = (user?.notificationPreferences ?? {}) as Record<string, boolean>;
    const channels: string[] = preferences.email ? ['EMAIL'] : [];
    if (preferences.whatsapp) {
      const tenant = await this.db.ulb.findUniqueOrThrow({ where: { id: this.ulbId } });
      if ((tenant.flags as Record<string, boolean>).whatsapp_v1 === true) channels.push('WHATSAPP');
    }
    for (const channel of channels) {
      const dedupeKey = `${this.ulbId}:${template}:${entityId}:${userId}:${channel}`;
      await this.db.notification.upsert({ where: { dedupeKey }, update: {}, create: { ulbId: this.ulbId, userId, dedupeKey, channel, template, payload: json(payload) } });
    }
    return notification;
  }
}

export function idempotencyHeader(request: FastifyRequest) {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) return fail(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key of 8 to 200 characters is required.');
  return key;
}
export async function serialized<T>(db: PrismaClient, lock: string, action: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
    return action(tx);
  }, { timeout: 30000 });
}
export function publicUser(user: User) {
  return { id: user.id, name: user.name, phone: user.phone, email: user.email, locale: user.locale, notificationPreferences: user.notificationPreferences };
}
export function istDate(date: Date = new Date()) { return new Date(date.getTime() + 330 * 60000).toISOString().slice(0, 10); }
