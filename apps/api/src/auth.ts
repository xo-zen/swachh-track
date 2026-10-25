import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { api, authenticate, constantEqual, fail, hmac, hostedDemoActor, json, publicUser, Scope, serialized, type App } from './core.js';
import type { Prisma } from '@prisma/client';
import { DEMO_USERS } from './demo.js';

const phone = z.string().regex(/^\+[1-9]\d{9,14}$/);
const identity = z.object({ phone: z.string().min(3).max(100) }).strict();
const refreshBody = z.object({ refreshToken: z.string().min(32).max(200) }).strict();

export interface OtpProvider { send(phone: string, code: string): Promise<void> }
export class DemoOtpProvider implements OtpProvider {
  async send(_phone: string, _code: string) { /* Development code is disclosed explicitly in the response, never sent as SMS. */ }
}
export class UnconfiguredOtpProvider implements OtpProvider {
  async send(_phone: string, _code: string): Promise<void> {
    fail(503, 'OTP_PROVIDER_NOT_CONFIGURED', 'An SMS OTP provider must be configured before non-demo sign-in. No code was sent.');
  }
}

export async function authRoutes(app: App) {
  const router = api(app);
  router.get('/access', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return app.config.NO_AUTH === 'true'
      ? { mode: 'open-demo', roles: DEMO_USERS.map(({ alias, role }) => ({ alias, role })) }
      : { mode: 'authenticated', roles: [] };
  });
  async function requireAuthenticationEnabled() {
    if (app.config.NO_AUTH === 'true') return fail(403, 'AUTH_DISABLED', 'Credential authentication is disabled in open demo mode. Select a role using X-Demo-Role.');
  }
  const otpProvider: OtpProvider = app.config.NODE_ENV === 'development' && app.config.DEMO_MODE === 'true' ? new DemoOtpProvider() : new UnconfiguredOtpProvider();
  async function resolvePhone(value: string) {
    if (app.config.HOSTED_DEMO === 'true') {
      const expected = DEMO_USERS.find(user => user.phone === value || user.email === value);
      return expected?.phone ?? fail(403, 'HOSTED_DEMO_IDENTITY_FORBIDDEN', 'Only the unchanged primary seeded demo accounts may sign in.');
    }
    if (phone.safeParse(value).success) return value;
    if (app.config.NODE_ENV !== 'development' || app.config.DEMO_MODE !== 'true' || !value.endsWith('@demo.swachhtrack.in')) {
      return fail(422, 'PHONE_INVALID', 'Use an E.164 phone number. Demo email aliases are development-only.');
    }
    const user = await app.db.user.findUnique({ where: { email: value } });
    return user?.phone ?? fail(422, 'DEMO_IDENTITY_UNKNOWN', 'Unknown demo identity.');
  }
  async function tokens(tx: Prisma.TransactionClient, userId: string, familyId: string = randomUUID()) {
    const hosted = app.config.HOSTED_DEMO === 'true' ? await hostedDemoActor(tx, userId) : null;
    const refreshToken = randomBytes(48).toString('base64url');
    await tx.refreshToken.create({ data: { userId, tokenHash: hmac(refreshToken, app.config.JWT_SECRET), familyId, expiresAt: new Date(Date.now() + 30 * 86400000) } });
    const user = hosted?.user ?? await tx.user.findUniqueOrThrow({ where: { id: userId } });
    const memberships = hosted ? [hosted.membership] : await tx.membership.findMany({ where: { userId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
    return { accessToken: app.jwt.sign({ sub: userId, type: 'access' }, { expiresIn: '15m' }), refreshToken, user: publicUser(user), memberships };
  }

  router.post('/auth/otp/request', { onRequest: requireAuthenticationEnabled, schema: { body: identity }, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const resolved = await resolvePhone(request.body.phone);
    const demo = app.config.NODE_ENV === 'development' && app.config.DEMO_MODE === 'true';
    let code = demo ? '123456' : String(randomInt(100000, 1000000));
    while (!demo && code === '123456') code = String(randomInt(100000, 1000000));
    await serialized(app.db, `otp:${resolved}`, async tx => {
      if (app.config.HOSTED_DEMO === 'true') await hostedDemoActor(tx, DEMO_USERS.find(user => user.phone === resolved)!.id);
      const previous = await tx.otpChallenge.findUnique({ where: { phone: resolved } });
      if (previous && Date.now() - previous.requestedAt.getTime() < 60000) fail(429, 'OTP_COOLDOWN', 'Wait 60 seconds before requesting another code.');
      const sameWindow = previous && Date.now() - previous.windowStartedAt.getTime() < 3600000;
      if (sameWindow && previous.requestCount >= 5) fail(429, 'OTP_PHONE_LIMIT', 'A phone number may request at most five codes per hour.');
      const data = { codeHash: hmac(`${resolved}:${code}`, app.config.JWT_SECRET), expiresAt: new Date(Date.now() + 300000), requestedAt: new Date(), windowStartedAt: sameWindow ? previous.windowStartedAt : new Date(), requestCount: sameWindow ? previous.requestCount + 1 : 1, attempts: 0, consumedAt: null };
      await tx.otpChallenge.upsert({ where: { phone: resolved }, create: { phone: resolved, ...data }, update: data });
      await otpProvider.send(resolved, code);
    });
    return reply.code(202).send({ status: demo ? 'DEMO_CODE_AVAILABLE' : 'OTP_SENT', expiresIn: 300, retryAfter: 60, ...(demo ? { demoCode: '123456' } : {}) });
  });

  router.post('/auth/otp/verify', { onRequest: requireAuthenticationEnabled, schema: { body: identity.extend({ code: z.string().regex(/^\d{6}$/) }) }, config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } }, async request => {
    if (request.body.code === '123456' && (app.config.NODE_ENV !== 'development' || app.config.DEMO_MODE !== 'true')) return fail(401, 'DEMO_OTP_DISABLED', 'Fixed OTP verification is disabled.');
    const resolved = await resolvePhone(request.body.phone);
    const result = await serialized(app.db, `otp:${resolved}`, async tx => {
      const challenge = await tx.otpChallenge.findUnique({ where: { phone: resolved } });
      if (!challenge || challenge.consumedAt || challenge.expiresAt.getTime() < Date.now() || challenge.attempts >= 5) return null;
      await tx.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
      if (!constantEqual(challenge.codeHash, hmac(`${resolved}:${request.body.code}`, app.config.JWT_SECRET))) return null;
      const user = await tx.user.findFirst({ where: { phone: resolved, status: 'ACTIVE' } });
      if (!user) return null;
      await tx.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
      return tokens(tx, user.id);
    });
    return result ?? fail(401, 'OTP_INVALID', 'The code is invalid, expired, used, or its attempt limit was reached.');
  });

  router.post('/auth/refresh', { onRequest: requireAuthenticationEnabled, schema: { body: refreshBody } }, async request => {
    const tokenHash = hmac(request.body.refreshToken, app.config.JWT_SECRET);
    const initial = await app.db.refreshToken.findUnique({ where: { tokenHash } });
    if (!initial) return fail(401, 'REFRESH_INVALID', 'Refresh token is invalid.');
    const result = await serialized(app.db, `refresh:${initial.familyId}`, async tx => {
      const token = await tx.refreshToken.findUniqueOrThrow({ where: { tokenHash } });
      if (token.usedAt || token.revokedAt) {
        await tx.refreshToken.updateMany({ where: { familyId: token.familyId }, data: { revokedAt: new Date() } });
        return null;
      }
      if (token.expiresAt.getTime() < Date.now()) return null;
      const user = await tx.user.findFirst({ where: { id: token.userId, status: 'ACTIVE' } });
      if (!user) return null;
      await tx.refreshToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
      return tokens(tx, token.userId, token.familyId);
    });
    return result ?? fail(401, 'REFRESH_REUSED_OR_EXPIRED', 'Session expired or token reused. Sign in again.');
  });
  router.post('/auth/logout', { onRequest: requireAuthenticationEnabled, schema: { body: refreshBody } }, async request => {
    const token = await app.db.refreshToken.findUnique({ where: { tokenHash: hmac(request.body.refreshToken, app.config.JWT_SECRET) } });
    if (token) await app.db.refreshToken.updateMany({ where: { familyId: token.familyId }, data: { revokedAt: new Date() } });
    return { status: 'LOGGED_OUT' };
  });
  router.get('/me', { preHandler: authenticate }, async request => {
    const scope = new Scope(request);
    const memberships = await app.db.membership.findMany({ where: { userId: scope.userId, status: 'ACTIVE', ...(app.config.HOSTED_DEMO === 'true' || app.config.NO_AUTH === 'true' ? { id: scope.membership.id, ulbId: scope.ulbId } : {}) }, include: { ulb: { select: { name: true, flags: true } } } });
    const enriched = await Promise.all(memberships.map(async membership => ({ ...membership, society: membership.societyId ? await app.db.society.findFirst({ where: { id: membership.societyId, ulbId: membership.ulbId, deletedAt: null }, select: { name: true } }) : null })));
    return { user: publicUser(scope.actor.user), memberships: enriched, activeMembership: scope.membership };
  });
  router.patch('/me', { preHandler: authenticate, schema: { body: z.object({ name: z.string().min(1).max(100).optional(), email: z.string().email().optional(), locale: z.enum(['en', 'hi']).optional(), notificationPreferences: z.object({ inApp: z.boolean(), email: z.boolean(), whatsapp: z.boolean() }).strict().optional() }).strict() } }, async request => {
    if (app.config.HOSTED_DEMO === 'true' || app.config.NO_AUTH === 'true') return fail(403, 'HOSTED_DEMO_IDENTITY_LOCKED', 'Personal identity changes are disabled in this demo.');
    const scope = new Scope(request);
    return { user: publicUser(await app.db.user.update({ where: { id: scope.userId }, data: request.body })) };
  });
  router.post('/me/privacy-requests', { preHandler: authenticate, schema: { body: z.object({ type: z.enum(['EXPORT', 'ERASURE']) }).strict() } }, async (request, reply) => {
    const scope = new Scope(request);
    const result = await app.db.$transaction(async tx => {
      const row = await tx.privacyRequest.create({ data: { ulbId: scope.ulbId, userId: scope.userId, type: request.body.type } });
      await new Scope(request, tx).audit('PRIVACY_REQUESTED', 'PrivacyRequest', row.id, undefined, json(row));
      return row;
    });
    return reply.code(202).send(result);
  });
}
