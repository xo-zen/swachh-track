import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pickupSchema, supervisorReviewSchema, verificationStatusSchema, type PickupInput } from '@swachh/contracts';
import { signQrToken, verifyPickup, type PhotoEvidence } from '@swachh/domain';
import type { Prisma, Route, RouteStop, Property } from '@prisma/client';
import { api, authorize, dateRange, fail, hash, idempotencyHeader, istDate, json, page, pageArgs, pagination, Scope, serialized, societyParams, uuid, type App } from './core.js';

const collectorGuard = authorize('COLLECTOR');
const resultFor = (event: { id: string; clientUuid: string; status: string; verificationScore: number; verificationReasons: unknown }) => ({ client_uuid: event.clientUuid, id: event.id, status: event.status, verificationScore: event.verificationScore, verificationReasons: event.verificationReasons });

export async function pickupRoutes(app: App) {
  const router = api(app);
  const historyQuery = pagination.extend({ status: verificationStatusSchema.optional() });
  async function history(scope: Scope, query: z.infer<typeof historyQuery>, societyId?: string) {
    const capturedAt = dateRange(query);
    const societies = await scope.db.society.findMany({ where: { AND: [scope.societyFilter(), ...(societyId ? [{ id: societyId }] : []), ...(query.societyId ? [{ id: query.societyId }] : []), ...(query.wardId ? [{ wardId: query.wardId }] : [])] }, select: { id: true } });
    const where: Prisma.PickupEventWhereInput = { AND: [await scope.pickupFilter(), { societyId: { in: societies.map(s => s.id) }, capturedAt, ...(query.status ? { status: query.status } : {}) }] };
    if (query.cursor && !await scope.db.pickupEvent.findFirst({ where: { AND: [where, { id: query.cursor }] }, select: { id: true } })) return fail(404, 'NOT_FOUND', 'Pickup cursor not found in this scope and filter.');
    return page(await scope.db.pickupEvent.findMany({ where, include: { streams: { where: { ulbId: scope.ulbId } } }, ...pageArgs(query) }), query.limit);
  }
  async function detail(scope: Scope, id: string) {
    const row = await scope.pickup(id);
    const property = await scope.property(row.propertyId);
    const photos = await scope.db.photo.findMany({ where: { ulbId: scope.ulbId, pickupEventId: row.id, status: 'CONFIRMED' } });
    return { ...row, property: { id: property.id, societyId: property.societyId, unitNo: property.unitNo, block: property.block, latitude: property.latitude, longitude: property.longitude, status: property.status }, photos: await Promise.all(photos.map(async p => ({ id: p.id, kind: p.kind, stream: p.stream, sha256: p.sha256, width: p.width, height: p.height, url: await app.storage.url(p.storageKey, 'GET'), expiresIn: 300 }))) };
  }
  router.get('/societies/:societyId/pickups', { preHandler: authorize('SOCIETY_ADMIN', 'ULB_ADMIN', 'SUPER_ADMIN'), schema: { params: societyParams, querystring: historyQuery } }, async request => {
    const scope = new Scope(request); await scope.society(request.params.societyId);
    return history(scope, request.query, request.params.societyId);
  });
  router.get('/ulb/:ulbId/pickups', { preHandler: authorize('ULB_ADMIN', 'SUPER_ADMIN'), schema: { params: z.object({ ulbId: uuid }).strict(), querystring: historyQuery } }, async request => {
    const scope = new Scope(request); scope.ulb(request.params.ulbId);
    return history(scope, request.query);
  });
  router.get('/pickups/:id', { preHandler: authorize('SOCIETY_ADMIN', 'ULB_ADMIN', 'SUPER_ADMIN'), schema: { params: z.object({ id: uuid }).strict() } }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return detail(new Scope(request), request.params.id);
  });
  router.post('/collector/devices', { preHandler: collectorGuard, schema: { body: z.object({ deviceId: z.string().min(1).max(200), platform: z.string().min(1).max(20), appVersion: z.string().min(1).max(50) }).strict() } }, async request => {
    const scope = new Scope(request); const collector = await scope.collector();
    return serialized(app.db, `device:${collector.id}`, async tx => {
      const existing = await tx.device.findUnique({ where: { ulbId_deviceId: { ulbId: scope.ulbId, deviceId: request.body.deviceId } } });
      if (existing && (existing.collectorId !== collector.id || existing.revokedAt)) return fail(403, 'DEVICE_BOUND_OR_REVOKED', 'Device is bound to another collector or was revoked.');
      if (!existing && await tx.device.count({ where: { ulbId: scope.ulbId, collectorId: collector.id, revokedAt: null } }) >= 2) return fail(409, 'DEVICE_LIMIT', 'A collector may have at most two active devices.');
      return tx.device.upsert({ where: { ulbId_deviceId: { ulbId: scope.ulbId, deviceId: request.body.deviceId } }, update: { platform: request.body.platform, appVersion: request.body.appVersion, lastSeenAt: new Date() }, create: { ...request.body, ulbId: scope.ulbId, collectorId: collector.id } });
    });
  });
  router.post('/supervisor/devices/:id/revoke', { preHandler: authorize('SUPERVISOR', 'ULB_ADMIN', 'SUPER_ADMIN'), schema: { params: z.object({ id: uuid }).strict(), body: z.object({ reason: z.string().min(1).max(2000) }).strict() } }, async request => {
    const scope = new Scope(request);
    const device = await app.db.device.findFirst({ where: { ulbId: scope.ulbId, id: request.params.id } });
    if (!device) return fail(404, 'NOT_FOUND', 'Device not found.');
    const collector = await app.db.collector.findFirst({ where: { ulbId: scope.ulbId, id: device.collectorId, ...(scope.membership.role === 'SUPERVISOR' ? { contractorId: scope.membership.contractorId ?? '' } : {}) } });
    if (!collector) return fail(404, 'NOT_FOUND', 'Device not found.');
    return app.db.$transaction(async tx => {
      const result = await tx.device.update({ where: { id: device.id, ulbId: scope.ulbId }, data: { revokedAt: new Date() } });
      await new Scope(request, tx).audit('DEVICE_REVOKED', 'Device', device.id, undefined, { reason: request.body.reason }); return result;
    });
  });

  async function routeView(scope: Scope, route: Route & { stops: (RouteStop & { property: Property })[] }) {
    const previous = await app.db.pickupEvent.findMany({ where: { ulbId: scope.ulbId, propertyId: { in: route.stops.map(s => s.propertyId) }, status: 'VERIFIED' }, orderBy: { capturedAt: 'desc' }, include: { streams: true } });
    return { id: route.id, name: route.name, date: route.date.toISOString().slice(0, 10), stops: route.stops.map(stop => {
      const property = stop.property;
      const qrToken = signQrToken(property.id, { version: app.config.QR_SECRET_VERSION, secret: app.config.QR_SECRET });
      return { id: stop.id, propertyId: property.id, property: { id: property.id, unitNo: property.unitNo, block: property.block, latitude: property.latitude, longitude: property.longitude, propertyCode: property.propertyCode, qrToken: hash(qrToken) === property.qrTokenHash ? qrToken : null }, sequence: stop.sequence, windowStart: stop.windowStart, windowEnd: stop.windowEnd, streams: stop.streams, status: stop.status, lastPickup: previous.find(p => p.propertyId === property.id) ?? null };
    }) };
  }
  router.get('/collector/today', { preHandler: collectorGuard }, async request => {
    const scope = new Scope(request); const collector = await scope.collector();
    const routes = await app.db.route.findMany({ where: { ulbId: scope.ulbId, collectorId: collector.id, date: new Date(istDate()), status: 'ACTIVE' }, include: { stops: { where: { ulbId: scope.ulbId }, include: { property: true }, orderBy: { sequence: 'asc' } } }, orderBy: { name: 'asc' } });
    return { routes: await Promise.all(routes.map(route => routeView(scope, route))) };
  });
  router.get('/collector/routes/:routeId/stops', { preHandler: collectorGuard, schema: { params: z.object({ routeId: uuid }).strict() } }, async request => {
    const scope = new Scope(request); const collector = await scope.collector();
    const route = await app.db.route.findFirst({ where: { id: request.params.routeId, ulbId: scope.ulbId, collectorId: collector.id, date: new Date(istDate()), status: 'ACTIVE' }, include: { stops: { where: { ulbId: scope.ulbId }, include: { property: true }, orderBy: { sequence: 'asc' } } } });
    if (!route) return fail(404, 'NOT_FOUND', 'No current assigned route found.');
    return routeView(scope, route);
  });

  // Envelope validation happens first; each strict event is validated inside the transaction so
  // rejected UUIDs (including missing weights) remain durable and idempotently replayable.
  router.post('/collector/pickups/batch', { preHandler: collectorGuard, schema: { body: z.object({ events: z.array(z.unknown()).min(1).max(500) }).strict() }, bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const scope = new Scope(request); const collector = await scope.collector();
    const key = idempotencyHeader(request); const requestHash = hash(JSON.stringify(request.body));
    const inputIds = request.body.events.map(event => {
      const id = z.object({ client_uuid: uuid }).passthrough().safeParse(event);
      if (!id.success) return fail(422, 'CLIENT_UUID_REQUIRED', 'Every event requires a valid client_uuid, including rejected submissions.');
      return id.data.client_uuid;
    });
    if (new Set(inputIds).size !== inputIds.length) return fail(409, 'DUPLICATE_UUID_IN_BATCH', 'An event UUID occurs more than once in this batch.');
    const response = await serialized(app.db, `pickup-sync:${scope.ulbId}`, async tx => {
      const idempotencyWhere = { ulbId: scope.ulbId, actorId: scope.userId, operation: 'PICKUP_BATCH', key };
      const saved = await tx.idempotencyKey.findUnique({ where: { ulbId_actorId_operation_key: idempotencyWhere } });
      if (saved) {
        if (saved.requestHash !== requestHash) return fail(409, 'IDEMPOTENCY_MISMATCH', 'This key belongs to a different payload.', { original: saved.response });
        return { code: saved.responseCode, body: saved.response };
      }
      const existing = await tx.pickupEvent.findMany({ where: { ulbId: scope.ulbId, clientUuid: { in: inputIds } } });
      const rejected = await tx.rejectedSubmission.findMany({ where: { ulbId: scope.ulbId, clientUuid: { in: inputIds } } });
      if (existing.length || rejected.length) return fail(409, 'CLIENT_UUID_EXISTS', 'A client UUID already belongs to another batch.', { original: [...existing.filter(e => e.collectorId === collector.id).map(resultFor), ...rejected.filter(e => e.actorId === scope.userId).map(e => e.result)] });
      const batchId = randomUUID();
      const ulb = await tx.ulb.findUniqueOrThrow({ where: { id: scope.ulbId } });
      const settings = ulb.settings as Record<string, number>;
      const results: { client_uuid: string; id: string; status: string; verificationScore: number; verificationReasons: unknown }[] = [];
      for (let index = 0; index < request.body.events.length; index++) {
        const parsed = pickupSchema.safeParse(request.body.events[index]);
        const reject = async (code: string, message: string) => {
          const result = { client_uuid: inputIds[index], id: randomUUID(), status: 'REJECTED', verificationScore: 0, verificationReasons: [{ code, severity: 'HARD', message, penalty: 100 }] };
          await tx.rejectedSubmission.create({ data: { id: result.id, ulbId: scope.ulbId, actorId: scope.userId, clientUuid: inputIds[index], batchId, result: json(result) } });
          await new Scope(request, tx).notify('PICKUP_REJECTED', result.id, result);
          results.push(result);
        };
        if (!parsed.success) { await reject('INVALID_INPUT', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')); continue; }
        const event = parsed.data;
        const stop = await tx.routeStop.findFirst({ where: { id: event.routeStopId, propertyId: event.propertyId, ulbId: scope.ulbId, route: { ulbId: scope.ulbId, collectorId: collector.id } }, include: { route: true, property: true } });
        if (!stop || stop.property.ulbId !== scope.ulbId || stop.property.deletedAt || stop.property.status !== 'ACTIVE') { await reject('WRONG_ROUTE', 'Property is not on an assigned route.'); continue; }
        const capturedAt = new Date(event.capturedAt);
        const age = Date.now() - capturedAt.getTime();
        if (age > (settings.offlineRetentionDays ?? 30) * 86400000 || (!event.offline && istDate(capturedAt) !== istDate()) || capturedAt.getTime() > Date.now() + 300000) { await reject('CAPTURE_DATE_INVALID', 'Capture date is outside the permitted online/offline retention window.'); continue; }
        const priorStop = await tx.pickupEvent.findFirst({ where: { ulbId: scope.ulbId, routeStopId: stop.id, OR: [{ status: 'VERIFIED' }, { exceptionAccepted: true }] } });
        if (priorStop) { await reject('STOP_ALREADY_COMPLETED', 'This stop already has a verified pickup or accepted exception.'); continue; }
        if (event.streams.some(s => !stop.streams.includes(s.stream))) { await reject('WRONG_STREAM', 'Use a WRONG_STREAM exception for unscheduled streams.'); continue; }
        const photoIds = [...event.streams.map(s => s.photoId), ...(event.doorstepPhotoId ? [event.doorstepPhotoId] : []), ...(event.exception ? [event.exception.photoId] : [])];
        const photos = await tx.photo.findMany({ where: { id: { in: photoIds }, ulbId: scope.ulbId, ownerId: scope.userId, clientUuid: event.client_uuid, status: 'CONFIRMED', pickupEventId: null } });
        const priorPhotos = await tx.photo.findMany({ where: { ulbId: scope.ulbId, propertyId: event.propertyId, claimedAt: { gte: new Date(Date.now() - 86400000) }, sha256: { in: photos.map(p => p.sha256!).filter(Boolean) } } });
        const device = await tx.device.findFirst({ where: { ulbId: scope.ulbId, collectorId: collector.id, deviceId: event.deviceId, revokedAt: null } });
        const receivedAt = new Date();
        const evidence: PhotoEvidence[] = photos.filter(p => ['DOORSTEP', 'SCALE', 'EXCEPTION'].includes(p.kind)).map(p => ({ id: p.id, tenantId: p.ulbId, propertyId: event.propertyId, collectorId: collector.id, deviceId: event.deviceId, kind: p.kind as PhotoEvidence['kind'], ...(p.stream ? { stream: p.stream } : {}), captureSource: p.captureSource as 'CAMERA', normalized: p.status === 'CONFIRMED' && Boolean(p.sha256), sha256: p.sha256 ?? '', capturedAt: event.capturedAt }));
        const verification = verifyPickup(event, { tenantId: scope.ulbId, collectorId: collector.id, receivedAt: receivedAt.toISOString(), property: { id: stop.property.id, tenantId: stop.property.ulbId, latitude: stop.property.latitude, longitude: stop.property.longitude, qrTokenHash: stop.property.qrTokenHash }, qrKey: { secret: app.config.QR_SECRET, version: app.config.QR_SECRET_VERSION }, device: device ? { deviceId: device.deviceId, collectorId: device.collectorId, tenantId: device.ulbId, active: !device.revokedAt } : null, assignment: { routeStopId: stop.id, propertyId: stop.propertyId, collectorId: stop.route.collectorId, tenantId: stop.ulbId, date: stop.route.date.toISOString().slice(0, 10), active: stop.route.status === 'ACTIVE' }, photos: evidence, priorPhotos: priorPhotos.map(p => ({ propertyId: p.propertyId!, sha256: p.sha256!, receivedAt: p.claimedAt!.toISOString() })), random: () => randomInt(0, 1_000_000) / 1_000_000, config: { geofenceM: settings.geofenceM ?? 75, maxAccuracyM: settings.maxAccuracyM ?? 50 } });
        const row = await tx.pickupEvent.create({ data: pickupData(event, { ulbId: scope.ulbId, societyId: stop.property.societyId, collectorId: collector.id, batchId, scheduledFor: stop.windowStart, receivedAt, status: verification.status, verificationScore: verification.score, verificationReasons: json(verification.reasons) }), include: { streams: true } });
        await tx.photo.updateMany({ where: { ulbId: scope.ulbId, id: { in: photos.map(p => p.id) }, pickupEventId: null }, data: { pickupEventId: row.id, propertyId: event.propertyId, claimedAt: receivedAt } });
        if (event.exception) await tx.pickupException.create({ data: { ulbId: scope.ulbId, pickupEventId: row.id, code: event.exception.code, note: event.exception.note, photoId: event.exception.photoId } });
        if (row.status !== 'REJECTED') await tx.routeStop.update({ where: { id: stop.id, ulbId: scope.ulbId }, data: { status: event.exception ? 'EXCEPTION' : row.status === 'VERIFIED' ? 'DONE' : 'PENDING' } });
        const scoped = new Scope(request, tx);
        await scoped.audit('PICKUP_RECEIVED', 'PickupEvent', row.id, undefined, { status: row.status, verificationScore: row.verificationScore, verificationReasons: row.verificationReasons });
        await scoped.notify(event.exception ? 'PICKUP_EXCEPTION' : 'PICKUP_COMPLETED', row.id, { pickupEventId: row.id, status: row.status });
        results.push(resultFor(row));
      }
      const body = { results }; const code = results.some(r => r.status === 'REJECTED') ? 422 : 200;
      await tx.idempotencyKey.create({ data: { id: batchId, ...idempotencyWhere, requestHash, response: json(body), responseCode: code } });
      return { code, body };
    });
    return reply.code(response.code).send(response.body);
  });

  router.get('/collector/sync/status', { preHandler: collectorGuard, schema: { querystring: pagination } }, async request => {
    const scope = new Scope(request); const collector = await scope.collector();
    const rows = await app.db.pickupEvent.findMany({ where: { ulbId: scope.ulbId, collectorId: collector.id, receivedAt: dateRange(request.query), ...(request.query.status && ['VERIFIED', 'NEEDS_REVIEW', 'REJECTED'].includes(request.query.status) ? { status: request.query.status as 'VERIFIED' } : {}) }, ...pageArgs(request.query) });
    const rejections = await app.db.rejectedSubmission.findMany({ where: { ulbId: scope.ulbId, actorId: scope.userId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return { ...page(rows.map(r => ({ ...resultFor(r), receivedAt: r.receivedAt })), request.query.limit), rejectedSubmissions: rejections.map(r => r.result) };
  });
  router.post('/collector/stops/:stopId/exception', { preHandler: collectorGuard, schema: { params: z.object({ stopId: uuid }).strict(), body: pickupSchema } }, async (request, reply) => {
    if (!request.body.exception || request.body.routeStopId !== request.params.stopId) return fail(422, 'EXCEPTION_REQUIRED', 'Supply the full evidence event and matching routeStopId.');
    const result = await app.inject({ method: 'POST', url: '/api/v1/collector/pickups/batch', headers: { authorization: request.headers.authorization!, 'x-membership-id': new Scope(request).membership.id, 'idempotency-key': idempotencyHeader(request) }, payload: { events: [request.body] } });
    return reply.code(result.statusCode).type('application/json').send(result.body);
  });
  router.get('/supervisor/pickups', { preHandler: authorize('SUPERVISOR', 'ULB_ADMIN', 'SUPER_ADMIN'), schema: { querystring: pagination } }, async request => {
    const scope = new Scope(request);
    return page(await app.db.pickupEvent.findMany({ where: { ...await scope.pickupFilter(), status: 'NEEDS_REVIEW' }, include: { streams: true }, ...pageArgs(request.query) }), request.query.limit);
  });
  router.get('/supervisor/pickups/:id', { preHandler: authorize('SUPERVISOR', 'ULB_ADMIN', 'SUPER_ADMIN'), schema: { params: z.object({ id: uuid }).strict() } }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return detail(new Scope(request), request.params.id);
  });
  router.post('/supervisor/stops/:id/reassign', { preHandler: authorize('SUPERVISOR', 'ULB_ADMIN', 'SUPER_ADMIN'), schema: { params: z.object({ id: uuid }).strict(), body: z.object({ routeId: uuid, reason: z.string().min(1).max(2000) }).strict() } }, async request => {
    const scope = new Scope(request);
    return serialized(app.db, `pickup-sync:${scope.ulbId}`, async tx => {
      const filter = { ulbId: scope.ulbId, ...(scope.membership.role === 'SUPERVISOR' ? { contractorId: scope.membership.contractorId ?? '00000000-0000-0000-0000-000000000000' } : {}) };
      const stop = await tx.routeStop.findFirst({ where: { id: request.params.id, ulbId: scope.ulbId, route: filter }, include: { route: true } });
      const route = await tx.route.findFirst({ where: { ...filter, id: request.body.routeId, status: 'ACTIVE' } });
      if (!stop || !route) return fail(404, 'NOT_FOUND', 'Assigned stop or destination route not found.');
      if (stop.route.date.getTime() !== route.date.getTime()) return fail(422, 'ROUTE_DATE_MISMATCH', 'Reassignment must remain on the same route date.');
      if (await tx.pickupEvent.count({ where: { ulbId: scope.ulbId, routeStopId: stop.id } })) return fail(409, 'STOP_HAS_EVIDENCE', 'A stop with recorded evidence cannot be reassigned.');
      const max = await tx.routeStop.aggregate({ where: { ulbId: scope.ulbId, routeId: route.id }, _max: { sequence: true } });
      const updated = await tx.routeStop.update({ where: { id: stop.id, ulbId: scope.ulbId }, data: { routeId: route.id, sequence: (max._max.sequence ?? 0) + 1, reason: request.body.reason } });
      await new Scope(request, tx).audit('STOP_REASSIGNED', 'RouteStop', stop.id, stop, updated); return updated;
    });
  });
  router.post('/supervisor/pickups/:id/review', { preHandler: authorize('SUPERVISOR', 'ULB_ADMIN', 'SUPER_ADMIN'), schema: { params: z.object({ id: uuid }).strict(), body: supervisorReviewSchema } }, async request => {
    const scope = new Scope(request);
    return serialized(app.db, `pickup-sync:${scope.ulbId}`, async tx => {
      const scoped = new Scope(request, tx); const row = await scoped.pickup(request.params.id);
      if (row.reviewedAt) return fail(409, 'ALREADY_REVIEWED', 'This review has already been recorded.');
      if (row.status === 'VERIFIED') return fail(409, 'NOT_REVIEWABLE', 'This pickup is already verified.');
      if (request.body.decision === 'APPROVE' && row.status === 'REJECTED') return fail(422, 'HARD_FAILURE_NOT_OVERRIDABLE', 'Hard evidence failures cannot be approved. Record corrected evidence as a new event.');
      const other = await tx.pickupEvent.findFirst({ where: { ulbId: scope.ulbId, routeStopId: row.routeStopId, id: { not: row.id }, OR: [{ status: 'VERIFIED' }, { exceptionAccepted: true }] } });
      if (request.body.decision === 'APPROVE' && other) return fail(409, 'STOP_ALREADY_COMPLETED', 'Another accepted event already completes this stop.');
      const approved = request.body.decision === 'APPROVE';
      const updated = await tx.pickupEvent.update({ where: { id: row.id, ulbId: scope.ulbId }, data: { status: approved && !row.exceptionCode ? 'VERIFIED' : approved ? 'NEEDS_REVIEW' : 'REJECTED', provenance: approved && !row.exceptionCode ? 'VERIFIED' : 'SELF_REPORTED', exceptionAccepted: approved && Boolean(row.exceptionCode), reviewedBy: scope.userId, reviewedAt: new Date(), reviewReason: request.body.reason } });
      if (row.exceptionCode) await tx.pickupException.updateMany({ where: { ulbId: scope.ulbId, pickupEventId: row.id }, data: { supervisorStatus: approved ? 'APPROVED' : 'REJECTED', supervisorNote: request.body.reason } });
      if (!other) await tx.routeStop.update({ where: { id: row.routeStopId, ulbId: scope.ulbId }, data: { status: approved ? row.exceptionCode ? 'EXCEPTION' : 'DONE' : 'PENDING' } });
      await scoped.audit('PICKUP_REVIEWED', 'PickupEvent', row.id, row, updated);
      const collector = await tx.collector.findFirst({ where: { ulbId: scope.ulbId, id: row.collectorId } });
      await scoped.notify('PICKUP_REVIEWED', row.id, { status: updated.status, reason: request.body.reason }, collector?.userId ?? scope.userId);
      return resultFor(updated);
    });
  });
}

function pickupData(event: PickupInput, context: { ulbId: string; societyId: string; collectorId: string; batchId: string; scheduledFor: Date; receivedAt: Date; status: 'VERIFIED' | 'NEEDS_REVIEW' | 'REJECTED'; verificationScore: number; verificationReasons: Prisma.InputJsonValue }): Prisma.PickupEventCreateInput {
  return { ...context, clientUuid: event.client_uuid, propertyId: event.propertyId, routeStopId: event.routeStopId, deviceId: event.deviceId, qrTokenHash: hash(event.qrToken), capturedAt: new Date(event.capturedAt), latitude: event.latitude, longitude: event.longitude, accuracyM: event.accuracyM, gpsCapturedAt: new Date(event.gpsCapturedAt), offline: event.offline, exceptionCode: event.exception?.code, exceptionNote: event.exception?.note, provenance: context.status === 'VERIFIED' ? 'VERIFIED' : 'SELF_REPORTED', streams: { create: event.streams.map(s => ({ ulbId: context.ulbId, stream: s.stream, kg: s.kg, segregation: s.segregation, contamination: s.contamination, contaminationNote: s.contaminationNote, photoId: s.photoId })) } };
}
