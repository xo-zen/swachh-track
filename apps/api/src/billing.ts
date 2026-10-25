import { z } from 'zod';
import { STREAMS, invoiceGenerateSchema, invoiceStatusSchema, paymentSchema, invoiceDisputeSchema } from '@swachh/contracts';
import { calculateInvoice } from '@swachh/domain';
import { api, authorize, dateRange, fail, hash, idempotencyHeader, json, page, pageArgs, pagination, Scope, serialized, societyParams, societyIdParams, type App } from './core.js';
import type { Invoice, Payment } from '@prisma/client';
import { dataset } from './analytics.js';
import { reportPdf } from './pdf.js';
import { csv } from './csv.js';

export function accountRows(invoices: (Invoice & { payments: Payment[] })[]) {
  return invoices.flatMap(invoice => [{ recordType: 'INVOICE', id: invoice.id, invoiceId: invoice.id, societyId: invoice.societyId, date: invoice.periodStart, status: invoice.status, amountPaise: invoice.totalPaise, reference: '' }, ...invoice.payments.map(payment => ({ recordType: 'PAYMENT', id: payment.id, invoiceId: invoice.id, societyId: invoice.societyId, date: payment.paidAt, status: 'RECORDED', amountPaise: payment.amountPaise, reference: payment.reference }))]);
}

