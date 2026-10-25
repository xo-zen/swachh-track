import 'dotenv/config';
import { randomUUID, createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { signQrToken, hashQrToken } from '@swachh/domain';
import { buildApp } from '../src/app.js';
import * as analytics from '../src/analytics.js';
import { istDate, hash, hmac } from '../src/core.js';
import type { PickupInput } from '@swachh/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const secret = 'integration-test-only-secret-value-0123456789';
const config = { DATABASE_URL: databaseUrl ?? 'postgresql://unused', JWT_SECRET: secret, QR_SECRET: secret, QR_SECRET_VERSION: 'integration-1', NODE_ENV: 'development' as const, DEMO_MODE: 'true' as const, STORAGE_DRIVER: 'local' as const, LOCAL_STORAGE_PATH: `/tmp/bcode/swachh-api-test-${randomUUID()}`, API_PUBLIC_URL: 'http://localhost:4000', SWACHHATA_WEBHOOK_SECRET: secret };

suite('PostgreSQL API integration (isolated fictional tenant fixtures)', () => {
  let app: FastifyInstance; let db: PrismaClient;
  const ulbId = randomUUID(); const otherUlbId = randomUUID(); const societyId = randomUUID(); const otherSocietyId = randomUUID(); const wardId = randomUUID(); const contractorId = randomUUID(); const collectorId = randomUUID(); const routeId = randomUUID();
  const properties = Array.from({ length: 8 }, (_, index) => ({ id: randomUUID(), code: String(700000 + index), token: '', stopId: randomUUID() }));
  const identities = ['resident', 'society', 'collector', 'supervisor', 'ulb', 'attempts'] as const;
  type Identity = typeof identities[number];
  const users = Object.fromEntries(identities.map((name, index) => [name, { id: randomUUID(), membershipId: randomUUID(), phone: `+919${String(Date.now()).slice(-8)}${index}`, token: '', refreshToken: '' }])) as Record<Identity, { id: string; membershipId: string; phone: string; token: string; refreshToken: string }>;
  const headers = (identity: Identity) => ({ authorization: `Bearer ${users[identity].token}`, 'x-membership-id': users[identity].membershipId });
  let photoSequence = 0;
  async function login(identity: Identity) {
    const user = users[identity];
    const request = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone: user.phone } });
    expect(request.statusCode, request.body).toBe(202);
    const verify = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone: user.phone, code: '123456' } });
    expect(verify.statusCode, verify.body).toBe(200);
    const result = verify.json(); user.token = result.accessToken; user.refreshToken = result.refreshToken;
    return result;
  }
  async function photo(clientUuid: string, kind: 'DOORSTEP' | 'SCALE', color?: string) {
    const reserved = await app.inject({ method: 'POST', url: `/api/v1/collector/pickups/${clientUuid}/photos/presign`, headers: headers('collector'), payload: { kind, ...(kind === 'SCALE' ? { stream: 'WET' } : {}), captureSource: 'CAMERA', contentType: 'image/jpeg' } });
    expect(reserved.statusCode, reserved.body).toBe(200);
    const reservation = reserved.json();
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: color ?? `#${(++photoSequence * 37001).toString(16).padStart(6, '0')}` } }).withMetadata().jpeg().toBuffer();
    const put = await app.inject({ method: 'PUT', url: new URL(reservation.uploadUrl).pathname, headers: { 'content-type': 'image/jpeg' }, payload: bytes });
    expect(put.statusCode, put.body).toBe(204);
    const confirmed = await app.inject({ method: 'POST', url: `/api/v1/collector/pickups/${clientUuid}/photos/${reservation.photoId}/confirm`, headers: headers('collector'), payload: {} });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    return { ...reservation, ...confirmed.json() } as { photoId: string; uploadUrl: string; sha256: string };
  }
  async function event(propertyIndex: number, overrides: Partial<PickupInput> = {}): Promise<PickupInput> {
    const property = properties[propertyIndex]; const clientUuid = randomUUID();
    const door = await photo(clientUuid, 'DOORSTEP'); const scale = await photo(clientUuid, 'SCALE');
    return { client_uuid: clientUuid, propertyId: property.id, routeStopId: property.stopId, deviceId: 'integration-device-1', qrToken: property.token, capturedAt: new Date().toISOString(), latitude: 18.5204, longitude: 73.8567, accuracyM: 10, gpsCapturedAt: new Date().toISOString(), offline: false, streams: [{ stream: 'WET', kg: 1.5, segregation: 'GOOD', contamination: false, photoId: scale.photoId }], doorstepPhotoId: door.photoId, ...overrides };
  }
  async function batch(events: unknown[], key = randomUUID()) {
    return app.inject({ method: 'POST', url: '/api/v1/collector/pickups/batch', headers: { ...headers('collector'), 'idempotency-key': key }, payload: { events } });
  }
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    await db.$connect();
    app = await buildApp({ db, config, logger: false }); await app.ready();
    await db.ulb.createMany({ data: [{ id: ulbId, name: 'Integration Tenant A', state: 'Test', code: `TEST-${ulbId}`, flags: { billing_v1: true, compliance_v2: true } }, { id: otherUlbId, name: 'Integration Tenant B', state: 'Test', code: `TEST-${otherUlbId}` }] });
    const otherWardId = randomUUID();
    await db.ward.createMany({ data: [{ id: wardId, ulbId, name: 'Test Ward', code: 'A' }, { id: otherWardId, ulbId: otherUlbId, name: 'Other Ward', code: 'B' }] });
    await db.society.createMany({ data: [{ id: societyId, ulbId, wardId, name: 'Test Society', address: 'Fictional', latitude: 18.5204, longitude: 73.8567, floorAreaSqm: 20000, settings: { flatFeePaise: 1000, pickupFeePaise: 200, handlingFeePaisePerKg: 100, missedDeductionPaise: 50 } }, { id: otherSocietyId, ulbId: otherUlbId, wardId: otherWardId, name: 'Other Society', address: 'Fictional', latitude: 18.5204, longitude: 73.8567 }] });
    await db.contractor.create({ data: { id: contractorId, ulbId, name: 'Test Contractor', contractNo: 'C1', validFrom: new Date('2020-01-01'), validTo: new Date('2099-01-01') } });
    const roles = { resident: 'RESIDENT', society: 'SOCIETY_ADMIN', collector: 'COLLECTOR', supervisor: 'SUPERVISOR', ulb: 'ULB_ADMIN', attempts: 'RESIDENT' } as const;
    for (const identity of identities) {
      const user = users[identity];
      await db.user.create({ data: { id: user.id, phone: user.phone, name: `Integration ${identity}`, memberships: { create: { id: user.membershipId, ulbId, role: roles[identity], societyId: ['resident', 'society', 'attempts'].includes(identity) ? societyId : null, contractorId: ['collector', 'supervisor'].includes(identity) ? contractorId : null } } } });
    }
    await db.collector.create({ data: { id: collectorId, ulbId, contractorId, userId: users.collector.id, employeeCode: 'C1' } });
    for (const property of properties) {
      property.token = signQrToken(property.id, { secret, version: config.QR_SECRET_VERSION });
      await db.property.create({ data: { id: property.id, ulbId, societyId, unitNo: property.code, block: 'TEST', latitude: 18.5204, longitude: 73.8567, propertyCode: property.code, qrTokenHash: hashQrToken(property.token), qrVersion: config.QR_SECRET_VERSION } });
    }
    await db.resident.create({ data: { ulbId, userId: users.resident.id, propertyId: properties[0].id } });
    await db.route.create({ data: { id: routeId, ulbId, contractorId, collectorId, wardId, name: 'Integration route', date: new Date(istDate()), stops: { create: properties.map((property, index) => ({ id: property.stopId, ulbId, propertyId: property.id, sequence: index + 1, windowStart: new Date(`${istDate()}T00:00:00+05:30`), windowEnd: new Date(`${istDate()}T23:59:59+05:30`), streams: ['WET', 'DRY'] })) } } });
    for (const identity of identities.filter(i => i !== 'attempts')) await login(identity);
    const bound = await app.inject({ method: 'POST', url: '/api/v1/collector/devices', headers: headers('collector'), payload: { deviceId: 'integration-device-1', platform: 'ANDROID', appVersion: '1' } });
    expect(bound.statusCode).toBe(200);
  });
  afterAll(async () => { if (app) await app.close(); if (db) await db.$disconnect(); });

  it('uses server-side memberships, hides other tenant resources and rejects extra fields', async () => {
    const denied = await app.inject({ url: `/api/v1/societies/${otherSocietyId}/properties`, headers: headers('society') });
    expect(denied.statusCode).toBe(404);
    const roleDenied = await app.inject({ url: `/api/v1/societies/${societyId}/properties`, headers: headers('resident') }); expect(roleDenied.statusCode).toBe(403);
    const membershipDenied = await app.inject({ url: '/api/v1/me', headers: { ...headers('resident'), 'x-membership-id': users.ulb.membershipId } }); expect(membershipDenied.statusCode).toBe(403);
    const extra = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: headers('resident'), payload: { role: 'ULB_ADMIN' } }); expect(extra.statusCode).toBe(422);
    const me = await app.inject({ url: '/api/v1/me', headers: headers('resident') }); expect(me.json().activeMembership.ulbId).toBe(ulbId);
  });
  it('enforces tenant reference consistency even below HTTP handlers', async () => {
    await expect(db.property.create({ data: { ulbId, societyId: otherSocietyId, unitNo: 'forbidden', latitude: 0, longitude: 0, propertyCode: '899999', qrTokenHash: hash('test'), qrVersion: '1' } })).rejects.toThrow();
    expect(await db.property.count({ where: { ulbId, unitNo: 'forbidden' } })).toBe(0);
  });
  it('returns auditable empty compliance history without claiming measured coverage', async () => {
    const summary = await app.inject({ url: `/api/v1/societies/${societyId}/compliance/summary`, headers: headers('society') });
    expect(summary.statusCode, summary.body).toBe(200);
    const coverage = summary.json().certificateCoverage;
    expect(coverage.requiredKg).toBe(0);
    expect(coverage.coveragePct).toBeNull();
    expect(coverage.obligationSourceIds).toHaveLength(1);
    expect(coverage.obligationSourceIds[0]).toContain(`query:verified-pickups:${ulbId}:${societyId}:`);
    const annual = await app.inject({ method: 'POST', url: `/api/v1/societies/${societyId}/compliance/annual-return`, headers: { ...headers('society'), 'idempotency-key': randomUUID() }, payload: { financialYearStart: 2020 } });
    expect(annual.statusCode, annual.body).toBe(201);
    expect(annual.json().payload.certificateCoverage.coveragePct).toBeNull();
  });
  it('stores hashed OTP, enforces cooldown and persists all five failed attempts', async () => {
    const phone = users.attempts.phone;
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } })).statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } })).statusCode).toBe(429);
    const challenge = await db.otpChallenge.findUniqueOrThrow({ where: { phone } }); expect(challenge.codeHash).not.toContain('123456');
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone, code: '000000' } })).statusCode).toBe(401);
    expect((await db.otpChallenge.findUniqueOrThrow({ where: { phone } })).attempts).toBe(5);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone, code: '123456' } })).statusCode).toBe(401);
  });
  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const old = users.resident.refreshToken;
    const rotated = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: old } }); expect(rotated.statusCode).toBe(200);
    const next = rotated.json().refreshToken; expect(next).not.toBe(old);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: old } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: next } })).statusCode).toBe(401);
  });
  it('limits a collector to two bound devices', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/collector/devices', headers: headers('collector'), payload: { deviceId: 'integration-device-2', platform: 'ANDROID', appVersion: '1' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/collector/devices', headers: headers('collector'), payload: { deviceId: 'integration-device-3', platform: 'ANDROID', appVersion: '1' } })).statusCode).toBe(409);
    const today = await app.inject({ url: '/api/v1/collector/today', headers: headers('collector') });
    expect(today.json().routes[0].stops[0].property.qrToken).toBe(properties[0].token);
  });
  it('requires real bytes and stores an EXIF-free normalized hash', async () => {
    const id = randomUUID();
    const empty = await app.inject({ method: 'POST', url: `/api/v1/collector/pickups/${id}/photos/presign`, headers: headers('collector'), payload: { kind: 'DOORSTEP', captureSource: 'CAMERA', contentType: 'image/jpeg' } });
    const confirmation = await app.inject({ method: 'POST', url: `/api/v1/collector/pickups/${id}/photos/${empty.json().photoId}/confirm`, headers: headers('collector'), payload: {} });
    expect(confirmation.statusCode).toBe(422); expect(confirmation.json().error.code).toBe('UPLOAD_MISSING');
    const result = await photo(id, 'DOORSTEP'); const row = await db.photo.findUniqueOrThrow({ where: { id: result.photoId } });
    const bytes = await app.storage.read(row.storageKey); expect(hash(bytes)).toBe(result.sha256); expect((await sharp(bytes).metadata()).exif).toBeUndefined();
    const overwrite = await app.inject({ method: 'PUT', url: new URL(result.uploadUrl).pathname, headers: { 'content-type': 'image/jpeg' }, payload: bytes }); expect(overwrite.statusCode).toBe(403);
  });
  let acceptedId = '';
  it('syncs an offline batch exactly once and returns the same response on replay', async () => {
    const input = await event(0, { offline: true }); const key = randomUUID();
    const first = await batch([input], key); expect(first.statusCode, first.body).toBe(200);
    acceptedId = first.json().results[0].id; expect(first.json().results[0].status).toBe('NEEDS_REVIEW');
    const second = await batch([input], key); expect(second.statusCode).toBe(first.statusCode); expect(second.json()).toEqual(first.json());
    expect(await db.pickupEvent.count({ where: { ulbId, clientUuid: input.client_uuid } })).toBe(1);
    expect(await db.notification.count({ where: { ulbId, template: 'PICKUP_COMPLETED', dedupeKey: { contains: acceptedId } } })).toBe(1);
    const different = await batch([{ ...input, accuracyM: 11 }], key); expect(different.statusCode).toBe(409); expect(different.json().error.details.original).toEqual(first.json());
    const duplicateUuid = await batch([input]); expect(duplicateUuid.statusCode).toBe(409);
    const approved = await app.inject({ method: 'POST', url: `/api/v1/supervisor/pickups/${acceptedId}/review`, headers: headers('supervisor'), payload: { decision: 'APPROVE', reason: 'Reviewed actual fixture evidence and GPS.' } });
    expect(approved.statusCode, approved.body).toBe(200); expect(approved.json().status).toBe('VERIFIED');
  });
  it('persists missing-weight rejections with HTTP 422 and replays them', async () => {
    const input = await event(1); const key = randomUUID();
    const missing = { ...input, streams: input.streams.map(({ kg: _kg, ...rest }) => rest) };
    const response = await batch([missing], key); expect(response.statusCode).toBe(422); expect(response.json().results[0].status).toBe('REJECTED');
    expect(await db.rejectedSubmission.count({ where: { ulbId, clientUuid: input.client_uuid } })).toBe(1);
    expect((await batch([missing], key)).json()).toEqual(response.json());
  });
  it('rejects out-of-geofence and tampered QR events durably', async () => {
    const far = await event(2, { latitude: 19.52 }); const farResult = await batch([far]); expect(farResult.statusCode).toBe(422);
    expect(farResult.json().results[0].verificationReasons.some((r: { code: string }) => r.code === 'GEOFENCE_FAILED')).toBe(true);
    const wrong = await event(3, { qrToken: 'tampered' }); const wrongResult = await batch([wrong]); expect(wrongResult.statusCode).toBe(422);
    expect(wrongResult.json().results[0].verificationReasons.some((r: { code: string }) => r.code === 'INVALID_QR')).toBe(true);
    expect(await db.pickupEvent.count({ where: { ulbId, clientUuid: { in: [far.client_uuid, wrong.client_uuid] }, status: 'REJECTED' } })).toBe(2);
  });
  it('rejects duplicate normalized proof images and unconfirmed evidence', async () => {
    const input = await event(4); const duplicate = await photo(input.client_uuid, 'DOORSTEP', '#123456'); const same = await photo(input.client_uuid, 'SCALE', '#123456');
    const response = await batch([{ ...input, doorstepPhotoId: duplicate.photoId, streams: [{ ...input.streams[0], photoId: same.photoId }] }]); expect(response.statusCode).toBe(422);
    expect(response.json().results[0].verificationReasons.some((r: { code: string }) => r.code === 'DUPLICATE_PHOTO')).toBe(true);
    const unconfirmed = await event(5, { doorstepPhotoId: randomUUID() }); expect((await batch([unconfirmed])).statusCode).toBe(422);
  });
  it('restricts resident evidence and allows only one verified-event rating', async () => {
    const history = await app.inject({ url: '/api/v1/resident/pickups', headers: headers('resident') }); expect(history.json().data.every((r: { propertyId: string }) => r.propertyId === properties[0].id)).toBe(true);
    const payload = { punctuality: 4, quality: 3, guidance: 4 };
    expect((await app.inject({ method: 'POST', url: `/api/v1/resident/pickups/${acceptedId}/ratings`, headers: headers('resident'), payload })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/v1/resident/pickups/${acceptedId}/ratings`, headers: headers('resident'), payload })).statusCode).toBe(409);
    const other = await db.pickupEvent.findFirstOrThrow({ where: { ulbId, propertyId: properties[2].id } });
    expect((await app.inject({ url: `/api/v1/resident/pickups/${other.id}`, headers: headers('resident') })).statusCode).toBe(404);
  });
  it('imports validated CSV atomically and emits a real QR sheet PDF', async () => {
    const csv = ['unitNo,block,floor,latitude,longitude', ...Array.from({ length: 20 }, (_, i) => `${i + 1},IMPORTED,1,18.5204,73.8567`)].join('\n');
    const response = await app.inject({ method: 'POST', url: `/api/v1/societies/${societyId}/properties/import`, headers: headers('society'), payload: { csv } }); expect(response.statusCode, response.body).toBe(201); expect(response.json().imported).toBe(20);
    const invalid = await app.inject({ method: 'POST', url: `/api/v1/societies/${societyId}/properties/import`, headers: headers('society'), payload: { csv: 'unitNo,latitude,longitude\nbad,999,10' } }); expect(invalid.statusCode).toBe(422);
    const pdf = await app.inject({ url: `/api/v1/societies/${societyId}/properties/qr-sheet.pdf`, headers: headers('society') }); expect(pdf.statusCode, pdf.body.slice(0, 200)).toBe(200); expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const audit = await db.auditLog.findFirstOrThrow({ where: { ulbId, action: 'PROPERTIES_IMPORTED' } });
    await expect(db.auditLog.update({ where: { id: audit.id, ulbId }, data: { action: 'REWRITTEN' } })).rejects.toThrow();
  });

  async function webPhoto(identity: Identity, purpose: 'COMPLAINT' | 'RESOLUTION' | 'DOCUMENT') {
    const bytes = await sharp({ create: { width: 80, height: 80, channels: 3, background: `#${(++photoSequence * 37001).toString(16).padStart(6, '0')}` } }).jpeg().toBuffer();
    const reservation = await app.inject({ method: 'POST', url: '/api/v1/files/presign', headers: headers(identity), payload: { filename: 'fixture.jpg', contentType: 'image/jpeg', size: bytes.length, purpose } }); expect(reservation.statusCode).toBe(200);
    const reserved = reservation.json(); expect((await app.inject({ method: 'PUT', url: new URL(reserved.uploadUrl).pathname, headers: { 'content-type': 'image/jpeg' }, payload: bytes })).statusCode).toBe(204);
    const confirm = await app.inject({ method: 'POST', url: `/api/v1/files/${reserved.fileId}/confirm`, headers: headers(identity), payload: {} }); expect(confirm.statusCode, confirm.body).toBe(200); return confirm.json() as { fileId: string; storageKey: string };
  }
  it('requires resolution image bytes, maintains SLA workflow and permits one reopen', async () => {
    const category = await db.complaintCategory.create({ data: { ulbId, name: 'Test missed vehicle', slaHours: 12 } });
    const image = await webPhoto('resident', 'COMPLAINT');
    const response = await app.inject({ method: 'POST', url: '/api/v1/resident/complaints', headers: headers('resident'), payload: { propertyId: properties[0].id, pickupEventId: acceptedId, categoryId: category.id, description: 'Integration complaint with evidence', photoId: image.fileId } }); expect(response.statusCode, response.body).toBe(201);
    const complaint = response.json(); expect(Date.parse(complaint.slaDueAt) - Date.parse(complaint.createdAt)).toBe(12 * 3600000);
    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/api/v1/complaints/${complaint.id}`, headers: headers('society'), payload });
    expect((await patch({ status: 'ACKNOWLEDGED' })).statusCode).toBe(200);
    expect((await patch({ status: 'IN_PROGRESS' })).statusCode).toBe(200);
    expect((await patch({ status: 'RESOLVED', note: 'No picture' })).statusCode).toBe(422);
    expect((await patch({ status: 'RESOLVED', note: 'Unconfirmed picture', photoId: randomUUID() })).statusCode).toBe(422);
    const proof = await webPhoto('society', 'RESOLUTION'); expect((await patch({ status: 'RESOLVED', note: 'Collection completed', photoId: proof.fileId })).statusCode).toBe(200);
    const reopen = () => app.inject({ method: 'POST', url: `/api/v1/resident/complaints/${complaint.id}/reopen`, headers: headers('resident'), payload: { note: 'Issue persists' } });
    expect((await reopen()).json().status).toBe('REOPENED');
    expect((await patch({ status: 'RESOLVED', note: 'Second resolution', photoId: proof.fileId })).statusCode).toBe(200);
    const second = await reopen(); expect(second.json().escalation).toBe('ULB_ADMIN'); expect(second.json().reopenedCount).toBe(1);
  });
  it('generates audited paise invoice lines, PDF, issue and manual settlement', async () => {
    const historicRoute = await db.route.create({ data: { ulbId, contractorId, collectorId, wardId, name: 'Billing fixture', date: new Date('2024-01-10') } });
    const [verified, missed] = await Promise.all([0, 1].map(i => db.routeStop.create({ data: { ulbId, routeId: historicRoute.id, propertyId: properties[i].id, sequence: i + 1, windowStart: new Date('2024-01-10T02:00:00Z'), windowEnd: new Date('2024-01-10T04:00:00Z'), streams: ['WET'] } })));
    await db.pickupEvent.create({ data: { ulbId, societyId, propertyId: properties[0].id, collectorId, routeStopId: verified.id, clientUuid: randomUUID(), scheduledFor: verified.windowStart, capturedAt: new Date('2024-01-10T03:00:00Z'), latitude: 18.5204, longitude: 73.8567, accuracyM: 10, gpsCapturedAt: new Date('2024-01-10T03:00:00Z'), deviceId: 'integration-device-1', qrTokenHash: hash(properties[0].token), offline: false, status: 'VERIFIED', verificationScore: 100, verificationReasons: [], batchId: randomUUID(), streams: { create: { ulbId, stream: 'WET', kg: 1.5, segregation: 'GOOD', contamination: false } } } });
    const payload = { periodStart: '2024-01-01', periodEnd: '2024-01-31', dueDate: '2024-02-15' }; const key = randomUUID();
    const generate = () => app.inject({ method: 'POST', url: `/api/v1/societies/${societyId}/invoices/generate`, headers: { ...headers('society'), 'idempotency-key': key }, payload });
    const response = await generate(); expect(response.statusCode, response.body).toBe(201); const invoice = response.json();
    expect(invoice.totalPaise).toBe(28 * 1000 + 200 + 150 - 50);
    expect(invoice.lines.find((l: { type: string }) => l.type === 'MISSED_DEDUCTION').evidence.stopIds).toEqual([missed.id]);
    expect((await generate()).json()).toEqual(invoice);
    const pdf = await app.inject({ url: `/api/v1/societies/${societyId}/invoices/${invoice.id}.pdf`, headers: headers('society') }); expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await app.inject({ method: 'POST', url: `/api/v1/societies/${societyId}/invoices/${invoice.id}/issue`, headers: headers('society'), payload: {} })).statusCode).toBe(200);
    const paid = await app.inject({ method: 'POST', url: `/api/v1/societies/${societyId}/invoices/${invoice.id}/mark-paid`, headers: headers('society'), payload: { amountPaise: invoice.totalPaise, paidAt: new Date().toISOString(), reference: randomUUID() } }); expect(paid.json().status).toBe('PAID');
  });
  it('records only externally evidenced certificates via ULB and generates draft JSON/PDF', async () => {
    const upload = await webPhoto('society', 'DOCUMENT');
    const document = await app.inject({ method: 'POST', url: `/api/v1/societies/${societyId}/compliance/documents`, headers: headers('society'), payload: { type: 'EXTERNAL_CERTIFICATE', number: 'TEST-001', issuedBy: 'Test ULB', issuedAt: '2024-01-01', storageKey: upload.fileId } }); expect(document.statusCode, document.body).toBe(201);
    const body = { certificateNo: `TEST-${randomUUID()}`, stream: 'WET', kg: 100, issuedAt: '2024-01-01', documentId: document.json().id };
    expect((await app.inject({ method: 'POST', url: `/api/v1/societies/${societyId}/compliance/certificates`, headers: headers('society'), payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1/ulb/${ulbId}/certificates`, headers: headers('ulb'), payload: { societyId, ...body } })).statusCode).toBe(201);
    const key = randomUUID(); const generate = () => app.inject({ method: 'POST', url: `/api/v1/societies/${societyId}/compliance/annual-return`, headers: { ...headers('society'), 'idempotency-key': key }, payload: { financialYearStart: 2023 } });
    const annual = await generate(); expect(annual.statusCode, annual.body).toBe(201); expect(annual.json().payload.label).toBe('DRAFT - for ULB/CA review'); expect((await generate()).json()).toEqual(annual.json());
    const pdf = await app.inject({ url: `/api/v1/societies/${societyId}/compliance/annual-return/${annual.json().id}.pdf`, headers: headers('society') }); expect(pdf.statusCode, pdf.body.slice(0, 200)).toBe(200); expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const pack = await app.inject({ url: `/api/v1/societies/${societyId}/compliance/inspection-pack.pdf`, headers: headers('society') }); expect(pack.statusCode).toBe(200);
  });
  it('verifies webhook signatures, persists NOT_CONFIGURED and exports scoped reports', async () => {
    const body = { ulbId, eventId: randomUUID(), status: 'OPEN' }; const raw = JSON.stringify(body);
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    const bad = await app.inject({ method: 'POST', url: '/api/v1/webhooks/swachhata', payload: body, headers: { 'x-signature': 'invalid' } }); expect(bad.statusCode).toBe(401);
    const response = await app.inject({ method: 'POST', url: '/api/v1/webhooks/swachhata', payload: raw, headers: { 'content-type': 'application/json', 'x-signature': signature } }); expect(response.statusCode).toBe(501);
    expect(await db.outboundMessage.count({ where: { ulbId, entityId: body.eventId, status: 'NOT_CONFIGURED' } })).toBe(1);
    for (const format of ['csv', 'xlsx', 'pdf']) {
      const result = await app.inject({ url: `/api/v1/ulb/${ulbId}/exports/pickups.${format}`, headers: headers('ulb') }); expect(result.statusCode, result.body.slice(0, 200)).toBe(200); expect(result.rawPayload.length).toBeGreaterThan(20);
    }
    const openapi = await app.inject({ url: '/docs/json' }); expect(openapi.statusCode).toBe(200); expect(openapi.json().paths['/api/v1/auth/otp/request']).toBeDefined();
  });

  describe('web read endpoint isolation', () => {
    const outside: { ulbId: string; societyId: string; wardId: string; propertyId: string; pickupId: string; annualId: string; invoiceId: string }[] = [];
    const annualIds: string[] = [];
    const annualPeriod = 'from=2025-02-01T00:00:00Z&to=2025-02-28T23:59:59Z';
    beforeAll(async () => {
      const siblingWard = await db.ward.create({ data: { ulbId, name: 'Sibling Ward', code: 'C' } });
      const sibling = await db.society.create({ data: { ulbId, wardId: siblingWard.id, name: 'Sibling Society', address: 'Fictional', latitude: 18.5204, longitude: 73.8567 } });
      const foreign = await db.society.findUniqueOrThrow({ where: { id: otherSocietyId } });
      for (const society of [sibling, foreign]) {
        const contractor = society.ulbId === ulbId ? { id: contractorId } : await db.contractor.create({ data: { ulbId: society.ulbId, name: 'Foreign Contractor', contractNo: 'C1', validFrom: new Date('2020-01-01'), validTo: new Date('2099-01-01') } });
        const collector = society.ulbId === ulbId ? { id: collectorId } : await db.collector.create({ data: { ulbId: society.ulbId, contractorId: contractor.id, userId: users.collector.id, employeeCode: 'C1' } });
        const property = await db.property.create({ data: { ulbId: society.ulbId, societyId: society.id, unitNo: 'Outside scope', latitude: 18.5204, longitude: 73.8567, propertyCode: '799998', qrTokenHash: hash(randomUUID()), qrVersion: '1' } });
        const route = await db.route.create({ data: { ulbId: society.ulbId, contractorId: contractor.id, collectorId: collector.id, wardId: society.wardId, name: 'Scope fixture', date: new Date('2024-01-10') } });
        const stop = await db.routeStop.create({ data: { ulbId: society.ulbId, routeId: route.id, propertyId: property.id, sequence: 1, windowStart: new Date('2024-01-10T02:00:00Z'), windowEnd: new Date('2024-01-10T04:00:00Z'), streams: ['WET'] } });
        const pickup = await db.pickupEvent.create({ data: { ulbId: society.ulbId, societyId: society.id, propertyId: property.id, collectorId: collector.id, routeStopId: stop.id, clientUuid: randomUUID(), scheduledFor: stop.windowStart, capturedAt: new Date('2024-01-10T03:00:00Z'), latitude: 18.5204, longitude: 73.8567, accuracyM: 10, gpsCapturedAt: new Date('2024-01-10T03:00:00Z'), deviceId: 'scope-fixture', qrTokenHash: property.qrTokenHash, offline: false, status: 'VERIFIED', verificationScore: 100, verificationReasons: [], batchId: randomUUID(), streams: { create: { ulbId: society.ulbId, stream: 'WET', kg: 1, segregation: 'GOOD', contamination: false } } } });
        const annual = await db.annualReturn.create({ data: { ulbId: society.ulbId, societyId: society.id, financialYear: 2024, generatedAt: new Date('2025-02-01'), payload: { private: 'outside scope' } } });
        const invoice = await db.invoice.create({ data: { ulbId: society.ulbId, societyId: society.id, periodStart: new Date('2024-01-01'), periodEnd: new Date('2024-01-31'), dueAt: new Date('2024-02-15'), subtotalPaise: 1000, deductionsPaise: 0, totalPaise: 1000 } });
        outside.push({ ulbId: society.ulbId, societyId: society.id, wardId: society.wardId, propertyId: property.id, pickupId: pickup.id, annualId: annual.id, invoiceId: invoice.id });
      }
      for (const financialYear of [2024, 2025]) {
        const annual = await db.annualReturn.create({ data: { ulbId, societyId, financialYear, generatedAt: new Date('2025-02-01'), payload: { private: 'snapshot is detail-only' } } });
        annualIds.push(annual.id);
      }
    });

    it.each(['society', 'ulb'] as const)('paginates %s pickup history without query or cursor scope escapes', async identity => {
      const path = identity === 'society' ? `/api/v1/societies/${societyId}/pickups` : `/api/v1/ulb/${ulbId}/pickups`;
      const first = await app.inject({ url: `${path}?limit=1&societyId=${societyId}&wardId=${wardId}`, headers: headers(identity) });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().data).toHaveLength(1);
      expect(first.json().nextCursor).toBe(first.json().data[0].id);
      const second = await app.inject({ url: `${path}?limit=1&societyId=${societyId}&cursor=${first.json().nextCursor}`, headers: headers(identity) });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().data[0].id > first.json().data[0].id).toBe(true);
      expect(second.json().data[0].societyId).toBe(societyId);
      const filtered = await app.inject({ url: `${path}?societyId=${societyId}&status=VERIFIED&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z`, headers: headers(identity) });
      expect(filtered.statusCode, filtered.body).toBe(200);
      expect(filtered.json().data).toHaveLength(1);
      expect(filtered.json().data[0]).toMatchObject({ ulbId, societyId, status: 'VERIFIED', streams: [expect.objectContaining({ stream: 'WET' })] });
      expect(filtered.json().nextCursor).toBeNull();
      for (const fixture of outside) {
        const cursor = await app.inject({ url: `${path}?societyId=${societyId}&cursor=${fixture.pickupId}`, headers: headers(identity) });
        expect(cursor.statusCode, cursor.body).toBe(404);
        if (identity === 'society' || fixture.ulbId !== ulbId) {
          const result = await app.inject({ url: `${path}?societyId=${fixture.societyId}&wardId=${fixture.wardId}`, headers: headers(identity) });
          expect(result.statusCode, result.body).toBe(200);
          expect(result.json()).toEqual({ data: [], nextCursor: null });
        }
      }
      expect((await app.inject({ url: `${path}?status=INVALID`, headers: headers(identity) })).statusCode).toBe(422);
      expect((await app.inject({ url: `${path}?limit=101`, headers: headers(identity) })).statusCode).toBe(422);
      expect((await app.inject({ url: `${path}?from=2025-01-01T00:00:00Z&to=2024-01-01T00:00:00Z`, headers: headers(identity) })).statusCode).toBe(422);
    });

    it('allows ULB-wide history but confines society paths and ward filters', async () => {
      const all = await app.inject({ url: `/api/v1/ulb/${ulbId}/pickups`, headers: headers('ulb') });
      expect(all.statusCode, all.body).toBe(200);
      expect(all.json().data.map((row: { id: string }) => row.id)).toContain(outside[0].pickupId);
      expect(all.json().data.every((row: { ulbId: string }) => row.ulbId === ulbId)).toBe(true);
      const ward = await app.inject({ url: `/api/v1/ulb/${ulbId}/pickups?wardId=${outside[0].wardId}`, headers: headers('ulb') });
      expect(ward.json().data.map((row: { id: string }) => row.id)).toEqual([outside[0].pickupId]);
      for (const fixture of outside) expect((await app.inject({ url: `/api/v1/societies/${fixture.societyId}/pickups`, headers: headers('society') })).statusCode).toBe(404);
      expect((await app.inject({ url: `/api/v1/ulb/${otherUlbId}/pickups`, headers: headers('ulb') })).statusCode).toBe(404);
    });

    it('reuses filtered ULB totals only for the identical contractor scope', async () => {
      const emptyContractor = await db.contractor.create({ data: { ulbId, name: 'Empty reporting contractor', contractNo: 'C2', validFrom: new Date('2020-01-01'), validTo: new Date('2099-01-01') } });
      const path = `/api/v1/ulb/${ulbId}/dashboard?societyId=${societyId}&wardId=${wardId}&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z`;
      const dashboardCalls = vi.spyOn(analytics, 'dashboard');
      try {
        const unfiltered = await app.inject({ url: path, headers: headers('ulb') });
        expect(unfiltered.statusCode, unfiltered.body).toBe(200);
        expect(dashboardCalls).toHaveBeenCalledTimes(4); // Totals, ward, and both contractor scopes.
        expect(unfiltered.json().metrics.scheduledStops.value).toBe(2);
        expect(unfiltered.json().contractors.find((row: { id: string }) => row.id === emptyContractor.id).metrics.scheduledStops.value).toBe(0);
        for (const id of [contractorId, emptyContractor.id]) {
          dashboardCalls.mockClear();
          const filtered = await app.inject({ url: `${path}&contractorId=${id}`, headers: headers('ulb') });
          expect(filtered.statusCode, filtered.body).toBe(200);
          expect(dashboardCalls).toHaveBeenCalledTimes(2); // Totals and ward; identical contractor totals are reused.
          const body = filtered.json();
          expect(body.contractors).toHaveLength(1);
          expect(body.metrics.scheduledStops.value).toBe(id === contractorId ? 2 : 0);
          expect(body.contractors[0]).toMatchObject({ id, metrics: body.metrics, trend: body.trend, period: body.period, provenance: body.provenance, ...body.metrics });
        }
        const unknown = await app.inject({ url: `${path}&contractorId=${randomUUID()}`, headers: headers('ulb') });
        expect(unknown.statusCode, unknown.body).toBe(200);
        expect(unknown.json().contractors).toEqual([]);
        expect(unknown.json().metrics.scheduledStops.value).toBe(0);
      } finally {
        dashboardCalls.mockRestore();
      }
    });

    it('returns private pickup detail with functional, signed, expiring photo URLs', async () => {
      for (const [identity, path] of [['society', '/pickups'], ['supervisor', '/supervisor/pickups'], ['ulb', '/pickups']] as const) {
        const response = await app.inject({ url: `/api/v1${path}/${acceptedId}`, headers: headers(identity) });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers['cache-control']).toBe('private, no-store');
        const detail = response.json();
        expect(detail.property.id).toBe(properties[0].id);
        expect(detail.property).not.toHaveProperty('qrTokenHash');
        expect(detail.property).not.toHaveProperty('qrToken');
        expect(detail.streams).toHaveLength(1);
        expect(detail.photos).toHaveLength(2);
        for (const proof of detail.photos) {
          expect(proof.expiresIn).toBe(300);
          expect(proof).not.toHaveProperty('storageKey');
          const url = new URL(proof.url);
          const token = url.pathname.split('/').at(-1)!;
          const capability = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
          expect(capability.action).toBe('GET');
          expect(capability.expires - Date.now()).toBeGreaterThan(250000);
          expect(capability.expires - Date.now()).toBeLessThanOrEqual(300000);
          const image = await app.inject({ url: url.pathname });
          expect(image.statusCode, image.body.slice(0, 100)).toBe(200);
          expect(hash(image.rawPayload)).toBe(proof.sha256);
          expect((await app.inject({ url: `${url.pathname}invalid` })).statusCode).toBe(403);
          const expired = Buffer.from(JSON.stringify({ ...capability, expires: Date.now() - 1 })).toString('base64url');
          expect((await app.inject({ url: `/api/v1/uploads/${expired}.${hmac(expired, secret)}` })).statusCode).toBe(403);
        }
      }
      for (const fixture of outside) expect((await app.inject({ url: `/api/v1/pickups/${fixture.pickupId}`, headers: headers('society') })).statusCode).toBe(404);
      expect((await app.inject({ url: `/api/v1/pickups/${outside[1].pickupId}`, headers: headers('ulb') })).statusCode).toBe(404);
    });

    it('lists draft metadata with financial-year, date and scoped cursor filters', async () => {
      const path = `/api/v1/societies/${societyId}/compliance/annual-returns`;
      const first = await app.inject({ url: `${path}?${annualPeriod}&limit=1`, headers: headers('society') });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().data).toHaveLength(1);
      expect(first.json().data[0]).not.toHaveProperty('payload');
      const second = await app.inject({ url: `${path}?${annualPeriod}&limit=1&cursor=${first.json().nextCursor}`, headers: headers('society') });
      expect(second.statusCode, second.body).toBe(200);
      expect([first.json().data[0].id, second.json().data[0].id]).toEqual([...annualIds].sort());
      expect(second.json().nextCursor).toBeNull();
      const year = await app.inject({ url: `${path}?financialYearStart=2024&status=DRAFT&wardId=${wardId}`, headers: headers('society') });
      expect(year.json().data.map((row: { id: string }) => row.id)).toEqual([annualIds[0]]);
      expect((await app.inject({ url: `${path}?financialYearStart=2024&cursor=${annualIds[1]}`, headers: headers('society') })).statusCode).toBe(404);
      expect((await app.inject({ url: `${path}?status=FILED`, headers: headers('society') })).statusCode).toBe(422);
      for (const fixture of outside) {
        expect((await app.inject({ url: `${path}?cursor=${fixture.annualId}`, headers: headers('society') })).statusCode).toBe(404);
        expect((await app.inject({ url: `${path}?societyId=${fixture.societyId}&wardId=${fixture.wardId}`, headers: headers('society') })).json()).toEqual({ data: [], nextCursor: null });
        expect((await app.inject({ url: `/api/v1/societies/${fixture.societyId}/compliance/annual-returns`, headers: headers('society') })).statusCode).toBe(404);
      }
    });

    it('exports only authorized invoices and their payments with filters and audit', async () => {
      const path = `/api/v1/societies/${societyId}/invoices/export.csv`;
      const invoice = await db.invoice.findUniqueOrThrow({ where: { ulbId_societyId_periodStart: { ulbId, societyId, periodStart: new Date('2024-01-01') } }, include: { payments: true } });
      const result = await app.inject({ url: `${path}?status=PAID&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z`, headers: headers('society') });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.headers['content-type']).toContain('text/csv');
      expect(result.headers['content-disposition']).toContain('accounts.csv');
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.body.split('\r\n')).toHaveLength(3);
      expect(result.body).toContain(`"INVOICE","${invoice.id}"`);
      expect(result.body).toContain(`"PAYMENT","${invoice.payments[0].id}"`);
      expect(result.body).toContain(`"${invoice.totalPaise}"`);
      for (const fixture of outside) {
        expect(result.body).not.toContain(fixture.invoiceId);
        const filtered = await app.inject({ url: `${path}?societyId=${fixture.societyId}&wardId=${fixture.wardId}`, headers: headers('society') });
        expect(filtered.statusCode, filtered.body).toBe(200);
        expect(filtered.body.split('\r\n')).toHaveLength(1);
        expect((await app.inject({ url: `/api/v1/societies/${fixture.societyId}/invoices/export.csv`, headers: headers('society') })).statusCode).toBe(404);
      }
      expect((await app.inject({ url: `${path}?status=DRAFT`, headers: headers('society') })).body.split('\r\n')).toHaveLength(1);
      expect((await app.inject({ url: `${path}?from=2025-01-01T00:00:00Z`, headers: headers('society') })).body.split('\r\n')).toHaveLength(1);
      expect((await app.inject({ url: `${path}?status=INVALID`, headers: headers('society') })).statusCode).toBe(422);
      const audit = await db.auditLog.findFirstOrThrow({ where: { ulbId, actorId: users.society.id, action: 'EXPORT_DOWNLOADED', entityId: societyId }, orderBy: { createdAt: 'asc' } });
      expect(audit.after).toMatchObject({ type: 'accounts', format: 'csv', count: 2 });
    });

    it('restricts resident property selection to active links in the selected society', async () => {
      await db.resident.createMany({ data: [
        { ulbId, userId: users.resident.id, propertyId: properties[6].id },
        { ulbId, userId: users.resident.id, propertyId: properties[7].id, active: false },
        ...outside.map(fixture => ({ ulbId: fixture.ulbId, userId: users.resident.id, propertyId: fixture.propertyId })),
      ] });
      const path = '/api/v1/resident/properties';
      const first = await app.inject({ url: `${path}?limit=1`, headers: headers('resident') });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().data).toHaveLength(1);
      expect(first.json().nextCursor).toBe(first.json().data[0].id);
      const second = await app.inject({ url: `${path}?limit=1&cursor=${first.json().nextCursor}`, headers: headers('resident') });
      expect(second.statusCode, second.body).toBe(200);
      expect([first.json().data[0].id, second.json().data[0].id]).toEqual([properties[0].id, properties[6].id].sort());
      expect(second.json().nextCursor).toBeNull();
      for (const row of [first.json().data[0], second.json().data[0]]) {
        expect(row.society).toMatchObject({ id: societyId, wardId });
        for (const field of ['qrToken', 'qrTokenHash', 'residents']) expect(row).not.toHaveProperty(field);
      }
      const search = await app.inject({ url: `${path}?search=${properties[6].code}&status=ACTIVE&wardId=${wardId}`, headers: headers('resident') });
      expect(search.json().data.map((row: { id: string }) => row.id)).toEqual([properties[6].id]);
      for (const id of [properties[1].id, properties[7].id, ...outside.map(fixture => fixture.propertyId)]) {
        expect((await app.inject({ url: `${path}?cursor=${id}`, headers: headers('resident') })).statusCode).toBe(404);
      }
      for (const fixture of outside) expect((await app.inject({ url: `${path}?societyId=${fixture.societyId}&wardId=${fixture.wardId}`, headers: headers('resident') })).json()).toEqual({ data: [], nextCursor: null });
      expect((await app.inject({ url: `${path}?to=2000-01-01T00:00:00Z`, headers: headers('resident') })).json().data).toEqual([]);
    });

    it('enforces role and feature gates for the new read endpoints', async () => {
      for (const path of [`/societies/${societyId}/pickups`, `/ulb/${ulbId}/pickups`, `/pickups/${acceptedId}`, `/societies/${societyId}/compliance/annual-returns`, `/societies/${societyId}/invoices/export.csv`]) {
        expect((await app.inject({ url: `/api/v1${path}`, headers: headers('resident') })).statusCode).toBe(403);
      }
      expect((await app.inject({ url: '/api/v1/resident/properties', headers: headers('society') })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/v1/ulb/${ulbId}/pickups`, headers: headers('society') })).statusCode).toBe(403);
      await db.ulb.update({ where: { id: ulbId }, data: { flags: { billing_v1: false, compliance_v2: false } } });
      try {
        for (const path of ['compliance/annual-returns', 'invoices/export.csv']) {
          const response = await app.inject({ url: `/api/v1/societies/${societyId}/${path}`, headers: headers('society') });
          expect(response.statusCode, response.body).toBe(403);
          expect(response.json().error.code).toBe('FEATURE_DISABLED');
        }
      } finally {
        await db.ulb.update({ where: { id: ulbId }, data: { flags: { billing_v1: true, compliance_v2: true } } });
      }
    });
  });
});
