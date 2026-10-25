import { z } from 'zod';
import { complaintSchema, complaintTransitionSchema, complaintReopenSchema, complaintStatusSchema, ratingSchema } from '@swachh/contracts';
import { calculateSla, nextScheduledPickup, transitionComplaint, type ComplaintState, type SlaPause } from '@swachh/domain';
import type { Complaint, Prisma } from '@prisma/client';
import { api, authenticate, authorize, dateRange, fail, json, page, pageArgs, pagination, Scope, serialized, uuid, type App, type Db } from './core.js';
import { scheduleInput } from './registry.js';

export interface ComplaintChannel {
  send(db: Db, input: { ulbId: string; complaintId: string; payload: Prisma.InputJsonValue }): Promise<{ status: string }>;
}
export class LocalChannel implements ComplaintChannel {
  async send(db: Db, input: { ulbId: string; complaintId: string; payload: Prisma.InputJsonValue }) {
    const complaint = await db.complaint.findFirst({ where: { ulbId: input.ulbId, id: input.complaintId } });
    if (!complaint) return fail(404, 'NOT_FOUND', 'Local complaint must be persisted before channel dispatch.');
    await db.outboundMessage.create({ data: { ulbId: input.ulbId, channel: 'LOCAL', entityId: complaint.id, payload: input.payload, status: 'RECORDED' } });
    return { status: 'RECORDED_LOCALLY' };
  }
}
export class SwachhataAdapter implements ComplaintChannel {
  async send(db: Db, input: { ulbId: string; complaintId: string; payload: Prisma.InputJsonValue }) {
    await db.outboundMessage.create({ data: { ulbId: input.ulbId, channel: 'SWACHHATA', entityId: input.complaintId, payload: input.payload, status: 'NOT_CONFIGURED' } });
    return { status: 'NOT_CONFIGURED' };
  }
}

export async function complaintFilter(scope: Scope): Promise<Prisma.ComplaintWhereInput> {
  const properties = await scope.db.property.findMany({ where: scope.propertyFilter(), select: { id: true } });
  return { ulbId: scope.ulbId, propertyId: { in: properties.map(p => p.id) }, ...(scope.membership.role === 'RESIDENT' ? { residentId: scope.userId } : {}) };
}
export async function complaintState(_db: Db, row: Complaint): Promise<ComplaintState> {
  return { status: row.status, createdAt: row.createdAt.toISOString(), slaHours: row.slaHours, pauses: row.slaPauses as unknown as SlaPause[], reopenedCount: row.reopenedCount, ...(row.waitingFrom ? { waitingFrom: row.waitingFrom as ComplaintState['waitingFrom'] } : {}), ...(row.resolvedAt ? { resolvedAt: row.resolvedAt.toISOString() } : {}), ...(row.resolutionNote ? { resolutionNote: row.resolutionNote } : {}), ...(row.resolutionPhotoId ? { resolutionPhotoId: row.resolutionPhotoId } : {}), lastTransitionAt: row.updatedAt.toISOString() };
}

