import { createHmac } from 'node:crypto';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { calculateSla } from '@swachh/domain';
import { complaintStatusSchema, verificationStatusSchema, invoiceStatusSchema } from '@swachh/contracts';
import type { Prisma } from '@prisma/client';
import { api, authorize, constantEqual, dateRange, fail, json, page, pageArgs, pagination, Scope, societyParams, uuid, type App } from './core.js';
import { dashboard } from './analytics.js';
import { complaintFilter, complaintState } from './operations.js';
import { reportPdf } from './pdf.js';
import { complianceSummary } from './compliance.js';
import { accountRows } from './billing.js';
import { csv } from './csv.js';

const ulbParams = z.object({ ulbId: uuid }).strict();
const officer = authorize('ULB_ADMIN', 'SUPER_ADMIN');
const admin = authorize('SOCIETY_ADMIN', 'ULB_ADMIN', 'SUPER_ADMIN');
const reportQuery = pagination.extend({ contractorId: uuid.optional() }).refine(query => !query.from || !query.to || Date.parse(query.from) <= Date.parse(query.to), 'from must not follow to');
const complaintQuery = pagination.extend({ status: complaintStatusSchema.optional(), breached: z.enum(['true', 'false']).optional() });

export async function reportingRoutes(app: App) {
  const router = api(app);
  router.post('/admin/ulbs', { preHandler: authorize('SUPER_ADMIN'), schema: { body: z.object({ name: z.string().min(1).max(200), state: z.string().min(1).max(100), code: z.string().min(1).max(30) }).strict() } }, async (request, reply) => {
    const scope = new Scope(request);
    const row = await app.db.$transaction(async tx => {
      const ulb = await tx.ulb.create({ data: request.body });
      const membership = await tx.membership.create({ data: { ulbId: ulb.id, userId: scope.userId, role: 'SUPER_ADMIN' } });
      await tx.auditLog.create({ data: { ulbId: ulb.id, actorId: scope.userId, action: 'ULB_CREATED', entity: 'Ulb', entityId: ulb.id, after: json(ulb), ip: request.ip } });
      return { ulb, membership };
    });
    return reply.code(201).send(row);
  });
  router.get('/societies/:societyId/dashboard', { preHandler: admin, schema: { params: societyParams, querystring: reportQuery } }, async request => {
    const scope = new Scope(request); const society = await scope.society(request.params.societyId);
    const from = new Date(request.query.from ?? Date.now() - 84 * 86400000); const to = new Date(request.query.to ?? Date.now());
    const tenant = await app.db.ulb.findUniqueOrThrow({ where: { id: scope.ulbId } });
    const compliance = (tenant.flags as Record<string, boolean>).compliance_v2 ? await complianceSummary(app.db, scope.ulbId, society.id, from, to) : undefined;
    return { society, ...await dashboard(app.db, scope.ulbId, [society.id], from, to, request.query.contractorId, compliance ? { certificateCoverage: compliance.certificateCoverage, massBalance: compliance.massBalance } : {}) };
  });
  router.get('/ulb/:ulbId/dashboard', { preHandler: officer, schema: { params: ulbParams, querystring: reportQuery } }, async request => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    const societies = await app.db.society.findMany({ where: { ulbId: scope.ulbId, deletedAt: null, ...(request.query.wardId ? { wardId: request.query.wardId } : {}), ...(request.query.societyId ? { id: request.query.societyId } : {}) } });
    const from = new Date(request.query.from ?? Date.now() - 30 * 86400000); const to = new Date(request.query.to ?? Date.now());
    const wards = await app.db.ward.findMany({ where: { ulbId: scope.ulbId, ...(request.query.wardId ? { id: request.query.wardId } : {}) } });
    const contractors = await app.db.contractor.findMany({ where: { ulbId: scope.ulbId, ...(request.query.contractorId ? { id: request.query.contractorId } : {}) } });
    const totals = await dashboard(app.db, scope.ulbId, societies.map(s => s.id), from, to, request.query.contractorId);
    const unattributedRejectedCount = await app.db.rejectedSubmission.count({ where: { ulbId: scope.ulbId, createdAt: { gte: from, lte: to } } });
    return { ...totals, submissionDiagnostics: { unattributedRejectedCount, definition: 'Invalid or unauthorized submissions cannot be attributed to a trusted property. They are retained separately from pickup-event data-quality metrics.' }, wards: await Promise.all(wards.map(async ward => ({ ...ward, ...await dashboard(app.db, scope.ulbId, societies.filter(s => s.wardId === ward.id).map(s => s.id), from, to, request.query.contractorId) }))), contractors: await Promise.all(contractors.map(async contractor => ({ ...contractor, ...(contractor.id === request.query.contractorId ? totals : await dashboard(app.db, scope.ulbId, societies.map(s => s.id), from, to, contractor.id)) }))), societies };
  });
  router.get('/ulb/:ulbId/wards', { preHandler: officer, schema: { params: ulbParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    return page(await app.db.ward.findMany({ where: { ulbId: scope.ulbId }, ...pageArgs(request.query) }), request.query.limit);
  });
  router.post('/ulb/:ulbId/wards', { preHandler: officer, schema: { params: ulbParams, body: z.object({ name: z.string().min(1).max(100), code: z.string().min(1).max(30), boundary: z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]))).min(1) }).strict().optional() }).strict() } }, async (request, reply) => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    const row = await app.db.$transaction(async tx => {
      const ward = await tx.ward.create({ data: { name: request.body.name, code: request.body.code, ulbId: scope.ulbId, ...(request.body.boundary ? { boundary: json(request.body.boundary) } : {}) } });
      await new Scope(request, tx).audit('WARD_CREATED', 'Ward', ward.id, undefined, ward); return ward;
    });
    return reply.code(201).send(row);
  });
  router.get('/ulb/:ulbId/societies', { preHandler: officer, schema: { params: ulbParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    return page(await app.db.society.findMany({ where: { ulbId: scope.ulbId, deletedAt: null, ...(request.query.wardId ? { wardId: request.query.wardId } : {}) }, include: { ward: true }, ...pageArgs(request.query) }), request.query.limit);
  });
  router.post('/ulb/:ulbId/societies', { preHandler: officer, schema: { params: ulbParams, body: z.object({ wardId: uuid, name: z.string().min(1).max(200), address: z.string().min(1).max(500), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), floorAreaSqm: z.number().min(0), waterLpd: z.number().min(0), wasteKgDay: z.number().min(0) }).strict() } }, async (request, reply) => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    if (!await app.db.ward.findFirst({ where: { id: request.body.wardId, ulbId: scope.ulbId } })) return fail(404, 'NOT_FOUND', 'Ward not found.');
    const row = await app.db.$transaction(async tx => {
      const society = await tx.society.create({ data: { ...request.body, ulbId: scope.ulbId } });
      await new Scope(request, tx).audit('SOCIETY_CREATED', 'Society', society.id, undefined, society); return society;
    });
    return reply.code(201).send(row);
  });
  router.get('/ulb/:ulbId/contractors', { preHandler: officer, schema: { params: ulbParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    return page(await app.db.contractor.findMany({ where: { ulbId: scope.ulbId }, include: { collectors: true }, ...pageArgs(request.query) }), request.query.limit);
  });
  router.get('/societies/:societyId/collectors', { preHandler: admin, schema: { params: societyParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId);
    const vendors = await app.db.vendor.findMany({ where: { ulbId: scope.ulbId, societyId: request.params.societyId, contractorId: { not: null } } });
    const rows = await app.db.collector.findMany({ where: { ulbId: scope.ulbId, contractorId: { in: vendors.map(v => v.contractorId!) } }, include: { contractor: true }, ...pageArgs(request.query) });
    const users = await app.db.user.findMany({ where: { id: { in: rows.map(r => r.userId) } }, select: { id: true, name: true } });
    return page(rows.map(row => ({ ...row, user: users.find(u => u.id === row.userId) })), request.query.limit);
  });
  router.get('/societies/:societyId/routes', { preHandler: admin, schema: { params: societyParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId);
    return page(await app.db.route.findMany({ where: { ulbId: scope.ulbId, stops: { some: { ulbId: scope.ulbId, property: { societyId: request.params.societyId } } }, date: dateRange(request.query) }, include: { stops: { where: { ulbId: scope.ulbId, property: { societyId: request.params.societyId } } } }, ...pageArgs(request.query) }), request.query.limit);
  });
  router.get('/supervisor/dashboard', { preHandler: authorize('SUPERVISOR'), schema: { querystring: reportQuery } }, async request => {
    const scope = new Scope(request);
    const societies = await app.db.society.findMany({ where: scope.societyFilter(), select: { id: true } });
    return dashboard(app.db, scope.ulbId, societies.map(s => s.id), new Date(request.query.from ?? Date.now() - 30 * 86400000), new Date(request.query.to ?? Date.now()), scope.membership.contractorId ?? '00000000-0000-0000-0000-000000000000');
  });
  async function complaintList(scope: Scope, query: z.infer<typeof complaintQuery>, extra: Prisma.ComplaintWhereInput = {}) {
    const rows = await app.db.complaint.findMany({ where: { ...await complaintFilter(scope), ...extra, createdAt: dateRange(query), ...(query.status ? { status: query.status } : {}), ...(query.breached === 'true' ? { slaDueAt: { lt: new Date() }, pausedAt: null, status: { notIn: ['RESOLVED', 'CLOSED'] } } : {}) }, include: { events: true }, ...pageArgs(query) });
    const categories = await app.db.complaintCategory.findMany({ where: { ulbId: scope.ulbId } });
    return page(await Promise.all(rows.map(async row => ({ ...row, category: categories.find(c => c.id === row.categoryId), sla: calculateSla(await complaintState(app.db, row), new Date().toISOString()) }))), query.limit);
  }
  router.get('/ulb/:ulbId/complaints', { preHandler: officer, schema: { params: ulbParams, querystring: complaintQuery } }, async request => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    const societies = await app.db.society.findMany({ where: { ulbId: scope.ulbId, ...(request.query.wardId ? { wardId: request.query.wardId } : {}), ...(request.query.societyId ? { id: request.query.societyId } : {}) }, select: { id: true } });
    return complaintList(scope, request.query, { societyId: { in: societies.map(s => s.id) } });
  });
  router.get('/supervisor/complaints', { preHandler: authorize('SUPERVISOR'), schema: { querystring: complaintQuery } }, request => complaintList(new Scope(request), request.query));
  router.post('/ulb/:ulbId/complaints/:id/escalate', { preHandler: officer, schema: { params: ulbParams.extend({ id: uuid }), body: z.object({ reason: z.string().min(1).max(2000) }).strict() } }, async request => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    const complaint = await app.db.complaint.findFirst({ where: { id: request.params.id, ulbId: scope.ulbId } });
    if (!complaint) return fail(404, 'NOT_FOUND', 'Complaint not found.');
    return app.db.$transaction(async tx => {
      const row = await tx.complaint.update({ where: { id: complaint.id, ulbId: scope.ulbId }, data: { escalationLevel: 2, events: { create: { ulbId: scope.ulbId, actorId: scope.userId, fromStatus: complaint.status, toStatus: complaint.status, note: `Escalated: ${request.body.reason}` } } } });
      const scoped = new Scope(request, tx); await scoped.audit('COMPLAINT_ESCALATED', 'Complaint', row.id, complaint, row); await scoped.notify('SLA_BREACH', `${row.id}:manual`, { complaintId: row.id, reason: request.body.reason }); return row;
    });
  });
  router.get('/ulb/:ulbId/certificates', { preHandler: officer, schema: { params: ulbParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId); await scope.feature('compliance_v2');
    const rows = await app.db.ebwgrCertificate.findMany({ where: { ulbId: scope.ulbId, ...(request.query.societyId ? { societyId: request.query.societyId } : {}) }, ...pageArgs(request.query) });
    const societies = await app.db.society.findMany({ where: { ulbId: scope.ulbId, id: { in: rows.map(c => c.societyId) } }, select: { id: true, name: true } });
    return page(rows.map(row => ({ ...row, society: societies.find(s => s.id === row.societyId) })), request.query.limit);
  });
  router.get('/ulb/:ulbId/audit-log', { preHandler: officer, schema: { params: ulbParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    return page(await app.db.auditLog.findMany({ where: { ulbId: scope.ulbId, createdAt: dateRange(request.query) }, ...pageArgs(request.query) }), request.query.limit);
  });
  router.patch('/ulb/:ulbId/feature-flags', { preHandler: authorize('SUPER_ADMIN'), schema: { params: ulbParams, body: z.object({ compliance_v2: z.boolean(), billing_v1: z.boolean(), whatsapp_v1: z.boolean(), swachhata_v1: z.boolean() }).strict() } }, async request => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    return app.db.$transaction(async tx => {
      const before = await tx.ulb.findUniqueOrThrow({ where: { id: scope.ulbId } });
      const row = await tx.ulb.update({ where: { id: scope.ulbId }, data: { flags: request.body } });
      await new Scope(request, tx).audit('FEATURE_FLAGS_UPDATED', 'Ulb', row.id, before.flags, row.flags); return row.flags;
    });
  });
  router.patch('/ulb/:ulbId/settings', { preHandler: officer, schema: { params: ulbParams, body: z.object({ geofenceM: z.number().min(10).max(500), maxAccuracyM: z.number().min(1).max(100), offlineRetentionDays: z.number().int().min(1).max(90), certificateValidityYears: z.number().int().min(1).max(10), photoRetentionMonths: z.number().int().min(1).max(120), complaintPhotoRetentionMonths: z.number().int().min(1).max(120), auditRetentionYears: z.number().int().min(7).max(30), invoiceRetentionYears: z.number().int().min(8).max(30) }).strict() } }, async request => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    return app.db.$transaction(async tx => {
      const previous = await tx.ulb.findUniqueOrThrow({ where: { id: scope.ulbId } });
      const row = await tx.ulb.update({ where: { id: scope.ulbId }, data: { settings: json({ ...(previous.settings as object), ...request.body }) } });
      await new Scope(request, tx).audit('ULB_SETTINGS_UPDATED', 'Ulb', row.id, previous.settings, row.settings); return row.settings;
    });
  });
  const categoryBody = z.object({ name: z.string().min(1).max(200), slaHours: z.number().int().min(1).max(8760), active: z.boolean().default(true) }).strict();
  router.post('/ulb/:ulbId/complaint-categories', { preHandler: officer, schema: { params: ulbParams, body: categoryBody } }, async (request, reply) => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    const row = await app.db.$transaction(async tx => {
      const category = await tx.complaintCategory.create({ data: { ulbId: scope.ulbId, ...request.body } });
      await new Scope(request, tx).audit('COMPLAINT_CATEGORY_CREATED', 'ComplaintCategory', category.id, undefined, category); return category;
    });
    return reply.code(201).send(row);
  });
  router.patch('/ulb/:ulbId/complaint-categories/:id', { preHandler: officer, schema: { params: ulbParams.extend({ id: uuid }), body: categoryBody } }, async request => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    return app.db.$transaction(async tx => {
      const previous = await tx.complaintCategory.findFirst({ where: { id: request.params.id, ulbId: scope.ulbId } });
      if (!previous) return fail(404, 'NOT_FOUND', 'Complaint category not found.');
      const row = await tx.complaintCategory.update({ where: { id: previous.id, ulbId: scope.ulbId }, data: request.body });
      await new Scope(request, tx).audit('COMPLAINT_CATEGORY_UPDATED', 'ComplaintCategory', row.id, previous, row); return row;
    });
  });
  router.get('/ulb/:ulbId/exports/:type.:format', { preHandler: officer, schema: { params: ulbParams.extend({ type: z.enum(['pickups', 'complaints', 'invoices', 'payments', 'certificates', 'accounts']), format: z.enum(['csv', 'xlsx', 'pdf']) }), querystring: reportQuery } }, async (request, reply) => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    const { type, format } = request.params;
    if (['invoices', 'payments', 'accounts'].includes(type)) await scope.feature('billing_v1');
    if (type === 'certificates') await scope.feature('compliance_v2');
    const societies = await app.db.society.findMany({ where: { ulbId: scope.ulbId, ...(request.query.wardId ? { wardId: request.query.wardId } : {}), ...(request.query.societyId ? { id: request.query.societyId } : {}) }, select: { id: true } });
    const base = { ulbId: scope.ulbId, societyId: { in: societies.map(s => s.id) } };
    let rows: Record<string, unknown>[];
    if (type === 'pickups') {
      const collectors = request.query.contractorId ? await app.db.collector.findMany({ where: { ulbId: scope.ulbId, contractorId: request.query.contractorId }, select: { id: true } }) : null;
      rows = await app.db.pickupEvent.findMany({ where: { ...base, capturedAt: dateRange(request.query), ...(request.query.status ? { status: verificationStatusSchema.parse(request.query.status) } : {}), ...(collectors ? { collectorId: { in: collectors.map(c => c.id) } } : {}) }, take: 10001, select: { id: true, societyId: true, propertyId: true, collectorId: true, capturedAt: true, status: true, verificationScore: true, offline: true, provenance: true } });
    } else if (type === 'complaints') rows = await app.db.complaint.findMany({ where: { ...base, createdAt: dateRange(request.query), ...(request.query.status ? { status: complaintStatusSchema.parse(request.query.status) } : {}) }, take: 10001, select: { id: true, societyId: true, categoryId: true, status: true, slaDueAt: true, escalationLevel: true, createdAt: true } });
    else if (type === 'certificates') rows = await app.db.ebwgrCertificate.findMany({ where: { ...base, issuedAt: dateRange(request.query), ...(request.query.status ? { status: request.query.status } : {}) }, take: 10001, select: { id: true, societyId: true, certificateNo: true, stream: true, kg: true, issuedBy: true, issuedAt: true, validUntil: true, status: true } });
    else if (type === 'payments') rows = await app.db.payment.findMany({ where: { ulbId: scope.ulbId, invoice: base, paidAt: dateRange(request.query) }, take: 10001, select: { id: true, invoiceId: true, amountPaise: true, method: true, reference: true, paidAt: true } });
    else if (type === 'accounts') {
      const invoices = await app.db.invoice.findMany({ where: { ...base, periodStart: dateRange(request.query) }, take: 10001, include: { payments: true } });
      rows = accountRows(invoices);
    } else rows = await app.db.invoice.findMany({ where: { ...base, periodStart: dateRange(request.query), ...(request.query.status ? { status: invoiceStatusSchema.parse(request.query.status) } : {}) }, take: 10001, select: { id: true, societyId: true, periodStart: true, periodEnd: true, status: true, totalPaise: true, deductionsPaise: true, paidAt: true } });
    if (rows.length > 10000) return fail(413, 'EXPORT_TOO_LARGE', 'Narrow the period to export at most 10,000 rows.');
    await scope.audit('EXPORT_DOWNLOADED', 'Export', type, undefined, { format, count: rows.length, filters: request.query });
    const columns = Object.keys(rows[0] ?? { id: '' });
    const value = (v: unknown) => v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v);
    reply.header('Content-Disposition', `attachment; filename="${type}.${format}"`);
    if (format === 'csv') {
      return reply.type('text/csv; charset=utf-8').send(csv(columns, rows));
    }
    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet(type);
      sheet.columns = columns.map(key => ({ header: key, key, width: 24 }));
      for (const row of rows) sheet.addRow(Object.fromEntries(columns.map(c => [c, value(row[c])])));
      return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(await workbook.xlsx.writeBuffer()));
    }
    return reply.type('application/pdf').send(await reportPdf(`ULB ${type} register`, [{ heading: 'Scoped records', lines: rows.map(row => columns.map(c => `${c}: ${value(row[c])}`).join(' | ')) }]));
  });

  for (const channel of ['swachhata', 'whatsapp'] as const) {
    router.post(`/webhooks/${channel}`, { schema: { body: z.object({ ulbId: uuid, eventId: z.string().min(1).max(200), status: z.string().min(1).max(100), complaintId: uuid.optional() }).strict() } }, async request => {
      const secret = channel === 'swachhata' ? app.config.SWACHHATA_WEBHOOK_SECRET : app.config.WHATSAPP_WEBHOOK_SECRET;
      if (!secret) return fail(501, 'NOT_CONFIGURED', 'Webhook signing secret and provider integration are not configured.');
      const signature = request.headers['x-signature'];
      const expected = createHmac('sha256', secret).update(request.rawBody ?? '').digest('hex');
      if (typeof signature !== 'string' || !constantEqual(signature.replace(/^sha256=/, ''), expected)) return fail(401, 'WEBHOOK_SIGNATURE_INVALID', 'Invalid webhook signature.');
      const ulb = await app.db.ulb.findUnique({ where: { id: request.body.ulbId } });
      if (!ulb) return fail(404, 'NOT_FOUND', 'ULB not found.');
      await app.db.outboundMessage.create({ data: { ulbId: ulb.id, channel: `${channel.toUpperCase()}_WEBHOOK`, entityId: request.body.eventId, payload: json(request.body), status: 'NOT_CONFIGURED' } });
      return fail(501, 'NOT_CONFIGURED', 'Signature verified; payload retained. No government or messaging status was changed.');
    });
  }
}
