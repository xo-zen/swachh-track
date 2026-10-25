import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hash, istDate } from '../src/core.js';
import { DEMO_SEED_ACTION, DEMO_ULB_CODE, DEMO_ULB_ID, DEMO_USERS, demoId } from '../src/demo.js';
import { seedDatabase } from '../src/seed-data.js';
import { Storage } from '../src/storage.js';

const secret = 'seed-test-only-secret-value-0123456789';
const ulbId = DEMO_ULB_ID;
const where = { ulbId };
const markerWhere = { ulbId, action: DEMO_SEED_ACTION };

describe('seed environment guards', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it.each([
    { NODE_ENV: 'test', DEMO_MODE: 'true' },
    { NODE_ENV: 'development', DEMO_MODE: 'false' },
    { NODE_ENV: 'production', DEMO_MODE: 'false' },
  ])('refuses hosted seeding with %j before database access', async flags => {
    for (const [key, value] of Object.entries({ DATABASE_URL: 'postgresql://localhost/unused', JWT_SECRET: secret, QR_SECRET: secret, HOSTED_DEMO: 'true', NO_AUTH: 'false', STORAGE_DRIVER: 'local', ...flags })) vi.stubEnv(key, value);
    const db = new PrismaClient();
    const read = vi.spyOn(db.ulb, 'findUnique');
    try {
      await expect(seedDatabase(db)).rejects.toThrow(/HOSTED_DEMO|production/);
      expect(read).not.toHaveBeenCalled();
    } finally { await db.$disconnect(); }
  });
});

