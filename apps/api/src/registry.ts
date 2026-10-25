import { randomInt, randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import QRCode from 'qrcode';
import { z } from 'zod';
import { propertySchema, propertyUpdateSchema, residentInviteSchema, scheduleSchema, type ScheduleInput } from '@swachh/contracts';
import { signQrToken, hashQrToken, scheduledWindow } from '@swachh/domain';
import type { Schedule } from '@prisma/client';
import { api, authorize, fail, json, page, pageArgs, pagination, Scope, societyParams, societyIdParams, uuid, type App, type Db } from './core.js';
import { qrPdf } from './pdf.js';

const admin = authorize('SOCIETY_ADMIN', 'ULB_ADMIN', 'SUPER_ADMIN');
const vendorBody = z.object({ name: z.string().min(1).max(200), type: z.enum(['COLLECTOR', 'TRANSPORTER', 'MRF', 'RECYCLER', 'COMPOST', 'BIOGAS']), authorizationNumber: z.string().min(1).max(100), validUntil: z.string().datetime({ offset: true }), documentId: uuid, contractorId: uuid.optional() }).strict();
export function scheduleInput(row: Schedule): ScheduleInput {
  return { stream: row.stream, pattern: row.pattern === 'WEEKLY' ? { type: 'WEEKLY', weekdays: row.weekdays } : { type: 'EVERY_N_DAYS', everyNDays: row.everyNDays! }, windowStart: row.windowStart, windowEnd: row.windowEnd, activeFrom: row.activeFrom.toISOString().slice(0, 10), ...(row.activeTo ? { activeTo: row.activeTo.toISOString().slice(0, 10) } : {}) };
}
function scheduleData(body: ScheduleInput) {
  return { stream: body.stream, pattern: body.pattern.type, weekdays: body.pattern.type === 'WEEKLY' ? body.pattern.weekdays : [], everyNDays: body.pattern.type === 'EVERY_N_DAYS' ? body.pattern.everyNDays : null, windowStart: body.windowStart, windowEnd: body.windowEnd, activeFrom: new Date(body.activeFrom), activeTo: body.activeTo ? new Date(body.activeTo) : null };
}
export async function createProperty(db: Db, app: App, ulbId: string, societyId: string, body: z.infer<typeof propertySchema>) {
  const id = randomUUID();
  let propertyCode = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    propertyCode = randomInt(100000, 1000000).toString();
    if (!await db.property.findUnique({ where: { ulbId_propertyCode: { ulbId, propertyCode } } })) break;
  }
  const qrToken = signQrToken(id, { version: app.config.QR_SECRET_VERSION, secret: app.config.QR_SECRET });
  return db.property.create({ data: { ...body, id, ulbId, societyId, block: body.block ?? '', propertyCode, qrTokenHash: hashQrToken(qrToken), qrVersion: app.config.QR_SECRET_VERSION } });
}

