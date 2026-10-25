import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hmac } from '../src/core.js';
import { demoId, DEMO_SEED_ACTION, DEMO_ULB_CODE, DEMO_ULB_ID, DEMO_USERS } from '../src/demo.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const secret = 'hosted-demo-test-only-secret-value-0123456789';
const resident = DEMO_USERS[0];
const society = DEMO_USERS[1];
const foreignUlbId = demoId('hosted-test-foreign-ulb');
const foreignMembership = (id: string) => demoId(`hosted-test-foreign-${id}`);
const extraMembership = (id: string) => demoId(`hosted-test-extra-${id}`);
const outsiders = [
  { id: demoId('user-collector-1'), phone: '+919000000011', email: null, ulbId: DEMO_ULB_ID },
  { id: demoId('user-isolation'), phone: '+919000000099', email: 'isolation@demo.swachhtrack.in', ulbId: foreignUlbId },
  { id: demoId('hosted-test-nonseeded'), phone: '+919123456789', email: 'other@demo.swachhtrack.in', ulbId: DEMO_ULB_ID },
];

suite('hosted demo API (disposable, separately migrated database)', () => {
  const databaseName = `hosted_demo_test_${randomUUID().replaceAll('-', '')}`;
  let admin: PrismaClient; let db: PrismaClient; let app: FastifyInstance;
  let isolatedUrl: string; let created = false;
  const headers = (userId = resident.id, membershipId?: string) => ({
    authorization: `Bearer ${app.jwt.sign({ sub: userId, type: 'access' })}`,
    ...(membershipId ? { 'x-membership-id': membershipId } : {}),
  });
  const requestOtp = (phone: string) => app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } });
  const verifyOtp = (phone: string, code = '123456') => app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone, code } });
  const refresh = (refreshToken: string) => app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken } });
  async function existingRefresh(userId: string) {
    const value = randomBytes(48).toString('base64url');
    await db.refreshToken.create({ data: { userId, tokenHash: hmac(value, secret), familyId: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } });
    return value;
  }
  async function login(user = resident, identity: string = user.phone) {
    const requested = await requestOtp(identity);
    expect(requested.statusCode, requested.body).toBe(202);
    expect(requested.json().demoCode).toBe('123456');
    const verified = await verifyOtp(identity);
    expect(verified.statusCode, verified.body).toBe(200);
    return verified.json();
  }
  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    await admin.$queryRaw`SELECT 1`;
    // Never seed, truncate or migrate the caller's database, which may already hold NAGAR-DEMO.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const url = new URL(databaseUrl!);
    url.pathname = `/${databaseName}`;
    url.searchParams.set('schema', 'public');
    isolatedUrl = url.toString();
    try {
      await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL('../../../node_modules/prisma/build/index.js', import.meta.url)),
        'migrate', 'deploy', '--schema', fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url)),
      ], { env: { ...process.env, DATABASE_URL: isolatedUrl }, timeout: 45000 });
    } catch {
      throw new Error('Could not migrate the disposable hosted-demo test database.');
    }
    db = new PrismaClient({ datasources: { db: { url: isolatedUrl } } });
    await db.$connect();
  });
  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE "AuditLog", "PrivacyRequest", "Schedule", "Resident", "Property", "Membership", "Contractor", "Society", "Ward", "Ulb", "RefreshToken", "OtpChallenge", "User" CASCADE`;
    await db.ulb.createMany({ data: [
      { id: DEMO_ULB_ID, code: DEMO_ULB_CODE, name: 'Hosted demo fixture', state: 'Test' },
      { id: foreignUlbId, code: 'HOSTED-TEST-FOREIGN', name: 'Foreign fixture', state: 'Test' },
    ] });
    await db.ward.create({ data: { id: demoId('ward-0'), ulbId: DEMO_ULB_ID, code: 'W1', name: 'Fixture Ward' } });
    await db.society.create({ data: { id: society.societyId!, ulbId: DEMO_ULB_ID, wardId: demoId('ward-0'), name: 'Fictional Society', address: 'Fictional', latitude: 18, longitude: 73 } });
    await db.contractor.create({ data: { id: demoId('contractor-0'), ulbId: DEMO_ULB_ID, name: 'Fixture Contractor', contractNo: 'C1', validFrom: new Date('2020-01-01'), validTo: new Date('2099-01-01') } });
    for (const user of DEMO_USERS) {
      await db.user.create({ data: { id: user.id, name: user.name, phone: user.phone, email: user.email } });
      await db.membership.createMany({ data: [
        { id: user.membershipId, userId: user.id, ulbId: DEMO_ULB_ID, role: user.role, societyId: user.societyId, contractorId: user.contractorId },
        { id: foreignMembership(user.id), userId: user.id, ulbId: foreignUlbId, role: 'SUPER_ADMIN', createdAt: new Date('2000-01-01') },
        { id: extraMembership(user.id), userId: user.id, ulbId: DEMO_ULB_ID, role: 'SUPER_ADMIN', createdAt: new Date('1999-01-01') },
      ] });
    }
    for (const user of outsiders) {
      await db.user.create({ data: { id: user.id, phone: user.phone, email: user.email, name: 'Non-primary fixture', memberships: { create: { ulbId: user.ulbId, role: 'ULB_ADMIN' } } } });
    }
    await db.property.create({ data: { id: demoId('property-0'), ulbId: DEMO_ULB_ID, societyId: society.societyId!, unitNo: '101', latitude: 18, longitude: 73, propertyCode: '100001', qrTokenHash: 'fixture-only', qrVersion: '1' } });
    await db.resident.create({ data: { id: demoId('resident-0'), ulbId: DEMO_ULB_ID, userId: resident.id, propertyId: demoId('property-0') } });
    await db.auditLog.create({ data: { ulbId: DEMO_ULB_ID, actorId: DEMO_USERS[4].id, action: DEMO_SEED_ACTION, entity: 'Ulb', entityId: DEMO_ULB_ID } });
    app = await buildApp({ db, logger: false, config: {
      DATABASE_URL: isolatedUrl, JWT_SECRET: secret, QR_SECRET: secret,
      NODE_ENV: 'development', DEMO_MODE: 'true', HOSTED_DEMO: 'true', STORAGE_DRIVER: 'local',
    } });
    await app.ready();
  });
  afterEach(async () => { if (app) await app.close(); });
  afterAll(async () => {
    if (db) await db.$disconnect();
    if (admin) {
      try { if (created) await admin.$executeRawUnsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`); }
      finally { await admin.$disconnect(); }
    }
  });

  it.each(DEMO_USERS)('allows $alias by phone and email, exposing only the expected membership', async user => {
    for (const identity of [user.phone, user.email]) {
      const result = await login(user, identity);
      expect(result.user).toMatchObject({ id: user.id, phone: user.phone, email: user.email });
      expect(result.memberships.map((m: { id: string }) => m.id)).toEqual([user.membershipId]);
      const me = await app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${result.accessToken}` } });
      expect(me.statusCode, me.body).toBe(200);
      expect(me.json().memberships.map((m: { id: string }) => m.id)).toEqual([user.membershipId]);
      expect(me.json().activeMembership.id).toBe(user.membershipId);
      const renewed = await refresh(result.refreshToken);
      expect(renewed.statusCode, renewed.body).toBe(200);
      expect(renewed.json().memberships.map((m: { id: string }) => m.id)).toEqual([user.membershipId]);
      for (const id of [foreignMembership(user.id), extraMembership(user.id)]) {
        expect((await app.inject({ url: '/api/v1/me', headers: headers(user.id, id) })).statusCode).toBe(403);
      }
      await db.otpChallenge.update({ where: { phone: user.phone }, data: { requestedAt: new Date(Date.now() - 61000) } });
    }
  });
  it.each(['+919123450000', 'unknown@demo.swachhtrack.in', ...outsiders.flatMap(user => [user.phone, ...(user.email ? [user.email] : [])])])('rejects %s without creating an OTP challenge or registering anyone', async identity => {
    const count = await db.user.count();
    const result = await requestOtp(identity);
    expect(result.statusCode, result.body).toBe(403);
    expect(result.json().error.code).toBe('HOSTED_DEMO_IDENTITY_FORBIDDEN');
    expect((await verifyOtp(identity)).statusCode).toBe(403);
    expect(await db.otpChallenge.count()).toBe(0);
    expect(await db.user.count()).toBe(count);
    expect(await db.refreshToken.count()).toBe(0);
  });
  it.each(outsiders)('rejects existing access and refresh tokens for non-primary $phone', async user => {
    const token = await existingRefresh(user.id);
    const result = await refresh(token);
    expect(result.statusCode, result.body).toBe(403);
    expect((await app.inject({ url: '/api/v1/me', headers: headers(user.id) })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/v1/societies/${society.societyId}/properties`, headers: headers(user.id) })).statusCode).toBe(403);
    expect(await db.refreshToken.count()).toBe(1);
    expect((await db.refreshToken.findFirstOrThrow()).usedAt).toBeNull();
  });

  const invalidStates = [
    'changed phone', 'changed email', 'inactive user', 'missing user', 'inactive membership', 'missing membership',
    'wrong membership ID', 'wrong role', 'wrong society', 'wrong contractor', 'wrong tenant', 'wrong tenant code',
    'missing marker', 'foreign marker', 'wrong marker entity', 'wrong marker entity ID',
  ];
  it.each(invalidStates)('fails closed across request, verify, refresh and access with %s', async state => {
    const token = await existingRefresh(resident.id);
    if (state === 'changed phone') await db.user.update({ where: { id: resident.id }, data: { phone: '+919123450001' } });
    if (state === 'changed email') await db.user.update({ where: { id: resident.id }, data: { email: 'changed@example.test' } });
    if (state === 'inactive user') await db.user.update({ where: { id: resident.id }, data: { status: 'INACTIVE' } });
    if (state === 'missing user') {
      await db.resident.deleteMany({ where: { userId: resident.id } });
      await db.membership.deleteMany({ where: { userId: resident.id } });
      await db.user.delete({ where: { id: resident.id } });
    }
    if (state === 'inactive membership') await db.membership.update({ where: { id: resident.membershipId }, data: { status: 'INACTIVE' } });
    if (state === 'missing membership') await db.membership.delete({ where: { id: resident.membershipId } });
    if (state === 'wrong membership ID') await db.membership.update({ where: { id: resident.membershipId }, data: { id: randomUUID() } });
    if (state === 'wrong role') await db.membership.update({ where: { id: resident.membershipId }, data: { role: 'ULB_ADMIN' } });
    if (state === 'wrong society') await db.membership.update({ where: { id: resident.membershipId }, data: { societyId: null } });
    if (state === 'wrong contractor') await db.membership.update({ where: { id: resident.membershipId }, data: { contractorId: demoId('contractor-0') } });
    if (state === 'wrong tenant') await db.membership.update({ where: { id: resident.membershipId }, data: { ulbId: foreignUlbId, societyId: null } });
    if (state === 'wrong tenant code') await db.ulb.update({ where: { id: DEMO_ULB_ID }, data: { code: 'CHANGED-DEMO' } });
    if (state.includes('marker')) {
      await db.$executeRaw`TRUNCATE "AuditLog"`;
      if (state !== 'missing marker') await db.auditLog.create({ data: {
        ulbId: state === 'foreign marker' ? foreignUlbId : DEMO_ULB_ID, actorId: DEMO_USERS[4].id, action: DEMO_SEED_ACTION,
        entity: state === 'wrong marker entity' ? 'User' : 'Ulb', entityId: state === 'wrong marker entity ID' ? foreignUlbId : DEMO_ULB_ID,
      } });
    }
    const request = await requestOtp(resident.phone);
    expect(request.statusCode, request.body).toBe(403);
    expect(await db.otpChallenge.count()).toBe(0);
    await db.otpChallenge.create({ data: { phone: resident.phone, codeHash: hmac(`${resident.phone}:123456`, secret), expiresAt: new Date(Date.now() + 300000) } });
    const verified = await verifyOtp(resident.phone);
    expect([401, 403], verified.body).toContain(verified.statusCode);
    expect((await db.otpChallenge.findUniqueOrThrow({ where: { phone: resident.phone } })).consumedAt).toBeNull();
    const renewed = await refresh(token);
    expect([401, 403], renewed.body).toContain(renewed.statusCode);
    expect(await db.refreshToken.count()).toBe(1);
    expect((await db.refreshToken.findFirstOrThrow()).usedAt).toBeNull();
    expect((await app.inject({ url: '/api/v1/me', headers: headers() })).statusCode).toBe(403);
  });
  it('rejects an impostor with the same fictional phone and email but a different ID', async () => {
    await db.resident.deleteMany({ where: { userId: resident.id } });
    await db.membership.deleteMany({ where: { userId: resident.id } });
    await db.user.delete({ where: { id: resident.id } });
    const impostor = await db.user.create({ data: { phone: resident.phone, email: resident.email, name: 'Impostor', memberships: { create: { ulbId: DEMO_ULB_ID, role: 'RESIDENT', societyId: resident.societyId } } } });
    expect((await requestOtp(resident.email)).statusCode).toBe(403);
    expect(await db.otpChallenge.count()).toBe(0);
    await db.otpChallenge.create({ data: { phone: resident.phone, codeHash: hmac(`${resident.phone}:123456`, secret), expiresAt: new Date(Date.now() + 300000) } });
    expect((await verifyOtp(resident.phone)).statusCode).toBe(403);
    expect((await refresh(await existingRefresh(impostor.id))).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/v1/me', headers: headers(impostor.id) })).statusCode).toBe(403);
  });
  it('blocks all profile patches, invitations and resident activation changes without writes', async () => {
    const original = await db.user.findUniqueOrThrow({ where: { id: resident.id } });
    for (const payload of [
      { name: 'Changed' }, { email: 'changed@example.test' }, { locale: 'hi' },
      { notificationPreferences: { inApp: true, email: true, whatsapp: true } },
    ]) {
      const result = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: headers(), payload });
      expect(result.statusCode, result.body).toBe(403);
      expect(result.json().error.code).toBe('HOSTED_DEMO_IDENTITY_LOCKED');
    }
    const invite = await app.inject({ method: 'POST', url: `/api/v1/societies/${society.societyId}/residents/invite`, headers: headers(society.id), payload: { phone: '+919123450002', name: 'New Resident', propertyId: demoId('property-0') } });
    expect(invite.statusCode, invite.body).toBe(403);
    expect(invite.json().error.code).toBe('HOSTED_DEMO_IDENTITY_LOCKED');
    for (const active of [false, true]) {
      const result = await app.inject({ method: 'PATCH', url: `/api/v1/societies/${society.societyId}/residents/${demoId('resident-0')}`, headers: headers(society.id), payload: { active } });
      expect(result.statusCode, result.body).toBe(403);
      expect(result.json().error.code).toBe('HOSTED_DEMO_IDENTITY_LOCKED');
    }
    expect(await db.user.findUniqueOrThrow({ where: { id: resident.id } })).toEqual(original);
    expect(await db.user.findUnique({ where: { phone: '+919123450002' } })).toBeNull();
    expect(await db.user.count()).toBe(8);
    expect(await db.membership.count()).toBe(18);
    expect(await db.resident.count()).toBe(1);
    expect((await db.resident.findFirstOrThrow()).active).toBe(true);
    expect(await db.auditLog.count()).toBe(1);
  });
  it('keeps synthetic schedule writes and resident reads usable with existing role checks', async () => {
    const payload = { stream: 'WET', pattern: { type: 'WEEKLY', weekdays: [1, 3, 5] }, windowStart: '07:00', windowEnd: '11:00', activeFrom: '2026-01-01' };
    const url = `/api/v1/societies/${society.societyId}/schedules`;
    const result = await app.inject({ method: 'POST', url, headers: headers(society.id), payload });
    expect(result.statusCode, result.body).toBe(201);
    expect(result.json().ulbId).toBe(DEMO_ULB_ID);
    expect((await app.inject({ method: 'PATCH', url: `${url}/${result.json().id}`, headers: headers(society.id), payload })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, headers: headers(), payload })).statusCode).toBe(403);
    const properties = await app.inject({ url: '/api/v1/resident/properties', headers: headers() });
    expect(properties.statusCode, properties.body).toBe(200);
    expect(properties.json().data.map((p: { id: string }) => p.id)).toEqual([demoId('property-0')]);
    expect((await app.inject({ url: '/api/v1/me', headers: headers(resident.id, 'not-a-uuid') })).statusCode).toBe(400);
  });
  it('preserves OTP cooldown, hourly limit and five-attempt lockout', async () => {
    expect((await requestOtp(resident.phone)).statusCode).toBe(202);
    const cooldown = await requestOtp(resident.email);
    expect(cooldown.statusCode).toBe(429);
    expect(cooldown.json().error.code).toBe('OTP_COOLDOWN');
    for (let i = 0; i < 5; i++) expect((await verifyOtp(resident.phone, '000000')).statusCode).toBe(401);
    expect((await verifyOtp(resident.phone)).statusCode).toBe(401);
    expect((await db.otpChallenge.findUniqueOrThrow({ where: { phone: resident.phone } })).attempts).toBe(5);
    await db.otpChallenge.update({ where: { phone: resident.phone }, data: { requestedAt: new Date(Date.now() - 61000), requestCount: 5 } });
    const hourly = await requestOtp(resident.phone);
    expect(hourly.statusCode).toBe(429);
    expect(hourly.json().error.code).toBe('OTP_PHONE_LIMIT');
  });
  it('keeps the request route rate limit even for forbidden identities', async () => {
    for (let i = 0; i < 10; i++) expect((await requestOtp('+919123450003')).statusCode).toBe(403);
    expect((await requestOtp('+919123450003')).statusCode).toBe(429);
    expect(await db.otpChallenge.count()).toBe(0);
  });
  it('preserves refresh rotation and family revocation on reuse', async () => {
    const first = await login();
    const renewed = await refresh(first.refreshToken);
    expect(renewed.statusCode, renewed.body).toBe(200);
    expect(renewed.json().refreshToken).not.toBe(first.refreshToken);
    expect((await refresh(first.refreshToken)).statusCode).toBe(401);
    expect((await refresh(renewed.json().refreshToken)).statusCode).toBe(401);
  });
  it('leaves normal development demo login, profile and invitations unchanged when explicitly off', async () => {
    const ordinary = await buildApp({ db, logger: false, config: { ...app.config, HOSTED_DEMO: 'false' } });
    try {
      const phone = outsiders[2].phone;
      expect((await ordinary.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } })).statusCode).toBe(202);
      expect((await ordinary.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone, code: '123456' } })).statusCode).toBe(200);
      expect((await ordinary.inject({ method: 'PATCH', url: '/api/v1/me', headers: headers(resident.id, resident.membershipId), payload: { name: 'Ordinary development update' } })).statusCode).toBe(200);
      const invited = await ordinary.inject({ method: 'POST', url: `/api/v1/societies/${society.societyId}/residents/invite`, headers: headers(society.id, society.membershipId), payload: { phone: '+919123450004', name: 'Ordinary development resident', propertyId: demoId('property-0') } });
      expect(invited.statusCode, invited.body).toBe(201);
      expect((await ordinary.inject({ method: 'PATCH', url: `/api/v1/societies/${society.societyId}/residents/${invited.json().resident.id}`, headers: headers(society.id, society.membershipId), payload: { active: false } })).statusCode).toBe(200);
    } finally { await ordinary.close(); }
  });
});