// Explicit opt-in only: this URL is used to CREATE a uniquely named database,
// never as the seed target. Each test drops only the database it just created.
const adminUrl = process.env.SEED_TEST_ADMIN_DATABASE_URL;
describe.skipIf(!adminUrl)('seed profiles in fresh disposable PostgreSQL databases', () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  let databaseName: string | undefined;
  let storagePath: string | undefined;
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: adminUrl! } } });
    await admin.$connect();
  });
  beforeEach(async () => {
    const name = `swachh_seed_test_${randomUUID().replaceAll('-', '')}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    databaseName = name;
    const url = new URL(adminUrl!);
    url.pathname = `/${name}`;
    url.searchParams.set('schema', 'public');
    storagePath = await mkdtemp('/tmp/bcode/swachh-seed-test-');
    for (const [key, value] of Object.entries({ DATABASE_URL: url.toString(), NODE_ENV: 'development', DEMO_MODE: 'true', HOSTED_DEMO: 'true', NO_AUTH: 'false', JWT_SECRET: secret, QR_SECRET: secret, STORAGE_DRIVER: 'local', LOCAL_STORAGE_PATH: storagePath })) vi.stubEnv(key, value);
    execFileSync(process.execPath, [fileURLToPath(new URL('../../../node_modules/prisma/build/index.js', import.meta.url)), 'migrate', 'deploy'], { cwd: projectRoot, env: process.env, stdio: 'pipe' });
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    expect(await db.ulb.count()).toBe(0);
  });
  afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    if (db) await db.$disconnect();
    if (databaseName) {
      await admin.$executeRawUnsafe(`DROP DATABASE "${databaseName}"`);
      databaseName = undefined;
    }
    if (storagePath) { await rm(storagePath, { recursive: true, force: true }); storagePath = undefined; }
  });
  afterAll(async () => { if (admin) await admin.$disconnect(); });

  it('seeds the complete compact profile, real local evidence, all roles and skips repeat runs', async () => {
    await seedDatabase(db);
    expect(await db.ulb.count()).toBe(2);
    expect(await db.society.count({ where })).toBe(5);
    const societies = await db.society.findMany({ where, include: { properties: true } });
    expect(societies.every(s => s.properties.length === 6)).toBe(true);
    for (const society of societies) {
      expect(society.properties.filter(p => p.block === 'A')).toHaveLength(3);
      expect(society.properties.filter(p => p.block === 'B')).toHaveLength(3);
      expect(society.properties.map(p => p.floor).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    }
    expect(await db.property.count()).toBe(30);
    const routes = await db.route.findMany({ where, include: { stops: { orderBy: { sequence: 'asc' } } } });
    expect(routes).toHaveLength(24);
    expect(routes.every(r => r.stops.length === 10)).toBe(true);
    expect(routes.every(r => r.stops.map(s => s.sequence).join(',') === '1,2,3,4,5,6,7,8,9,10')).toBe(true);
    const todayRoutes = routes.filter(r => r.date.toISOString().slice(0, 10) === istDate());
    expect(todayRoutes).toHaveLength(3);
    expect(todayRoutes.flatMap(r => r.stops).every(s => s.status === 'PENDING')).toBe(true);
    expect(todayRoutes.find(r => r.name === 'Garden Ward Loop')?.wardId).toBe(demoId('ward-1'));
    expect(await db.routeStop.count({ where })).toBe(240);
    const history = await db.pickupEvent.findMany({ where });
    expect(history).toHaveLength(210);
    expect(new Set(history.map(p => istDate(p.capturedAt))).size).toBe(7);
    expect(history.every(p => p.provenance === 'DEMO_SYNTHETIC')).toBe(true);
    expect(history.filter(p => p.status === 'VERIFIED')).toHaveLength(174);
    expect(history.filter(p => p.status === 'NEEDS_REVIEW')).toHaveLength(28);
    expect(history.filter(p => p.status === 'REJECTED')).toHaveLength(8);
    expect(await db.pickupException.count({ where })).toBe(12);
    expect(await db.pickupStream.count({ where })).toBe(198);
    expect(history.filter(p => p.propertyId === demoId('property-0') && p.status === 'VERIFIED')).toHaveLength(6);
    expect(await db.rating.count({ where })).toBe(6);

    const storage = new Storage(loadConfig());
    const photos = await db.photo.findMany({ where });
    expect(photos).toHaveLength(408);
    for (const photo of photos) {
      const bytes = await storage.read(photo.storageKey);
      expect(bytes.length).toBe(photo.size);
      expect(hash(bytes)).toBe(photo.sha256);
      expect(await sharp(bytes).metadata()).toMatchObject({ format: 'jpeg', width: 320, height: 200 });
      expect(photo.status).toBe('CONFIRMED');
    }
    const documents = await db.complianceDocument.findMany({ where });
    expect(documents).toHaveLength(5);
    for (const document of documents) {
      expect(document.status).toBe('DEMO_SYNTHETIC');
      expect(await sharp(await storage.read(document.storageKey!)).metadata()).toMatchObject({ format: 'jpeg', width: 320, height: 200 });
    }
    for (const user of DEMO_USERS) {
      expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ phone: user.phone, name: user.name });
      expect(await db.membership.findUniqueOrThrow({ where: { id: user.membershipId } })).toMatchObject({ userId: user.id, ulbId, role: user.role, societyId: user.societyId, contractorId: user.contractorId });
    }
    expect(await db.collector.count({ where })).toBe(6);
    expect(await db.contractor.count({ where })).toBe(2);
    expect(await db.schedule.count({ where })).toBe(20);
    expect(await db.vendor.count({ where })).toBe(5);
    expect(await db.ebwgrCertificate.count({ where })).toBe(5);
    expect(await db.complaint.count({ where })).toBe(12);
    expect(await db.complaintEvent.count({ where })).toBe(12);
    expect(await db.invoice.count({ where })).toBe(2);
    const flats = await db.invoiceLine.findMany({ where: { ...where, unit: 'FLAT' } });
    expect(flats).toHaveLength(2);
    for (const line of flats) {
      expect(Number(line.quantity)).toBe(6);
      expect(line.amountPaise).toBe(150000);
      expect(line.evidence).toMatchObject({ aggregateQueryRef: 'fictional-seed:Green-Meadows:6-active-flats' });
    }
    expect(await db.payment.count({ where })).toBe(1);
    const isolationUlbId = demoId('ulb-isolation');
    expect(await db.society.findUniqueOrThrow({ where: { id: demoId('society-isolation') } })).toMatchObject({ ulbId: isolationUlbId });
    expect(await db.membership.findUniqueOrThrow({ where: { id: demoId('membership-isolation') } })).toMatchObject({ ulbId: isolationUlbId, role: 'ULB_ADMIN' });
    expect(await db.pickupEvent.count({ where: { ulbId: isolationUlbId } })).toBe(0);
    const markers = await db.auditLog.findMany({ where: markerWhere });
    expect(markers).toHaveLength(1);
    expect(markers[0].after).toMatchObject({ societies: 5, properties: 30, collectors: 6, contractors: 2, routeTemplates: 3, historicalDays: 7, historicalEvents: 210, verified: 174, needsReview: 16, rejected: 8, exceptions: 12 });

    await db.society.update({ where: { id: demoId('society-0') }, data: { name: 'User-edited society' } });
    const writes = vi.spyOn(Storage.prototype, 'write');
    await seedDatabase(db);
    expect(writes).not.toHaveBeenCalled();
    expect(await db.society.findUniqueOrThrow({ where: { id: demoId('society-0') } })).toMatchObject({ name: 'User-edited society' });
    expect(await db.auditLog.findMany({ where: markerWhere })).toEqual(markers);
    expect(await db.pickupEvent.findMany({ where, orderBy: { id: 'asc' } })).toEqual([...history].sort((a, b) => a.id.localeCompare(b.id)));
    expect(await db.photo.count({ where })).toBe(408);
    await db.ulb.create({ data: { code: 'UNEXPECTED-TENANT', name: 'Do not modify', state: 'Test' } });
    await expect(seedDatabase(db)).rejects.toThrow(/dedicated database/);
    expect(await db.auditLog.findMany({ where: markerWhere })).toEqual(markers);
    expect(writes).not.toHaveBeenCalled();
  }, 120000);

  it('preserves the default 240-property, 30-day seed and refuses a hosted switch', async () => {
    vi.stubEnv('HOSTED_DEMO', undefined);
    expect(loadConfig().HOSTED_DEMO).toBe('false');
    await seedDatabase(db);
    expect(await db.property.count({ where })).toBe(240);
    const societies = await db.society.findMany({ where, include: { properties: true } });
    expect(societies).toHaveLength(5);
    for (const society of societies) {
      expect(society.properties).toHaveLength(48);
      expect(society.properties.filter(p => p.block === 'A')).toHaveLength(24);
      expect(society.properties.filter(p => p.block === 'B')).toHaveLength(24);
      for (let floor = 1; floor <= 6; floor++) expect(society.properties.filter(p => p.floor === floor)).toHaveLength(8);
    }
    expect(await db.route.count({ where })).toBe(93);
    expect(await db.routeStop.count({ where })).toBe(7440);
    const stops = await db.routeStop.groupBy({ by: ['routeId'], where, _count: true });
    expect(stops.every(r => r._count === 80)).toBe(true);
    expect(await db.pickupEvent.count({ where })).toBe(7200);
    expect(await db.photo.count({ where })).toBe(13968);
    const markers = await db.auditLog.findMany({ where: markerWhere });
    expect(markers).toHaveLength(1);
    expect(markers[0].after).toMatchObject({ societies: 5, properties: 240, collectors: 6, contractors: 2, routeTemplates: 3, historicalDays: 30, historicalEvents: 7200, verified: 5904, needsReview: 576, rejected: 288, exceptions: 432 });
    const flats = await db.invoiceLine.findMany({ where: { ...where, unit: 'FLAT' } });
    expect(flats.map(line => Number(line.quantity))).toEqual([48, 48]);
    expect(flats.every(line => line.amountPaise === 1200000)).toBe(true);
    const writes = vi.spyOn(Storage.prototype, 'write');
    await seedDatabase(db);
    expect(writes).not.toHaveBeenCalled();
    vi.stubEnv('HOSTED_DEMO', 'true');
    await expect(seedDatabase(db)).rejects.toThrow(/new empty database/);
    expect(writes).not.toHaveBeenCalled();
    expect(await db.property.count({ where })).toBe(240);
    expect(await db.pickupEvent.count({ where })).toBe(7200);
    expect(await db.auditLog.findMany({ where: markerWhere })).toEqual(markers);
  }, 240000);

  it('rejects an interrupted standard layout instead of mixing profiles', async () => {
    vi.stubEnv('HOSTED_DEMO', 'false');
    const writes = vi.spyOn(Storage.prototype, 'write').mockRejectedValue(new Error('Intentional seed interruption'));
    await expect(seedDatabase(db)).rejects.toThrow('Intentional seed interruption');
    expect(await db.property.count({ where })).toBe(240);
    expect(await db.auditLog.count({ where: markerWhere })).toBe(0);
    writes.mockClear();
    vi.stubEnv('HOSTED_DEMO', 'true');
    await expect(seedDatabase(db)).rejects.toThrow(/incompatible property layout/);
    expect(writes).not.toHaveBeenCalled();
    expect(await db.property.count({ where })).toBe(240);
  });

  it.each([
    Prisma.JsonNull, {}, [], { properties: 30 },
    { properties: '30', historicalDays: 7 }, { properties: 30, historicalDays: '7' },
    { properties: 240, historicalDays: 30 }, { properties: 30, historicalDays: 30 }, { properties: 240, historicalDays: 7 },
  ].map(after => ({ after })))('fails closed for missing, malformed or incompatible marker sizes: %j', async ({ after }) => {
    await db.ulb.create({ data: { id: ulbId, code: DEMO_ULB_CODE, name: 'Existing demo tenant', state: 'Test' } });
    const marker = await db.auditLog.create({ data: { ulbId, actorId: demoId('user-ulb'), action: DEMO_SEED_ACTION, entity: 'Ulb', entityId: ulbId, after } });
    const writes = vi.spyOn(Storage.prototype, 'write');
    await expect(seedDatabase(db)).rejects.toThrow(/30-property, 7-day seed marker/);
    expect(await db.property.count()).toBe(0);
    expect(await db.auditLog.findMany({ where: markerWhere })).toEqual([marker]);
    expect(writes).not.toHaveBeenCalled();
  });

  it('checks every completion marker rather than accepting one compatible marker', async () => {
    await db.ulb.create({ data: { id: ulbId, code: DEMO_ULB_CODE, name: 'Existing demo tenant', state: 'Test' } });
    const markerData = { ulbId, actorId: demoId('user-ulb'), action: DEMO_SEED_ACTION, entity: 'Ulb', entityId: ulbId };
    await db.auditLog.create({ data: { ...markerData, after: { properties: 30, historicalDays: 7 } } });
    await db.auditLog.create({ data: { ...markerData, after: { properties: 240, historicalDays: 30 } } });
    const writes = vi.spyOn(Storage.prototype, 'write');
    await expect(seedDatabase(db)).rejects.toThrow(/30-property, 7-day seed marker/);
    expect(await db.property.count()).toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([
    { id: randomUUID(), code: 'REAL-COUNCIL' },
    { id: randomUUID(), code: DEMO_ULB_CODE },
    { id: DEMO_ULB_ID, code: 'REAL-COUNCIL' },
    { id: randomUUID(), code: 'ISOLATION-DEMO' },
    { id: demoId('ulb-isolation'), code: 'REAL-COUNCIL' },
  ])('rejects unexpected tenant identity %j without writing', async identity => {
    const original = await db.ulb.create({ data: { ...identity, name: 'Do not modify', state: 'Test' } });
    const writes = vi.spyOn(Storage.prototype, 'write');
    await expect(seedDatabase(db)).rejects.toThrow(/dedicated database/);
    expect(await db.ulb.findMany()).toEqual([original]);
    expect(await db.property.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });

  it('resumes an interrupted seed across days without overwriting edits or evidence, and records actual counts', async () => {
    const originalWrite = Storage.prototype.write;
    let writes = 0;
    const interruption = vi.spyOn(Storage.prototype, 'write').mockImplementation(async function (this: Storage, ...args) {
      if (++writes === 66) throw new Error('Intentional seed interruption');
      return originalWrite.apply(this, args);
    });
    await expect(seedDatabase(db)).rejects.toThrow('Intentional seed interruption');
    interruption.mockRestore();
    expect(await db.auditLog.count({ where: markerWhere })).toBe(0);
    expect(await db.pickupEvent.count({ where })).toBe(30);
    const propertyId = demoId('property-0');
    await db.property.update({ where: { id: propertyId }, data: { unitNo: 'User-edited unit', status: 'INACTIVE' } });
    const pickup = await db.pickupEvent.findFirstOrThrow({ where: { ulbId, propertyId } });
    await db.pickupEvent.update({ where: { id: pickup.id }, data: { status: 'REJECTED', reviewReason: 'User-reviewed evidence' } });
    const photo = await db.photo.findFirstOrThrow({ where: { pickupEventId: pickup.id } });
    const document = await db.complianceDocument.findUniqueOrThrow({ where: { id: demoId('document-0') } });
    const bytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    const storage = new Storage(loadConfig());
    await storage.write(photo.storageKey, bytes);
    await storage.write(document.storageKey!, bytes);
    await db.photo.update({ where: { id: photo.id }, data: { sha256: hash(bytes), size: bytes.length, width: 24, height: 24 } });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 2 * 86400000));
    await seedDatabase(db);
    expect(await db.property.count({ where })).toBe(30);
    expect(await db.route.count({ where })).toBe(24);
    expect(await db.routeStop.count({ where })).toBe(240);
    expect(await db.pickupEvent.count({ where })).toBe(210);
    expect(await db.photo.count({ where })).toBe(408);
    expect(await db.property.findUniqueOrThrow({ where: { id: propertyId } })).toMatchObject({ unitNo: 'User-edited unit', status: 'INACTIVE' });
    expect(await db.pickupEvent.findUniqueOrThrow({ where: { id: pickup.id } })).toMatchObject({ status: 'REJECTED', reviewReason: 'User-reviewed evidence' });
    expect(await storage.read(photo.storageKey)).toEqual(bytes);
    expect(await storage.read(document.storageKey!)).toEqual(bytes);
    expect((await db.invoiceLine.findMany({ where: { ...where, unit: 'FLAT' } })).map(line => Number(line.quantity))).toEqual([5, 5]);
    expect((await db.auditLog.findFirstOrThrow({ where: markerWhere })).after).toMatchObject({ properties: 30, historicalDays: 7, historicalEvents: 210, verified: 173, needsReview: 16, rejected: 9, exceptions: 12 });
  }, 120000);
});