const admin = authorize('SOCIETY_ADMIN', 'ULB_ADMIN', 'SUPER_ADMIN');
export async function billingRoutes(app: App) {
  const router = api(app);
  router.get('/societies/:societyId/invoices/export.csv', { preHandler: admin, schema: { params: societyParams, querystring: pagination.pick({ from: true, to: true, status: true, societyId: true, wardId: true }).extend({ status: invoiceStatusSchema.optional() }) } }, async (request, reply) => {
    const scope = new Scope(request); const society = await scope.society(request.params.societyId); await scope.feature('billing_v1');
    const query = request.query;
    const matches = (!query.societyId || query.societyId === society.id) && (!query.wardId || query.wardId === society.wardId);
    const invoices = await app.db.invoice.findMany({ where: { ulbId: scope.ulbId, societyId: { in: matches ? [society.id] : [] }, periodStart: dateRange(query), ...(query.status ? { status: query.status } : {}) }, include: { payments: { where: { ulbId: scope.ulbId }, orderBy: { id: 'asc' }, take: 10001 } }, orderBy: { id: 'asc' }, take: 10001 });
    const rows = accountRows(invoices);
    if (rows.length > 10000) return fail(413, 'EXPORT_TOO_LARGE', 'Narrow the invoice period to export at most 10,000 invoice and payment records.');
    await scope.audit('EXPORT_DOWNLOADED', 'Society', society.id, undefined, { type: 'accounts', format: 'csv', count: rows.length, filters: query });
    return reply.header('Cache-Control', 'private, no-store').header('Content-Disposition', 'attachment; filename="accounts.csv"').type('text/csv; charset=utf-8').send(csv(['recordType', 'id', 'invoiceId', 'societyId', 'date', 'status', 'amountPaise', 'reference'], rows));
  });
  router.get('/societies/:societyId/invoices', { preHandler: admin, schema: { params: societyParams, querystring: pagination } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('billing_v1');
    return page(await app.db.invoice.findMany({ where: { ulbId: scope.ulbId, societyId: request.params.societyId, ...(request.query.status ? { status: request.query.status } : {}) }, include: { lines: true, payments: true }, ...pageArgs(request.query) }), request.query.limit);
  });
  router.post('/societies/:societyId/invoices/generate', { preHandler: admin, schema: { params: societyParams, body: invoiceGenerateSchema } }, async (request, reply) => {
    const scope = new Scope(request); const society = await scope.society(request.params.societyId); await scope.feature('billing_v1');
    const key = idempotencyHeader(request); const requestHash = hash(JSON.stringify({ societyId: society.id, ...request.body }));
    const { periodStart, periodEnd, dueDate } = request.body;
    const monthEnd = new Date(Date.UTC(Number(periodStart.slice(0, 4)), Number(periodStart.slice(5, 7)), 0)).toISOString().slice(0, 10);
    if (!periodStart.endsWith('-01') || periodEnd !== monthEnd) return fail(422, 'MONTH_REQUIRED', 'Invoice period must be one complete calendar month.');
    const result = await serialized(app.db, `invoice-generation:${scope.ulbId}`, async tx => {
      const idem = { ulbId: scope.ulbId, actorId: scope.userId, operation: 'INVOICE_GENERATE', key };
      const old = await tx.idempotencyKey.findUnique({ where: { ulbId_actorId_operation_key: idem } });
      if (old) { if (old.requestHash !== requestHash) return fail(409, 'IDEMPOTENCY_MISMATCH', 'Key belongs to a different invoice request.', { original: old.response }); return old.response; }
      const prior = await tx.invoice.findUnique({ where: { ulbId_societyId_periodStart: { ulbId: scope.ulbId, societyId: society.id, periodStart: new Date(periodStart) } }, include: { lines: true } });
      if (prior) return fail(409, 'INVOICE_EXISTS', 'An invoice already exists for this month.', { original: prior });
      const from = new Date(`${periodStart}T00:00:00+05:30`); const to = new Date(`${periodEnd}T23:59:59.999+05:30`);
      const allData = await dataset(tx, scope.ulbId, [society.id], from, to);
      const stops = allData.stops.filter(stop => Date.parse(stop.windowEnd) <= Date.now());
      const stopIds = new Set(stops.map(stop => stop.id));
      const data = { stops, events: allData.events.filter(event => stopIds.has(event.routeStopId)) };
      const activeFlats = await tx.property.count({ where: { ulbId: scope.ulbId, societyId: society.id, status: 'ACTIVE', deletedAt: null } });
      const settings = society.settings as Record<string, number>;
      let calculation;
      try { calculation = calculateInvoice({ ...data, activeFlats, activeFlatsQueryRef: JSON.stringify({ table: 'Property', ulbId: scope.ulbId, societyId: society.id, status: 'ACTIVE', asOf: new Date().toISOString() }), rates: { perFlatPaise: settings.flatFeePaise ?? 0, perVerifiedStopPaise: settings.pickupFeePaise ?? 0, handlingPaisePerKg: Object.fromEntries(STREAMS.map(s => [s, settings.handlingFeePaisePerKg ?? 0])), missedStopDeductionPaise: settings.missedDeductionPaise ?? 0 }, adjustments: request.body.adjustmentPaise !== undefined ? [{ amountPaise: request.body.adjustmentPaise, reason: request.body.adjustmentReason! }] : [] }); }
      catch (error) { return fail(422, 'INVOICE_CALCULATION', error instanceof Error ? error.message : 'Invoice cannot be calculated.'); }
      if ([calculation.totalPaise, calculation.subtotalPaise, calculation.deductionsPaise, ...calculation.lines.map(l => Math.abs(l.amountPaise))].some(n => n > 2147483647)) return fail(422, 'INVOICE_LIMIT', 'Invoice exceeds the supported integer-paise amount.');
      const invoice = await tx.invoice.create({ data: { ulbId: scope.ulbId, societyId: society.id, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd), dueAt: new Date(`${dueDate}T23:59:59+05:30`), subtotalPaise: calculation.subtotalPaise, deductionsPaise: calculation.deductionsPaise, totalPaise: calculation.totalPaise, status: 'DRAFT', lines: { create: calculation.lines.map(line => ({ ulbId: scope.ulbId, type: line.type, description: line.description, quantity: line.quantity, unit: line.unit, ratePaise: line.ratePaise, amountPaise: line.amountPaise, evidence: json({ eventIds: line.eventIds, stopIds: line.stopIds, aggregateQueryRef: line.aggregateQueryRef, stream: line.stream, generatedAt: new Date().toISOString() }) })) } }, include: { lines: true } });
      const scoped = new Scope(request, tx); await scoped.audit('INVOICE_GENERATED', 'Invoice', invoice.id, undefined, invoice);
      await scoped.notify('INVOICE_DRAFT', invoice.id, { invoiceId: invoice.id, totalPaise: invoice.totalPaise });
      await tx.idempotencyKey.create({ data: { ...idem, requestHash, response: json(invoice), responseCode: 201 } });
      return json(invoice);
    });
    return reply.code(201).send(result);
  });
  router.get('/societies/:societyId/invoices/:id', { preHandler: admin, schema: { params: societyIdParams } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('billing_v1');
    const invoice = await app.db.invoice.findFirst({ where: { ulbId: scope.ulbId, societyId: request.params.societyId, id: request.params.id }, include: { lines: true, payments: true } });
    return invoice ?? fail(404, 'NOT_FOUND', 'Invoice not found.');
  });
  router.post('/societies/:societyId/invoices/:id/issue', { preHandler: admin, schema: { params: societyIdParams, body: z.object({}).strict() } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('billing_v1');
    return serialized(app.db, `invoice-state:${request.params.id}`, async tx => {
      const row = await tx.invoice.findFirst({ where: { id: request.params.id, societyId: request.params.societyId, ulbId: scope.ulbId } });
      if (!row) return fail(404, 'NOT_FOUND', 'Invoice not found.');
      if (row.status !== 'DRAFT') return fail(409, 'INVOICE_STATE', 'Only a draft invoice can be issued.');
      const result = await tx.invoice.update({ where: { id: row.id, ulbId: scope.ulbId }, data: { status: 'ISSUED', issuedAt: new Date() } });
      const scoped = new Scope(request, tx); await scoped.audit('INVOICE_ISSUED', 'Invoice', row.id, row, result); await scoped.notify('INVOICE_ISSUED', row.id, { invoiceId: row.id }); return result;
    });
  });
  router.get('/societies/:societyId/invoices/:id.pdf', { preHandler: admin, schema: { params: societyIdParams } }, async (request, reply) => {
    const scope = new Scope(request); const society = await scope.society(request.params.societyId); await scope.feature('billing_v1');
    const invoice = await app.db.invoice.findFirst({ where: { id: request.params.id, ulbId: scope.ulbId, societyId: society.id }, include: { lines: true } });
    if (!invoice) return fail(404, 'NOT_FOUND', 'Invoice not found.');
    const settings = society.settings as Record<string, string>;
    const pdf = await reportPdf(`Invoice | ${society.name}`, [{ heading: `${invoice.status} | ${invoice.id}`, lines: [`Period ${invoice.periodStart.toISOString().slice(0, 10)} to ${invoice.periodEnd.toISOString().slice(0, 10)}`, `Due ${invoice.dueAt.toISOString()}`, society.address] }, { heading: 'Line items (INR)', lines: invoice.lines.map(l => `${l.description}: ${l.quantity} ${l.unit} x ${(l.ratePaise / 100).toFixed(2)} = ${(l.amountPaise / 100).toFixed(2)} | Evidence: ${JSON.stringify(l.evidence)}`) }, { heading: `Total INR ${(invoice.totalPaise / 100).toFixed(2)}`, lines: [settings.paymentInstructions ?? 'Contact your society administrator for manual payment instructions.', 'Operations-based lines are backed by verified pickups and auditable scheduled-stop evidence. No payment gateway is used.'] }]);
    return reply.type('application/pdf').header('Content-Disposition', `attachment; filename="invoice-${invoice.id}.pdf"`).send(pdf);
  });
  router.post('/societies/:societyId/invoices/:id/mark-paid', { preHandler: admin, schema: { params: societyIdParams, body: paymentSchema } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('billing_v1');
    return serialized(app.db, `invoice-state:${request.params.id}`, async tx => {
      const row = await tx.invoice.findFirst({ where: { id: request.params.id, ulbId: scope.ulbId, societyId: request.params.societyId }, include: { payments: true } });
      if (!row) return fail(404, 'NOT_FOUND', 'Invoice not found.');
      if (row.status !== 'ISSUED') return fail(422, 'INVOICE_STATE', 'Issue the invoice before recording payment.');
      const paid = row.payments.reduce((sum, p) => sum + p.amountPaise, 0);
      if (request.body.amountPaise + paid > row.totalPaise || Date.parse(request.body.paidAt) > Date.now() + 300000) return fail(422, 'PAYMENT_INVALID', 'Payment exceeds the balance or has a future date.');
      await tx.payment.create({ data: { ...request.body, ulbId: scope.ulbId, invoiceId: row.id, method: 'MANUAL', recordedBy: scope.userId, paidAt: new Date(request.body.paidAt) } });
      const fullyPaid = request.body.amountPaise + paid === row.totalPaise;
      const result = await tx.invoice.update({ where: { id: row.id, ulbId: scope.ulbId }, data: { status: fullyPaid ? 'PAID' : 'ISSUED', paidAt: fullyPaid ? new Date(request.body.paidAt) : null }, include: { payments: true, lines: true } });
      await new Scope(request, tx).audit('PAYMENT_RECORDED', 'Invoice', row.id, row, result); return result;
    });
  });
  router.post('/societies/:societyId/invoices/:id/disputes', { preHandler: admin, schema: { params: societyIdParams, body: invoiceDisputeSchema } }, async (request, reply) => {
    const scope = new Scope(request); await scope.society(request.params.societyId); await scope.feature('billing_v1');
    const line = await app.db.invoiceLine.findFirst({ where: { id: request.body.lineId, ulbId: scope.ulbId, invoiceId: request.params.id, invoice: { societyId: request.params.societyId } } });
    if (!line) return fail(404, 'NOT_FOUND', 'Invoice line not found.');
    const row = await app.db.$transaction(async tx => {
      const dispute = await tx.invoiceDispute.create({ data: { ulbId: scope.ulbId, invoiceId: request.params.id, lineId: line.id, actorId: scope.userId, reason: request.body.reason } });
      const scoped = new Scope(request, tx); await scoped.audit('INVOICE_DISPUTED', 'InvoiceDispute', dispute.id, undefined, dispute);
      const officer = await tx.membership.findFirst({ where: { ulbId: scope.ulbId, role: 'ULB_ADMIN', status: 'ACTIVE' } });
      await scoped.notify('INVOICE_DISPUTED', dispute.id, { invoiceId: request.params.id, disputeId: dispute.id }, officer?.userId ?? scope.userId); return dispute;
    });
    return reply.code(201).send(row);
  });
}
