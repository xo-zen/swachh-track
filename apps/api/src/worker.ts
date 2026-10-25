import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { notificationDeliveryAt, certificateExpiryAlert, calculateSla, slaEscalation } from '@swachh/domain';
import { loadConfig, type Config } from './config.js';
import { complaintState } from './operations.js';
import { istDate, json, serialized } from './core.js';

export async function scanOutbox(db: PrismaClient, queue: Queue) {
  const rows = await db.notification.findMany({ where: { status: 'PENDING', scheduledAt: { lte: new Date() } }, orderBy: { createdAt: 'asc' }, take: 250 });
  for (const row of rows) await queue.add('deliver', { notificationId: row.id }, { jobId: row.id, attempts: 5, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: 1000 });
}

export async function deliverNotification(db: PrismaClient, id: string, config: Config, logger: (data: unknown) => void = console.info) {
  return serialized(db, `notification:${id}`, async tx => {
    const row = await tx.notification.findUnique({ where: { id } });
    if (!row || row.status !== 'PENDING') return;
    const user = await tx.user.findUnique({ where: { id: row.userId } });
    const preferences = (user?.notificationPreferences ?? {}) as Record<string, unknown>;
    const due = notificationDeliveryAt(new Date().toISOString(), row.template, typeof preferences.quietStart === 'string' ? preferences.quietStart : '21:00', typeof preferences.quietEnd === 'string' ? preferences.quietEnd : '07:00');
    if (Date.parse(due) > Date.now() + 1000) {
      await tx.notification.update({ where: { id: row.id }, data: { scheduledAt: new Date(due) } }); return;
    }
    const optedOut = row.channel === 'EMAIL' && preferences.email !== true || row.channel === 'WHATSAPP' && preferences.whatsapp !== true || row.channel === 'IN_APP' && preferences.inApp === false;
    let status = optedOut ? 'SUPPRESSED' : 'DELIVERED';
    let detail = optedOut ? 'Recipient did not opt in to this channel.' : 'Available in the authenticated in-app notification inbox.';
    if (!optedOut && row.channel === 'EMAIL') {
      status = config.NODE_ENV === 'production' ? 'NOT_CONFIGURED' : 'LOGGED';
      detail = config.NODE_ENV === 'production' ? 'Production email provider not configured.' : 'Development logger only; no email was sent.';
      logger({ notificationId: row.id, template: row.template, channel: row.channel, status });
    } else if (!optedOut && ['WHATSAPP', 'FCM'].includes(row.channel)) {
      status = 'NOT_CONFIGURED'; detail = 'Provider credentials and production onboarding are not configured.';
      await tx.outboundMessage.create({ data: { ulbId: row.ulbId, channel: row.channel, entityId: row.id, payload: json(row.payload), status } });
    }
    await tx.notificationAttempt.create({ data: { ulbId: row.ulbId, notificationId: row.id, status, detail } });
    await tx.notification.update({ where: { id: row.id }, data: { status, attempts: { increment: 1 }, sentAt: status === 'DELIVERED' ? new Date() : null } });
  });
}

