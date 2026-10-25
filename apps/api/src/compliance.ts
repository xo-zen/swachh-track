import { z } from 'zod';
import { STREAMS, eligibilitySchema, documentSchema, handoverSchema, annualReturnSchema, kgSchema, type Stream } from '@swachh/contracts';
import { calculateEligibility, calculateCertificateCoverage, calculateMassBalance, estimateAnnualObligation, certificateValidUntil, certificateExpiryAlert, sumKg } from '@swachh/domain';
import { api, authorize, dateRange, fail, hash, idempotencyHeader, istDate, json, page, pageArgs, pagination, Scope, serialized, societyParams, societyIdParams, streamSchema, uuid, type App, type Db } from './core.js';
import { dataset } from './analytics.js';
import { inspectionPdf, reportPdf } from './pdf.js';

const admin = authorize('SOCIETY_ADMIN', 'ULB_ADMIN', 'SUPER_ADMIN');
const officer = authorize('ULB_ADMIN', 'SUPER_ADMIN');
const certificateBody = z.object({ certificateNo: z.string().min(1).max(100), stream: streamSchema, kg: kgSchema, issuedAt: z.string().date(), validUntil: z.string().date().optional(), documentId: uuid }).strict();

export async function complianceSummary(db: Db, ulbId: string, societyId: string, from = new Date(Date.now() - 30 * 86400000), to = new Date()) {
  const society = await db.society.findFirstOrThrow({ where: { id: societyId, ulbId } });
  const ulb = await db.ulb.findUniqueOrThrow({ where: { id: ulbId } });
  const activeFlats = await db.property.count({ where: { ulbId, societyId, status: 'ACTIVE', deletedAt: null } });
  const data = await dataset(db, ulbId, [societyId], from, to);
  const certificates = await db.ebwgrCertificate.findMany({ where: { ulbId, societyId } });
  const handovers = await db.handover.findMany({ where: { ulbId, societyId, date: { gte: from, lte: to } } });
  const onsite = await db.onsiteLog.findMany({ where: { ulbId, societyId, date: { gte: from, lte: to } } });
  const observedDays = Math.min(365, Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86400000)));
  const obligation = estimateAnnualObligation(data.events, observedDays);
  const requiredKg = Object.fromEntries(STREAMS.map(s => [s, obligation[s].requiredKg])) as Record<Stream, number>;
   const coverage = calculateCertificateCoverage({ societyId, asOf: istDate(to), requiredKg, obligationProvenance: 'ESTIMATED', obligationSourceIds: data.events.filter(e => e.status === 'VERIFIED' && !e.exception).map(e => e.id).concat(`query:verified-pickups:${ulbId}:${societyId}:${from.toISOString()}:${to.toISOString()}`), certificates: certificates.map(c => ({ id: c.id, societyId, issuingUlbId: c.ulbId, documentId: c.documentId, stream: c.stream, kg: Number(c.kg), issuedAt: c.issuedAt.toISOString().slice(0, 10), validUntil: c.validUntil.toISOString().slice(0, 10), status: c.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE' })), validityYears: (ulb.settings as Record<string, number>).certificateValidityYears ?? 3 });
  const collectedKg = sumKg(data.events.filter(e => e.status === 'VERIFIED' && !e.exception).flatMap(e => e.streams.map(s => s.kg)));
  const verifiedHandovers = handovers.filter(h => h.verifiedAt);
  const massBalance = calculateMassBalance({ collected: { kg: collectedKg, provenance: 'VERIFIED', sourceIds: data.events.filter(e => e.status === 'VERIFIED').map(e => e.id).concat(`query:${societyId}:${from.toISOString()}:${to.toISOString()}`) }, handedOver: { kg: sumKg(verifiedHandovers.map(h => Number(h.kg))), provenance: 'VERIFIED', sourceIds: verifiedHandovers.map(h => h.id).concat(`query:verified-handovers:${societyId}`) }, processed: { kg: sumKg(onsite.map(l => Number(l.outputKg))), provenance: 'SELF_REPORTED', sourceIds: onsite.map(l => l.id).concat(`query:onsite:${societyId}`) }, verifiedRegisteredProcessorReceipt: verifiedHandovers.length > 0 });
  return { society, eligibility: calculateEligibility({ floorAreaSqm: society.floorAreaSqm, waterLitresPerDay: society.waterLpd, wasteKgPerDay: society.wasteKgDay, flats: activeFlats, isRwaOrGatedCommunity: true }), registration: society.registration, obligation, certificateCoverage: coverage, certificates: certificates.map(c => ({ ...c, expiryAlert: certificateExpiryAlert(c.validUntil.toISOString().slice(0, 10), istDate(to)) })), massBalance, handovers: { verifiedKg: sumKg(verifiedHandovers.map(h => Number(h.kg))), selfReportedKg: sumKg(handovers.filter(h => !h.verifiedAt).map(h => Number(h.kg))), data: handovers }, onsite: { provenance: 'SELF_REPORTED', data: onsite }, period: { from, to }, disclaimer: 'Swachh-Track records evidence, not legal compliance. Certificates are issued externally by the ULB. The ULB makes the final determination.' };
}

export async function complianceRoutes(app: App) {
  const router = api(app);
  router.get('/societies/:societyId/compliance/annual-returns', { preHandler: admin, schema: { params: societyParams, querystring: pagination.extend({ status: z.literal('DRAFT').optional(), financialYearStart: z.coerce.number().int().min(2000).max(2200).optional() }) } }, async request => {
    const scope = new Scope(request); const society = await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    const query = request.query;
    const matches = (!query.societyId || query.societyId === society.id) && (!query.wardId || query.wardId === society.wardId);
    const where = { ulbId: scope.ulbId, societyId: { in: matches ? [society.id] : [] }, generatedAt: dateRange(query), ...(query.status ? { status: query.status } : {}), ...(query.financialYearStart !== undefined ? { financialYear: query.financialYearStart } : {}) };
    if (query.cursor && !await app.db.annualReturn.findFirst({ where: { ...where, id: query.cursor }, select: { id: true } })) return fail(404, 'NOT_FOUND', 'Annual return cursor not found in this scope and filter.');
    return page(await app.db.annualReturn.findMany({ where, select: { id: true, ulbId: true, societyId: true, financialYear: true, status: true, generatedAt: true }, ...pageArgs(query) }), query.limit);
  });
  router.get('/societies/:societyId/compliance/summary', { preHandler: admin, schema: { params: societyParams } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    return complianceSummary(app.db, scope.ulbId, request.params.societyId);
  });
  router.post('/societies/:societyId/compliance/eligibility', { preHandler: admin, schema: { params: societyParams, body: eligibilitySchema } }, async request => {
    const scope = new Scope(request); const society = await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    return app.db.$transaction(async tx => {
      const updated = await tx.society.update({ where: { id: society.id, ulbId: scope.ulbId }, data: { floorAreaSqm: request.body.floorAreaSqm, waterLpd: request.body.waterLitresPerDay, wasteKgDay: request.body.wasteKgPerDay } });
      const result = calculateEligibility(request.body); await new Scope(request, tx).audit('ELIGIBILITY_UPDATED', 'Society', society.id, society, { ...updated, result }); return { ...result, provenance: 'SELF_REPORTED' };
    });
  });
  router.patch('/societies/:societyId/compliance/registration', { preHandler: admin, schema: { params: societyParams, body: z.object({ cpcbStatus: z.enum(['NOT_STARTED', 'PENDING', 'REGISTERED']), registrationNumber: z.string().min(1).max(100), registeredAt: z.string().date(), renewalDate: z.string().date(), documentId: uuid }).strict() } }, async request => {
    const scope = new Scope(request); const society = await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    if (!await app.db.complianceDocument.findFirst({ where: { id: request.body.documentId, ulbId: scope.ulbId, societyId: society.id } })) return fail(404, 'NOT_FOUND', 'Registration document not found.');
    if (request.body.renewalDate < request.body.registeredAt) return fail(422, 'REGISTRATION_DATES', 'Renewal cannot precede registration.');
    return app.db.$transaction(async tx => {
      const updated = await tx.society.update({ where: { id: society.id, ulbId: scope.ulbId }, data: { registration: json(request.body) } });
      await new Scope(request, tx).audit('REGISTRATION_RECORDED', 'Society', society.id, society.registration, updated.registration); return updated.registration;
    });
  });
  router.get('/societies/:societyId/compliance/documents', { preHandler: admin, schema: { params: societyParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    return page(await app.db.complianceDocument.findMany({ where: { ulbId: scope.ulbId, societyId: request.params.societyId }, ...pageArgs(request.query) }), request.query.limit);
  });
  router.post('/societies/:societyId/compliance/documents', { preHandler: admin, schema: { params: societyParams, body: documentSchema } }, async (request, reply) => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    // storageKey is an opaque owned-upload reference, never an arbitrary external object key.
    const upload = await app.db.upload.findFirst({ where: { ulbId: scope.ulbId, ownerId: scope.userId, status: 'CONFIRMED', OR: [{ storageKey: request.body.storageKey }, ...(uuid.safeParse(request.body.storageKey).success ? [{ id: request.body.storageKey }] : [])] } });
    if (!upload) return fail(422, 'DOCUMENT_UNCONFIRMED', 'A confirmed upload owned by the current user is required.');
    const row = await app.db.$transaction(async tx => {
      const document = await tx.complianceDocument.create({ data: { ...request.body, ulbId: scope.ulbId, societyId: request.params.societyId, issuedAt: new Date(request.body.issuedAt), validUntil: request.body.validUntil ? new Date(`${request.body.validUntil}T23:59:59+05:30`) : null, storageKey: upload.storageKey, uploadId: upload.id, photoId: upload.contentType.startsWith('image/') ? upload.id : null } });
      await new Scope(request, tx).audit('DOCUMENT_RECORDED', 'ComplianceDocument', document.id, undefined, document); return document;
    });
    return reply.code(201).send(row);
  });
  router.get('/societies/:societyId/compliance/documents/:id/download', { preHandler: admin, schema: { params: societyIdParams } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    const document = await app.db.complianceDocument.findFirst({ where: { id: request.params.id, ulbId: scope.ulbId, societyId: request.params.societyId } });
    if (!document?.storageKey) return fail(404, 'DOCUMENT_BYTES_MISSING', 'No document bytes are stored for this record.');
    return { url: await app.storage.url(document.storageKey, 'GET'), expiresIn: 300, scanStatus: 'NOT_CONFIGURED' };
  });
  router.get('/societies/:societyId/compliance/certificates', { preHandler: admin, schema: { params: societyParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    return page(await app.db.ebwgrCertificate.findMany({ where: { ulbId: scope.ulbId, societyId: request.params.societyId }, ...pageArgs(request.query) }), request.query.limit);
  });

  async function recordCertificate(scope: Scope, societyId: string, body: z.infer<typeof certificateBody>) {
    await scope.society(societyId); await scope.feature('compliance_v2');
    const ulb = await app.db.ulb.findUniqueOrThrow({ where: { id: scope.ulbId } });
    const document = await app.db.complianceDocument.findFirst({ where: { id: body.documentId, ulbId: scope.ulbId, societyId } });
    if (!document?.storageKey) return fail(422, 'CERTIFICATE_DOCUMENT_REQUIRED', 'An uploaded external certificate document is required.');
    if (body.issuedAt > istDate()) return fail(422, 'CERTIFICATE_DATE_INVALID', 'An external certificate cannot be issued in the future.');
    const validUntil = body.validUntil ?? certificateValidUntil(body.issuedAt, (ulb.settings as Record<string, number>).certificateValidityYears ?? 3);
    if (validUntil < body.issuedAt) return fail(422, 'CERTIFICATE_DATE_INVALID', 'Expiry precedes issue date.');
    return app.db.$transaction(async tx => {
      const row = await tx.ebwgrCertificate.create({ data: { ...body, ulbId: scope.ulbId, societyId, issuedBy: ulb.name, issuedAt: new Date(body.issuedAt), validUntil: new Date(`${validUntil}T23:59:59+05:30`), recordedBy: scope.userId, status: 'RECORDED' } });
      await new Scope(scope.request, tx).audit('EXTERNAL_CERTIFICATE_RECORDED', 'EbwgrCertificate', row.id, undefined, row); return row;
    });
  }
  router.post('/societies/:societyId/compliance/certificates', { preHandler: officer, schema: { params: societyParams, body: certificateBody } }, async (request, reply) => reply.code(201).send(await recordCertificate(new Scope(request), request.params.societyId, request.body)));
  router.post('/ulb/:ulbId/certificates', { preHandler: officer, schema: { params: z.object({ ulbId: uuid }).strict(), body: certificateBody.extend({ societyId: uuid }) } }, async (request, reply) => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    const { societyId, ...body } = request.body; return reply.code(201).send(await recordCertificate(scope, societyId, body));
  });
  router.get('/societies/:societyId/compliance/handovers', { preHandler: admin, schema: { params: societyParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    return page(await app.db.handover.findMany({ where: { ulbId: scope.ulbId, societyId: request.params.societyId }, ...pageArgs(request.query) }), request.query.limit);
  });
  router.post('/societies/:societyId/compliance/handovers', { preHandler: admin, schema: { params: societyParams, body: handoverSchema } }, async (request, reply) => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    const vendor = await app.db.vendor.findFirst({ where: { id: request.body.vendorId, ulbId: scope.ulbId, societyId: request.params.societyId, status: 'ACTIVE' } });
    if (!vendor || !vendor.documentId || vendor.validUntil < new Date(request.body.date) || vendor.validFrom > new Date(request.body.date)) return fail(422, 'VENDOR_AUTHORIZATION_INVALID', 'Handover needs an authorized vendor on the handover date.');
    const document = await app.db.complianceDocument.findFirst({ where: { id: request.body.documentId, ulbId: scope.ulbId, societyId: request.params.societyId } });
    if (!document?.storageKey) return fail(422, 'RECEIPT_REQUIRED', 'Upload a receipt document before recording the handover.');
    const row = await app.db.$transaction(async tx => {
      const { receiptNumber, ...body } = request.body;
      const handover = await tx.handover.create({ data: { ...body, receiptNo: receiptNumber, date: new Date(body.date), ulbId: scope.ulbId, societyId: request.params.societyId } });
      await new Scope(request, tx).audit('HANDOVER_RECORDED', 'Handover', handover.id, undefined, handover); return { ...handover, provenance: 'SELF_REPORTED' };
    });
    return reply.code(201).send(row);
  });
  router.post('/societies/:societyId/compliance/handovers/:id/verify', { preHandler: officer, schema: { params: societyIdParams, body: z.object({ reason: z.string().min(1).max(2000) }).strict() } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    const handover = await app.db.handover.findFirst({ where: { id: request.params.id, ulbId: scope.ulbId, societyId: request.params.societyId } });
    if (!handover) return fail(404, 'NOT_FOUND', 'Handover not found.');
    return app.db.$transaction(async tx => {
      const row = await tx.handover.update({ where: { id: handover.id, ulbId: scope.ulbId }, data: { verifiedAt: new Date(), verifiedBy: scope.userId } });
      await new Scope(request, tx).audit('HANDOVER_VERIFIED', 'Handover', row.id, handover, { ...row, reason: request.body.reason }); return { ...row, provenance: 'VERIFIED' };
    });
  });
  const onsiteBody = z.object({ asset: z.string().min(1).max(100), capacityKg: kgSchema, date: z.string().date(), inputKg: kgSchema, outputKg: z.number().min(0).max(9999999.999), downtime: z.string().max(1000).optional(), photoId: uuid }).strict().refine(b => b.outputKg <= b.inputKg && b.inputKg <= b.capacityKg, 'Output must not exceed input; input must not exceed capacity.');
  router.get('/societies/:societyId/compliance/onsite-logs', { preHandler: admin, schema: { params: societyParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    return page(await app.db.onsiteLog.findMany({ where: { ulbId: scope.ulbId, societyId: request.params.societyId }, ...pageArgs(request.query) }), request.query.limit);
  });
  router.post('/societies/:societyId/compliance/onsite-logs', { preHandler: admin, schema: { params: societyParams, body: onsiteBody } }, async (request, reply) => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('compliance_v2'); await scope.photo(request.body.photoId);
    const row = await app.db.$transaction(async tx => {
      const log = await tx.onsiteLog.create({ data: { ...request.body, date: new Date(request.body.date), ulbId: scope.ulbId, societyId: request.params.societyId } });
      await new Scope(request, tx).audit('ONSITE_LOG_RECORDED', 'OnsiteLog', log.id, undefined, log); return log;
    });
    return reply.code(201).send(row);
  });
  router.get('/societies/:societyId/compliance/monthly-log', { preHandler: admin, schema: { params: societyParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    const rows = await app.db.pickupEvent.findMany({ where: { ulbId: scope.ulbId, societyId: request.params.societyId, status: 'VERIFIED', exceptionCode: null, capturedAt: { ...(request.query.from ? { gte: new Date(request.query.from) } : {}), ...(request.query.to ? { lte: new Date(request.query.to) } : {}) } }, include: { streams: true }, ...pageArgs(request.query) });
    return page(rows.map(row => ({ ...row, provenance: 'VERIFIED' })), request.query.limit);
  });
  router.post('/societies/:societyId/compliance/annual-return', { preHandler: admin, schema: { params: societyParams, body: annualReturnSchema } }, async (request, reply) => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    const key = idempotencyHeader(request); const year = request.body.financialYearStart; const requestHash = hash(JSON.stringify({ societyId: request.params.societyId, year }));
    const result = await serialized(app.db, `annual-generation:${scope.ulbId}`, async tx => {
      const idem = { ulbId: scope.ulbId, actorId: scope.userId, operation: 'ANNUAL_RETURN', key };
      const prior = await tx.idempotencyKey.findUnique({ where: { ulbId_actorId_operation_key: idem } });
      if (prior) { if (prior.requestHash !== requestHash) return fail(409, 'IDEMPOTENCY_MISMATCH', 'Key belongs to another annual return.', { original: prior.response }); return prior.response; }
      const from = new Date(`${year}-04-01T00:00:00+05:30`); const to = new Date(`${year + 1}-03-31T23:59:59.999+05:30`);
      const summary = await complianceSummary(tx, scope.ulbId, request.params.societyId, from, to);
      const existing = await tx.annualReturn.findUnique({ where: { ulbId_societyId_financialYear: { ulbId: scope.ulbId, societyId: request.params.societyId, financialYear: year } } });
      if (existing) return fail(409, 'ANNUAL_RETURN_EXISTS', 'A draft already exists for this financial year.', { original: existing });
      const row = await tx.annualReturn.create({ data: { ulbId: scope.ulbId, societyId: request.params.societyId, financialYear: year, payload: json({ label: 'DRAFT - for ULB/CA review', financialYear: `${year}-${year + 1}`, ...summary, declaration: 'Prepared from recorded evidence. Not submitted to CPCB. Review quantities, evidence gaps and legal obligations with the ULB/CA.' }) } });
      await new Scope(request, tx).audit('ANNUAL_RETURN_DRAFTED', 'AnnualReturn', row.id, undefined, { financialYear: year });
      await tx.idempotencyKey.create({ data: { ...idem, requestHash, response: json(row), responseCode: 201 } }); return json(row);
    });
    return reply.code(201).send(result);
  });
  router.get('/societies/:societyId/compliance/annual-return/:id', { preHandler: admin, schema: { params: societyIdParams } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    return await app.db.annualReturn.findFirst({ where: { id: request.params.id, ulbId: scope.ulbId, societyId: request.params.societyId } }) ?? fail(404, 'NOT_FOUND', 'Annual return not found.');
  });
  router.get('/societies/:societyId/compliance/annual-return/:id.pdf', { preHandler: admin, schema: { params: societyIdParams } }, async (request, reply) => {
    const scope = new Scope(request); const society = await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    const row = await app.db.annualReturn.findFirst({ where: { id: request.params.id, ulbId: scope.ulbId, societyId: society.id } });
    if (!row) return fail(404, 'NOT_FOUND', 'Annual return not found.');
    return reply.type('application/pdf').header('Content-Disposition', 'attachment; filename="annual-return-draft.pdf"').send(await reportPdf(`DRAFT - for ULB/CA review | ${society.name}`, Object.entries(row.payload as Record<string, unknown>).map(([heading, value]) => ({ heading, lines: JSON.stringify(value, null, 2).split('\n') }))));
  });
  router.get('/societies/:societyId/compliance/inspection-pack.pdf', { preHandler: admin, schema: { params: societyParams } }, async (request, reply) => {
    const scope = new Scope(request); const society = await scope.society(request.params.societyId); await scope.feature('compliance_v2');
    const from = new Date(Date.now() - 365 * 86400000); const summary = await complianceSummary(app.db, scope.ulbId, society.id, from);
    const documents = await app.db.complianceDocument.findMany({ where: { ulbId: scope.ulbId, societyId: society.id } });
    const vendors = await app.db.vendor.findMany({ where: { ulbId: scope.ulbId, societyId: society.id } });
    const events = await app.db.pickupEvent.findMany({ where: { ulbId: scope.ulbId, societyId: society.id, capturedAt: { gte: from }, status: 'VERIFIED' }, include: { streams: true }, orderBy: { capturedAt: 'asc' } });
    const invoices = await app.db.invoice.findMany({ where: { ulbId: scope.ulbId, societyId: society.id, periodStart: { gte: from } }, include: { lines: true } });
    const sections = [{ heading: 'Scope and declaration', lines: [summary.disclaimer, 'Evidence manifest and 12-month operational register. Original private documents remain in the document vault and are referenced by document IDs.'] }, { heading: 'Registration', lines: [JSON.stringify(society.registration)] }, { heading: 'Documents and authorizations', lines: documents.map(d => `${d.id} | ${d.type} | ${d.number} | ${d.issuedBy} | valid until ${d.validUntil?.toISOString() ?? 'not supplied'} | ${d.status}`) }, { heading: 'Vendors', lines: vendors.map(v => `${v.name} | ${v.type} | ${v.authorizationNumber} | ${v.validUntil.toISOString()} | document ${v.documentId ?? 'MISSING'}`) }, { heading: 'Certificate ledger', lines: summary.certificates.map(c => `${c.certificateNo} | ${c.stream} | ${c.kg} kg | ${c.status} | expiry ${c.validUntil.toISOString()} | document ${c.documentId}`) }, { heading: 'Verified pickup logs', lines: events.map(e => `${e.capturedAt.toISOString()} | ${e.id} | property ${e.propertyId} | ${e.streams.map(s => `${s.stream} ${s.kg} kg`).join(', ')} | VERIFIED`) }, { heading: 'On-site processing logs (SELF_REPORTED)', lines: summary.onsite.data.map(l => `${l.date.toISOString()} | ${l.asset} | input ${l.inputKg} kg | output ${l.outputKg} kg | photo ${l.photoId}`) }, { heading: 'Invoices', lines: invoices.map(i => `${i.id} | ${i.periodStart.toISOString().slice(0, 10)} | ${i.status} | INR ${(i.totalPaise / 100).toFixed(2)} | ${i.lines.map(l => l.description).join('; ')}`) }, { heading: 'Gaps and variance', lines: [JSON.stringify(summary.certificateCoverage), JSON.stringify(summary.massBalance)] }];
    sections[0].lines[1] = 'Evidence register, 12-month operational logs, invoice detail and available original registration/authorization/certificate documents. Missing document references remain explicitly listed in the register.';
    const originals: { label: string; bytes: Buffer }[] = [];
    for (const document of documents) {
      if (document.storageKey) originals.push({ label: `${document.type} | ${document.number} | ${document.id}`, bytes: await app.storage.read(document.storageKey) });
    }
    for (const invoice of invoices) {
      originals.push({ label: `Invoice ${invoice.id}`, bytes: await reportPdf(`Invoice | ${society.name}`, [
        { heading: `${invoice.status} | ${invoice.periodStart.toISOString().slice(0, 10)}`, lines: [society.address, `Invoice ${invoice.id}`, `Due ${invoice.dueAt.toISOString()}`] },
        { heading: 'Auditable line items in INR', lines: invoice.lines.map(line => `${line.description} | ${line.quantity} ${line.unit} | rate ${(line.ratePaise / 100).toFixed(2)} | amount ${(line.amountPaise / 100).toFixed(2)} | evidence ${JSON.stringify(line.evidence)}`) },
        { heading: `Total INR ${(invoice.totalPaise / 100).toFixed(2)}`, lines: ['Operational lines are backed by verified pickup and scheduled-stop evidence. Manual payment only.'] },
      ]) });
    }
    const manifest = await reportPdf(`Inspection evidence pack | ${society.name}`, sections);
    let pdf: Buffer;
    try { pdf = await inspectionPdf(manifest, originals); }
    catch { return fail(422, 'DOCUMENT_MERGE_FAILED', 'An original document could not be decoded into the inspection pack. Check the document vault; no partial pack was returned.'); }
    return reply.type('application/pdf').header('Content-Disposition', 'attachment; filename="inspection-pack.pdf"').send(pdf);
  });
}