export async function registryRoutes(app: App) {
  const router = api(app);
  router.get('/societies/:societyId/properties', { preHandler: admin, schema: { params: societyParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId);
    const q = request.query;
    const rows = await app.db.property.findMany({ where: { ...scope.propertyFilter(), societyId: request.params.societyId, ...(q.search ? { OR: [{ unitNo: { contains: q.search, mode: 'insensitive' } }, { block: { contains: q.search, mode: 'insensitive' } }] } : {}), ...(q.status ? { status: q.status } : {}) }, ...pageArgs(q) });
    return page(rows.map(({ qrTokenHash: _hash, ...row }) => row), q.limit);
  });
  router.post('/societies/:societyId/properties', { preHandler: admin, schema: { params: societyParams, body: propertySchema } }, async (request, reply) => {
    const scope = new Scope(request); await scope.society(request.params.societyId);
    const row = await app.db.$transaction(async tx => {
      const property = await createProperty(tx, app, scope.ulbId, request.params.societyId, request.body);
      await new Scope(request, tx).audit('PROPERTY_CREATED', 'Property', property.id, undefined, property);
      return property;
    });
    return reply.code(201).send(row);
  });
  router.post('/societies/:societyId/properties/import', { preHandler: admin, schema: { params: societyParams, body: z.object({ csv: z.string().min(1).max(1024 * 1024) }).strict() } }, async (request, reply) => {
    const scope = new Scope(request); await scope.society(request.params.societyId);
    let records: Record<string, string>[];
    try { records = parse(request.body.csv, { columns: true, trim: true, skip_empty_lines: true, max_record_size: 4096 }) as Record<string, string>[]; }
    catch { return fail(422, 'CSV_INVALID', 'CSV could not be parsed. Use unitNo,block,floor,latitude,longitude,status columns.'); }
    if (!records.length || records.length > 1000) return fail(422, 'CSV_ROWS', 'Import 1 to 1000 properties per request.');
    const parsed = records.map((record, index) => {
      const result = propertySchema.safeParse({ ...record, latitude: Number(record.latitude), longitude: Number(record.longitude), ...(record.floor ? { floor: Number(record.floor) } : { floor: 0 }), status: record.status || 'ACTIVE' });
      if (!result.success) return fail(422, 'CSV_ROW_INVALID', `Invalid property at row ${index + 2}.`, result.error.flatten());
      return result.data;
    });
    const result = await app.db.$transaction(async tx => {
      const rows = [];
      for (const body of parsed) rows.push(await createProperty(tx, app, scope.ulbId, request.params.societyId, body));
      await new Scope(request, tx).audit('PROPERTIES_IMPORTED', 'Society', request.params.societyId, undefined, { count: rows.length, ids: rows.map(r => r.id) });
      return { imported: rows.length, data: rows };
    }, { timeout: 30000 });
    return reply.code(201).send(result);
  });
  router.patch('/societies/:societyId/properties/:id', { preHandler: admin, schema: { params: societyIdParams, body: propertyUpdateSchema } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId); const previous = await scope.property(request.params.id);
    if (previous.societyId !== request.params.societyId) return fail(404, 'NOT_FOUND', 'Property not found in this society.');
    return app.db.$transaction(async tx => {
      const row = await tx.property.update({ where: { id: previous.id, ulbId: scope.ulbId }, data: request.body });
      await new Scope(request, tx).audit('PROPERTY_UPDATED', 'Property', row.id, previous, row); return row;
    });
  });
  router.get('/societies/:societyId/properties/qr-sheet.pdf', { preHandler: admin, schema: { params: societyParams, querystring: z.object({ limit: z.coerce.number().int().min(1).max(240).default(20) }).strict() } }, async (request, reply) => {
    const scope = new Scope(request); const society = await scope.society(request.params.societyId);
    const properties = await app.db.property.findMany({ where: { ulbId: scope.ulbId, societyId: society.id, deletedAt: null, status: 'ACTIVE' }, orderBy: [{ block: 'asc' }, { unitNo: 'asc' }], take: request.query.limit });
    const items = await Promise.all(properties.map(async property => {
      const token = signQrToken(property.id, { secret: app.config.QR_SECRET, version: app.config.QR_SECRET_VERSION });
      if (hashQrToken(token) !== property.qrTokenHash) fail(409, 'QR_ROTATION_REQUIRED', 'Reissue property QR tokens after secret rotation.');
      return { label: `${property.block} ${property.unitNo}`, code: property.propertyCode, image: await QRCode.toDataURL(token, { width: 250, margin: 1 }) };
    }));
    return reply.type('application/pdf').header('Content-Disposition', 'attachment; filename="property-qr-sheet.pdf"').send(await qrPdf(society.name, items));
  });
  router.post('/societies/:societyId/properties/rotate-qr', { preHandler: admin, schema: { params: societyParams, body: z.object({}).strict() } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId);
    return app.db.$transaction(async tx => {
      const properties = await tx.property.findMany({ where: { ulbId: scope.ulbId, societyId: request.params.societyId, deletedAt: null } });
      for (const property of properties) await tx.property.update({ where: { id: property.id, ulbId: scope.ulbId }, data: { qrVersion: app.config.QR_SECRET_VERSION, qrTokenHash: hashQrToken(signQrToken(property.id, { secret: app.config.QR_SECRET, version: app.config.QR_SECRET_VERSION })) } });
      await new Scope(request, tx).audit('QR_ROTATED', 'Society', request.params.societyId, undefined, { version: app.config.QR_SECRET_VERSION, count: properties.length });
      return { updated: properties.length };
    });
  });
  router.get('/societies/:societyId/residents', { preHandler: admin, schema: { params: societyParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId);
    return page(await app.db.resident.findMany({ where: { ulbId: scope.ulbId, property: { societyId: request.params.societyId } }, include: { user: { select: { name: true, phone: true, email: true } }, property: { select: { unitNo: true, block: true } } }, ...pageArgs(request.query) }), request.query.limit);
  });
  router.post('/societies/:societyId/residents/invite', { preHandler: admin, schema: { params: societyParams, body: residentInviteSchema } }, async (request, reply) => {
    if (app.config.HOSTED_DEMO === 'true' || app.config.NO_AUTH === 'true') return fail(403, 'HOSTED_DEMO_IDENTITY_LOCKED', 'Resident invitations are disabled in this demo.');
    const scope = new Scope(request); await scope.society(request.params.societyId); const property = await scope.property(request.body.propertyId);
    if (property.societyId !== request.params.societyId) return fail(404, 'NOT_FOUND', 'Property not found.');
    const result = await app.db.$transaction(async tx => {
      const user = await tx.user.upsert({ where: { phone: request.body.phone }, update: {}, create: { phone: request.body.phone, name: request.body.name } });
      let membership = await tx.membership.findFirst({ where: { ulbId: scope.ulbId, userId: user.id, societyId: property.societyId, role: 'RESIDENT' } });
      if (!membership) membership = await tx.membership.create({ data: { ulbId: scope.ulbId, userId: user.id, societyId: property.societyId, role: 'RESIDENT' } });
      else if (membership.status !== 'ACTIVE') membership = await tx.membership.update({ where: { id: membership.id, ulbId: scope.ulbId }, data: { status: 'ACTIVE' } });
      const resident = await tx.resident.upsert({ where: { userId_propertyId: { userId: user.id, propertyId: property.id } }, update: { active: true }, create: { ulbId: scope.ulbId, userId: user.id, propertyId: property.id } });
      const scoped = new Scope(request, tx);
      await scoped.audit('RESIDENT_INVITED', 'Resident', resident.id, undefined, { propertyId: property.id, userId: user.id });
      await scoped.notify('RESIDENT_INVITED', resident.id, { societyId: property.societyId, propertyId: property.id }, user.id);
      return { resident, membership, delivery: 'IN_APP', smsStatus: 'NOT_CONFIGURED' };
    });
    return reply.code(201).send(result);
  });
  router.patch('/societies/:societyId/residents/:id', { preHandler: admin, schema: { params: societyIdParams, body: z.object({ active: z.boolean() }).strict() } }, async request => {
    if (app.config.HOSTED_DEMO === 'true' || app.config.NO_AUTH === 'true') return fail(403, 'HOSTED_DEMO_IDENTITY_LOCKED', 'Resident identity changes are disabled in this demo.');
    const scope = new Scope(request); await scope.society(request.params.societyId);
    const resident = await app.db.resident.findFirst({ where: { ulbId: scope.ulbId, id: request.params.id, property: { societyId: request.params.societyId } } });
    if (!resident) return fail(404, 'NOT_FOUND', 'Resident not found.');
    return app.db.$transaction(async tx => {
      const result = await tx.resident.update({ where: { id: resident.id, ulbId: scope.ulbId }, data: request.body });
      await new Scope(request, tx).audit('RESIDENT_UPDATED', 'Resident', resident.id, resident, result); return result;
    });
  });
  router.get('/societies/:societyId/schedules', { preHandler: admin, schema: { params: societyParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId);
    const rows = await app.db.schedule.findMany({ where: { ulbId: scope.ulbId, societyId: request.params.societyId }, ...pageArgs(request.query) });
    return page(rows.map(row => ({ ...row, ...scheduleInput(row) })), request.query.limit);
  });
  router.post('/societies/:societyId/schedules', { preHandler: admin, schema: { params: societyParams, body: scheduleSchema } }, async (request, reply) => {
    const scope = new Scope(request); await scope.society(request.params.societyId);
    const row = await app.db.$transaction(async tx => {
      const result = await tx.schedule.create({ data: { ulbId: scope.ulbId, societyId: request.params.societyId, ...scheduleData(request.body) } });
      await new Scope(request, tx).audit('SCHEDULE_CREATED', 'Schedule', result.id, undefined, result); return result;
    });
    return reply.code(201).send({ ...row, ...scheduleInput(row) });
  });
  router.patch('/societies/:societyId/schedules/:id', { preHandler: admin, schema: { params: societyIdParams, body: scheduleSchema } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId);
    const old = await app.db.schedule.findFirst({ where: { ulbId: scope.ulbId, societyId: request.params.societyId, id: request.params.id } });
    if (!old) return fail(404, 'NOT_FOUND', 'Schedule not found.');
    return app.db.$transaction(async tx => {
      const row = await tx.schedule.update({ where: { id: old.id, ulbId: scope.ulbId }, data: scheduleData(request.body) });
      await new Scope(request, tx).audit('SCHEDULE_UPDATED', 'Schedule', row.id, old, row); return { ...row, ...scheduleInput(row) };
    });
  });
  router.get('/societies/:societyId/vendors', { preHandler: admin, schema: { params: societyParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId);
    const rows = await app.db.vendor.findMany({ where: { ulbId: scope.ulbId, societyId: request.params.societyId }, ...pageArgs(request.query) });
    return page(rows.map(v => ({ ...v, kind: v.type, authorisationNumber: v.authorizationNumber })), request.query.limit);
  });
  router.post('/societies/:societyId/vendors', { preHandler: admin, schema: { params: societyParams, body: vendorBody } }, async (request, reply) => {
    const scope = new Scope(request); await scope.society(request.params.societyId);
    if (request.body.documentId && !await app.db.complianceDocument.findFirst({ where: { id: request.body.documentId, ulbId: scope.ulbId, societyId: request.params.societyId } })) return fail(404, 'NOT_FOUND', 'Authorization document not found.');
    if (request.body.contractorId && !await app.db.contractor.findFirst({ where: { id: request.body.contractorId, ulbId: scope.ulbId } })) return fail(404, 'NOT_FOUND', 'Contractor not found.');
    const row = await app.db.$transaction(async tx => {
      const vendor = await tx.vendor.create({ data: { ...request.body, ulbId: scope.ulbId, societyId: request.params.societyId, validUntil: new Date(request.body.validUntil) } });
      await new Scope(request, tx).audit('VENDOR_REGISTERED', 'Vendor', vendor.id, undefined, vendor); return vendor;
    });
    return reply.code(201).send(row);
  });
  router.patch('/societies/:societyId/settings', { preHandler: admin, schema: { params: societyParams, body: z.object({ flatFeePaise: z.number().int().min(0).max(10000000), pickupFeePaise: z.number().int().min(0).max(1000000), handlingFeePaisePerKg: z.number().int().min(0).max(1000000), missedDeductionPaise: z.number().int().min(0).max(1000000), graceDays: z.number().int().min(0).max(90), paymentInstructions: z.string().max(2000), feeSource: z.string().max(500), feeSourceDate: z.string().date() }).strict() } }, async request => {
    const scope = new Scope(request); const society = await scope.society(request.params.societyId);
    return app.db.$transaction(async tx => {
      const row = await tx.society.update({ where: { id: society.id, ulbId: scope.ulbId }, data: { settings: json(request.body) } });
      await new Scope(request, tx).audit('SETTINGS_UPDATED', 'Society', row.id, society.settings, row.settings); return row.settings;
    });
  });
  router.post('/societies/:societyId/routes', { preHandler: admin, schema: { params: societyParams, body: z.object({ name: z.string().min(1).max(100), date: z.string().date(), collectorId: uuid, vendorId: uuid, propertyIds: z.array(uuid).min(1).max(500) }).strict() } }, async (request, reply) => {
    const scope = new Scope(request); const society = await scope.society(request.params.societyId);
    const { date, collectorId, vendorId, propertyIds } = request.body;
    const collector = await app.db.collector.findFirst({ where: { id: collectorId, ulbId: scope.ulbId, status: 'ACTIVE' }, include: { contractor: true } });
    const vendor = await app.db.vendor.findFirst({ where: { id: vendorId, ulbId: scope.ulbId, societyId: society.id, status: 'ACTIVE' } });
    if (!collector || !vendor) return fail(404, 'NOT_FOUND', 'Collector or vendor not found.');
    const validAt = new Date(`${date}T23:59:59+05:30`);
    if (!vendor.documentId || vendor.validFrom > validAt || vendor.validUntil < validAt || collector.contractor.validFrom > validAt || collector.contractor.validTo < validAt || (vendor.contractorId && vendor.contractorId !== collector.contractorId)) fail(422, 'VENDOR_AUTHORIZATION_INVALID', 'Assignment requires a valid, documented vendor and contractor.');
    const document = await app.db.complianceDocument.findFirst({ where: { id: vendor.documentId!, ulbId: scope.ulbId, societyId: society.id } });
    if (!document || (document.validUntil && document.validUntil < validAt)) fail(422, 'VENDOR_AUTHORIZATION_EXPIRED', 'Vendor authorization document is missing or expired.');
    const properties = await app.db.property.findMany({ where: { ulbId: scope.ulbId, societyId: society.id, id: { in: propertyIds }, status: 'ACTIVE', deletedAt: null } });
    if (properties.length !== propertyIds.length) fail(422, 'PROPERTIES_INVALID', 'Properties must be unique active properties in this society.');
    const schedules = await app.db.schedule.findMany({ where: { ulbId: scope.ulbId, societyId: society.id, active: true } });
    const windows = schedules.map(row => ({ stream: row.stream, window: scheduledWindow(scheduleInput(row), date) })).filter(item => item.window !== null);
    if (!windows.length) fail(422, 'NO_SCHEDULE', 'No streams are scheduled on the selected date.');
    const start = new Date(Math.min(...windows.map(w => Date.parse(w.window!.start))));
    const end = new Date(Math.max(...windows.map(w => Date.parse(w.window!.end))));
    const row = await app.db.$transaction(async tx => {
      const route = await tx.route.create({ data: { ulbId: scope.ulbId, contractorId: collector.contractorId, collectorId, wardId: society.wardId, name: request.body.name, date: new Date(date), stops: { create: propertyIds.map((propertyId, index) => ({ ulbId: scope.ulbId, propertyId, sequence: index + 1, windowStart: start, windowEnd: end, streams: [...new Set(windows.map(w => w.stream))] })) } }, include: { stops: true } });
      await new Scope(request, tx).audit('ROUTE_ASSIGNED', 'Route', route.id, undefined, route); return route;
    });
    return reply.code(201).send(row);
  });
}