export async function enqueueReminders(db: PrismaClient) {
  const now = new Date();
  const stops = await db.routeStop.findMany({ where: { windowStart: { gte: now, lte: new Date(now.getTime() + 12 * 3600000) }, status: 'PENDING' }, take: 1000 });
  for (const stop of stops) {
    const residents = await db.resident.findMany({ where: { ulbId: stop.ulbId, propertyId: stop.propertyId, active: true } });
    for (const resident of residents) {
      const dedupeKey = `${stop.ulbId}:SCHEDULE_REMINDER:${stop.id}:${resident.userId}`;
      await db.notification.upsert({ where: { dedupeKey }, update: {}, create: { ulbId: stop.ulbId, userId: resident.userId, dedupeKey, template: 'SCHEDULE_REMINDER', payload: json({ routeStopId: stop.id, propertyId: stop.propertyId, streams: stop.streams, windowStart: stop.windowStart, windowEnd: stop.windowEnd }) } });
    }
  }
  const complaints = await db.complaint.findMany({ where: { status: { notIn: ['RESOLVED', 'CLOSED'] }, slaDueAt: { lt: now } }, take: 500 });
  for (const complaint of complaints) {
    await serialized(db, `complaint:${complaint.id}`, async tx => {
      const current = await tx.complaint.findUniqueOrThrow({ where: { id: complaint.id } });
      const sla = calculateSla(await complaintState(tx, current), now.toISOString());
      const escalation = slaEscalation(sla, now.toISOString(), current.supervisorNotifiedAt?.toISOString());
      if (!escalation || escalation === 'SUPERVISOR' && current.escalationLevel >= 1 || escalation === 'ULB_ADMIN' && current.escalationLevel >= 2) return;
      const routes = escalation === 'SUPERVISOR' ? await tx.routeStop.findMany({ where: { ulbId: current.ulbId, propertyId: current.propertyId }, select: { route: { select: { contractorId: true } } } }) : [];
      const recipients = await tx.membership.findMany({ where: { ulbId: current.ulbId, role: escalation, status: 'ACTIVE', ...(escalation === 'SUPERVISOR' ? { contractorId: { in: [...new Set(routes.map(stop => stop.route.contractorId))] } } : {}) } });
      for (const recipient of recipients) {
        const dedupeKey = `${current.ulbId}:SLA_BREACH:${current.id}:${escalation}:${recipient.userId}`;
        await tx.notification.upsert({ where: { dedupeKey }, update: {}, create: { ulbId: current.ulbId, userId: recipient.userId, dedupeKey, template: 'SLA_BREACH', payload: { complaintId: current.id, escalation }, scheduledAt: now } });
      }
      await tx.complaint.update({ where: { id: current.id, ulbId: current.ulbId }, data: { escalationLevel: escalation === 'SUPERVISOR' ? 1 : 2, ...(escalation === 'SUPERVISOR' ? { supervisorNotifiedAt: now } : {}) } });
      await tx.auditLog.create({ data: { ulbId: current.ulbId, actorId: '00000000-0000-0000-0000-000000000000', action: 'AUTOMATIC_SLA_ESCALATION', entity: 'Complaint', entityId: current.id, before: { escalationLevel: current.escalationLevel }, after: { escalation, systemActor: true } } });
    });
  }
  const certificates = await db.ebwgrCertificate.findMany({ where: { validUntil: { gte: now, lte: new Date(now.getTime() + 90 * 86400000) }, status: { not: 'REVOKED' } }, take: 500 });
  for (const certificate of certificates) {
    const threshold = certificateExpiryAlert(certificate.validUntil.toISOString().slice(0, 10), istDate());
    const members = await db.membership.findMany({ where: { ulbId: certificate.ulbId, societyId: certificate.societyId, role: 'SOCIETY_ADMIN', status: 'ACTIVE' } });
    for (const member of members) {
      const dedupeKey = `${certificate.ulbId}:CERTIFICATE_EXPIRING:${certificate.id}:${threshold}:${member.userId}`;
      await db.notification.upsert({ where: { dedupeKey }, update: {}, create: { ulbId: certificate.ulbId, userId: member.userId, dedupeKey, template: 'CERTIFICATE_EXPIRING', payload: json({ certificateId: certificate.id, threshold, validUntil: certificate.validUntil }) } });
    }
  }
}

export async function startWorker() {
  const config = loadConfig(); const db = new PrismaClient();
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  await redis.connect(); await redis.ping(); await redis.quit();
  const url = new URL(config.REDIS_URL);
  const connection = { host: url.hostname, port: Number(url.port || 6379), username: url.username ? decodeURIComponent(url.username) : undefined, password: url.password ? decodeURIComponent(url.password) : undefined, db: Number(url.pathname.slice(1) || 0), maxRetriesPerRequest: null, ...(url.protocol === 'rediss:' ? { tls: {} } : {}) };
  const queue = new Queue('swachh-notifications', { connection });
  const worker = new Worker('swachh-notifications', async job => {
    try { await deliverNotification(db, String(job.data.notificationId), config); }
    catch (error) {
      const notification = await db.notification.findUnique({ where: { id: String(job.data.notificationId) } });
      if (notification) await db.$transaction([
        db.notificationAttempt.create({ data: { ulbId: notification.ulbId, notificationId: notification.id, status: 'FAILED', detail: 'Delivery transaction failed; retry scheduled.' } }),
        db.notification.update({ where: { id: notification.id }, data: { attempts: { increment: 1 }, ...(job.attemptsMade >= 4 ? { status: 'FAILED' } : {}) } }),
      ]);
      throw error;
    }
  }, { connection, concurrency: 5 });
  worker.on('error', error => console.error({ error: error.message }, 'Notification worker error'));
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try { await enqueueReminders(db); await scanOutbox(db, queue); }
    catch (error) { console.error({ error: error instanceof Error ? error.message : 'Worker tick failed' }); }
    finally { busy = false; }
  };
  await tick(); const timer = setInterval(() => void tick(), 10000);
  const close = async () => { clearInterval(timer); await worker.close(); await queue.close(); await db.$disconnect(); };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await close(); process.exit(0); });
  return { close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await startWorker();