export async function operationRoutes(app: App) {
  const router = api(app);
  const resident = authorize('RESIDENT');
  const resolver = authorize('SOCIETY_ADMIN', 'SUPERVISOR', 'ULB_ADMIN', 'SUPER_ADMIN');
  const complaintQuery = pagination.extend({ status: complaintStatusSchema.optional() });
  router.get('/resident/properties', { preHandler: resident, schema: { querystring: pagination.extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() }) } }, async request => {
    const scope = new Scope(request); const query = request.query;
    const where: Prisma.PropertyWhereInput = { AND: [scope.propertyFilter(), { createdAt: dateRange(query), ...(query.societyId ? { societyId: query.societyId } : {}), ...(query.wardId ? { society: { ulbId: scope.ulbId, wardId: query.wardId } } : {}), ...(query.status ? { status: query.status } : {}), ...(query.search ? { OR: [{ unitNo: { contains: query.search, mode: 'insensitive' } }, { block: { contains: query.search, mode: 'insensitive' } }] } : {}) }] };
    if (query.cursor && !await app.db.property.findFirst({ where: { AND: [where, { id: query.cursor }] }, select: { id: true } })) return fail(404, 'NOT_FOUND', 'Property cursor not found in this scope and filter.');
    return page(await app.db.property.findMany({ where, select: { id: true, societyId: true, unitNo: true, block: true, floor: true, latitude: true, longitude: true, status: true, society: { select: { id: true, name: true, wardId: true } } }, ...pageArgs(query) }), query.limit);
  });
  router.get('/resident/schedule', { preHandler: resident }, async request => {
    const scope = new Scope(request);
    const properties = await app.db.property.findMany({ where: scope.propertyFilter(), select: { id: true, societyId: true, unitNo: true, block: true } });
    const schedules = await app.db.schedule.findMany({ where: { ulbId: scope.ulbId, societyId: { in: properties.map(p => p.societyId) }, active: true } });
    const tips = { WET: 'Drain liquids. Keep food waste separate.', DRY: 'Keep paper, metal and plastic clean and dry.', SANITARY: 'Wrap sanitary waste securely and mark the bag.', SPECIAL_CARE: 'Keep batteries, bulbs and hazardous household items separate.' };
    const data = properties.flatMap(property => schedules.filter(s => s.societyId === property.societyId).map(schedule => ({ id: schedule.id, propertyId: property.id, property, stream: schedule.stream, ...nextScheduledPickup(scheduleInput(schedule), new Date().toISOString()), preparationTip: tips[schedule.stream] }))).filter(item => 'start' in item).sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
    return { data, nextPickup: data[0] ?? null };
  });
  router.get('/resident/pickups', { preHandler: resident, schema: { querystring: pagination } }, async request => {
    const scope = new Scope(request);
    const where = await scope.pickupFilter();
    const rows = await app.db.pickupEvent.findMany({ where: { ...where, capturedAt: dateRange(request.query), ...(request.query.status && ['VERIFIED', 'NEEDS_REVIEW', 'REJECTED'].includes(request.query.status) ? { status: request.query.status as 'VERIFIED' } : {}) }, include: { streams: true }, ...pageArgs(request.query) });
    return page(rows, request.query.limit);
  });
  router.get('/resident/pickups/:id', { preHandler: resident, schema: { params: z.object({ id: uuid }).strict() } }, async request => {
    const scope = new Scope(request); const row = await scope.pickup(request.params.id);
    const photos = await app.db.photo.findMany({ where: { ulbId: scope.ulbId, pickupEventId: row.id, status: 'CONFIRMED' } });
    const collector = await app.db.collector.findFirst({ where: { ulbId: scope.ulbId, id: row.collectorId } });
    const user = collector ? await app.db.user.findUnique({ where: { id: collector.userId }, select: { name: true } }) : null;
    return { ...row, collector: user, photos: await Promise.all(photos.map(async p => ({ id: p.id, kind: p.kind, stream: p.stream, sha256: p.sha256, url: await app.storage.url(p.storageKey, 'GET') }))), rating: await app.db.rating.findFirst({ where: { ulbId: scope.ulbId, pickupEventId: row.id, residentId: scope.userId } }) };
  });
  const ratingParams = z.object({ id: uuid }).strict();
  router.post('/resident/pickups/:id/ratings', { preHandler: resident, schema: { params: ratingParams, body: ratingSchema } }, async (request, reply) => {
    const scope = new Scope(request); const pickup = await scope.pickup(request.params.id);
    if (pickup.status !== 'VERIFIED' || pickup.exceptionCode) return fail(422, 'PICKUP_NOT_VERIFIED', 'Only verified collections can be rated.');
    const row = await app.db.$transaction(async tx => {
      const result = await tx.rating.create({ data: { ulbId: scope.ulbId, pickupEventId: pickup.id, residentId: scope.userId, ...request.body } });
      await new Scope(request, tx).audit('PICKUP_RATED', 'Rating', result.id, undefined, result); return result;
    });
    return reply.code(201).send(row);
  });
  router.patch('/resident/pickups/:id/ratings', { preHandler: resident, schema: { params: ratingParams, body: ratingSchema } }, async request => {
    const scope = new Scope(request); await scope.pickup(request.params.id);
    const rating = await app.db.rating.findFirst({ where: { ulbId: scope.ulbId, pickupEventId: request.params.id, residentId: scope.userId } });
    if (!rating) return fail(404, 'NOT_FOUND', 'Rating not found.');
    if (Date.now() - rating.createdAt.getTime() > 86400000) return fail(422, 'RATING_EDIT_WINDOW', 'Ratings can be edited for 24 hours.');
    return app.db.$transaction(async tx => {
      const row = await tx.rating.update({ where: { id: rating.id, ulbId: scope.ulbId }, data: request.body });
      await new Scope(request, tx).audit('RATING_EDITED', 'Rating', row.id, rating, row); return row;
    });
  });
  router.get('/complaint-categories', { preHandler: authenticate }, async request => ({ data: await app.db.complaintCategory.findMany({ where: { ulbId: new Scope(request).ulbId, active: true }, orderBy: { name: 'asc' } }) }));
  router.post('/resident/complaints', { preHandler: resident, schema: { body: complaintSchema } }, async (request, reply) => {
    const scope = new Scope(request); const property = await scope.property(request.body.propertyId);
    if (request.body.pickupEventId) {
      const pickup = await scope.pickup(request.body.pickupEventId);
      if (pickup.propertyId !== property.id) return fail(422, 'PICKUP_PROPERTY_MISMATCH', 'Pickup must belong to the complaint property.');
    }
    const category = await app.db.complaintCategory.findFirst({ where: { id: request.body.categoryId, ulbId: scope.ulbId, active: true } });
    if (!category) return fail(422, 'CATEGORY_INVALID', 'Select an active category for this ULB.');
    await scope.photo(request.body.photoId);
    const now = new Date(); const sla = calculateSla({ createdAt: now.toISOString(), slaHours: category.slaHours, pauses: [] }, now.toISOString());
    const row = await app.db.$transaction(async tx => {
      const complaint = await tx.complaint.create({ data: { ...request.body, ulbId: scope.ulbId, societyId: property.societyId, residentId: scope.userId, slaHours: category.slaHours, slaDueAt: new Date(sla.dueAt), createdAt: now, events: { create: { ulbId: scope.ulbId, actorId: scope.userId, toStatus: 'OPEN', note: 'Complaint created' } } } });
      const scoped = new Scope(request, tx); await scoped.audit('COMPLAINT_CREATED', 'Complaint', complaint.id, undefined, complaint);
      await scoped.notify('COMPLAINT_CREATED', complaint.id, { complaintId: complaint.id, slaDueAt: complaint.slaDueAt });
      await new LocalChannel().send(tx, { ulbId: scope.ulbId, complaintId: complaint.id, payload: json(complaint) });
      return complaint;
    });
    return reply.code(201).send(row);
  });
  router.get('/resident/complaints', { preHandler: resident, schema: { querystring: complaintQuery } }, async request => {
    const scope = new Scope(request);
    const rows = await app.db.complaint.findMany({ where: { ...await complaintFilter(scope), createdAt: dateRange(request.query), ...(request.query.status ? { status: request.query.status } : {}) }, include: { events: { orderBy: { createdAt: 'asc' } } }, ...pageArgs(request.query) });
    const categories = await app.db.complaintCategory.findMany({ where: { ulbId: scope.ulbId } });
    return page(rows.map(row => ({ ...row, category: categories.find(c => c.id === row.categoryId) })), request.query.limit);
  });
  router.get('/societies/:societyId/complaints', { preHandler: resolver, schema: { params: z.object({ societyId: uuid }).strict(), querystring: complaintQuery } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId);
    const rows = await app.db.complaint.findMany({ where: { ...await complaintFilter(scope), societyId: request.params.societyId, createdAt: dateRange(request.query), ...(request.query.status ? { status: request.query.status } : {}) }, include: { events: true }, ...pageArgs(request.query) });
    const categories = await app.db.complaintCategory.findMany({ where: { ulbId: scope.ulbId } });
    return page(rows.map(row => ({ ...row, category: categories.find(c => c.id === row.categoryId) })), request.query.limit);
  });
  router.get('/complaints/:id', { preHandler: authorize('RESIDENT', 'SOCIETY_ADMIN', 'SUPERVISOR', 'ULB_ADMIN', 'SUPER_ADMIN'), schema: { params: z.object({ id: uuid }).strict() } }, async request => {
    const scope = new Scope(request);
    const complaint = await app.db.complaint.findFirst({ where: { AND: [await complaintFilter(scope), { id: request.params.id }] }, include: { events: { orderBy: { createdAt: 'asc' } } } });
    if (!complaint) return fail(404, 'NOT_FOUND', 'Complaint not found.');
    const photoIds = [complaint.photoId, complaint.resolutionPhotoId].filter((id): id is string => Boolean(id));
    const photos = await app.db.photo.findMany({ where: { id: { in: photoIds }, ulbId: scope.ulbId, status: 'CONFIRMED' } });
    return { ...complaint, category: await app.db.complaintCategory.findFirst({ where: { ulbId: scope.ulbId, id: complaint.categoryId } }), sla: calculateSla(await complaintState(app.db, complaint), new Date().toISOString()), photos: await Promise.all(photos.map(async p => ({ id: p.id, kind: p.kind, url: await app.storage.url(p.storageKey, 'GET') }))) };
  });

  async function transition(request: Parameters<typeof authenticate>[0], id: string, body: z.infer<typeof complaintTransitionSchema>) {
    const scope = new Scope(request);
    return serialized(app.db, `complaint:${id}`, async tx => {
      const scoped = new Scope(request, tx);
      const row = await tx.complaint.findFirst({ where: { AND: [await complaintFilter(scoped), { id }] } });
      if (!row) return fail(404, 'NOT_FOUND', 'Complaint not found.');
      if (body.status === 'RESOLVED') await scoped.photo(body.photoId!, 'RESOLUTION');
      const now = new Date().toISOString(); let result;
      try { result = transitionComplaint(await complaintState(tx, row), { to: body.status, at: now, actorRole: scope.membership.role, note: body.note, photoId: body.photoId }); }
      catch (error) { return fail(422, 'COMPLAINT_TRANSITION_INVALID', error instanceof Error ? error.message : 'Invalid transition.'); }
      const state = result.complaint;
      const sla = calculateSla(state, now);
      const updated = await tx.complaint.update({ where: { id: row.id, ulbId: scope.ulbId }, data: { status: state.status, reopenedCount: state.reopenedCount, resolvedAt: state.resolvedAt ? new Date(state.resolvedAt) : null, resolutionNote: state.resolutionNote ?? null, resolutionPhotoId: state.resolutionPhotoId ?? null, waitingFrom: state.waitingFrom ?? null, slaPauses: json(state.pauses), pausedAt: sla.paused ? new Date(state.pauses.at(-1)!.startedAt) : null, pausedSeconds: Math.floor(sla.pausedMs / 1000), slaDueAt: new Date(sla.dueAt), escalationLevel: result.escalation === 'ULB_ADMIN' ? 2 : result.escalation === 'SUPERVISOR' ? Math.max(1, row.escalationLevel) : row.escalationLevel, events: { create: { ulbId: scope.ulbId, actorId: scope.userId, fromStatus: row.status, toStatus: state.status, note: body.note ?? `Moved to ${state.status}` } } } });
      await scoped.audit('COMPLAINT_TRANSITION', 'Complaint', row.id, row, updated);
      await scoped.notify(`COMPLAINT_${result.escalation === 'ULB_ADMIN' ? 'ESCALATED' : state.status}`, `${row.id}:${updated.updatedAt.toISOString()}`, { complaintId: row.id, status: state.status, escalation: result.escalation }, row.residentId);
      return { ...updated, escalation: result.escalation };
    });
  }
  router.patch('/complaints/:id', { preHandler: resolver, schema: { params: z.object({ id: uuid }).strict(), body: complaintTransitionSchema } }, request => transition(request, request.params.id, request.body));
  router.patch('/societies/:societyId/complaints/:id', { preHandler: resolver, schema: { params: z.object({ societyId: uuid, id: uuid }).strict(), body: complaintTransitionSchema } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId);
    if (!await app.db.complaint.findFirst({ where: { id: request.params.id, societyId: request.params.societyId, ulbId: scope.ulbId } })) return fail(404, 'NOT_FOUND', 'Complaint not found.');
    return transition(request, request.params.id, request.body);
  });
  router.post('/resident/complaints/:id/reopen', { preHandler: resident, schema: { params: z.object({ id: uuid }).strict(), body: complaintReopenSchema } }, request => transition(request, request.params.id, { status: 'REOPENED', note: request.body.note }));
  router.post('/complaints/:id/swachhata', { preHandler: resolver, schema: { params: z.object({ id: uuid }).strict(), body: z.object({}).strict() } }, async request => {
    const scope = new Scope(request);
    const row = await app.db.complaint.findFirst({ where: { AND: [await complaintFilter(scope), { id: request.params.id }] } });
    if (!row) return fail(404, 'NOT_FOUND', 'Complaint not found.');
    const result = await new SwachhataAdapter().send(app.db, { ulbId: scope.ulbId, complaintId: row.id, payload: json({ id: row.id, categoryId: row.categoryId, description: row.description, status: row.status }) });
    request.log.info({ complaintId: row.id, status: result.status }, 'Swachhata outbound message retained locally');
    return fail(501, 'NOT_CONFIGURED', 'Outbound payload was retained locally. Swachhata delivery is not configured.');
  });
  router.get('/notifications', { preHandler: authenticate, schema: { querystring: pagination } }, async request => {
    const scope = new Scope(request);
    return page(await app.db.notification.findMany({ where: { ulbId: scope.ulbId, userId: scope.userId, channel: 'IN_APP', status: 'DELIVERED' }, ...pageArgs(request.query) }), request.query.limit);
  });
  router.patch('/notifications/:id', { preHandler: authenticate, schema: { params: z.object({ id: uuid }).strict(), body: z.object({ read: z.literal(true) }).strict() } }, async request => {
    const scope = new Scope(request);
    const row = await app.db.notification.updateMany({ where: { id: request.params.id, ulbId: scope.ulbId, userId: scope.userId }, data: { readAt: new Date() } });
    if (!row.count) return fail(404, 'NOT_FOUND', 'Notification not found.'); return { status: 'READ' };
  });
}
