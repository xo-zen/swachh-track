import type { PickupEvent, PickupStream, Prisma } from '@prisma/client';
import { calculateDashboardMetrics, calculateWeeklyWaste, type DashboardInput, type OperationEvent } from '@swachh/domain';
import type { ExceptionCode, InvoiceStatus, Segregation } from '@swachh/contracts';
import { complaintState } from './operations.js';
import type { Db } from './core.js';

export function operationEvent(row: PickupEvent & { streams: PickupStream[] }): OperationEvent {
  return { id: row.id, routeStopId: row.routeStopId, capturedAt: row.capturedAt.toISOString(), status: row.status, offline: row.offline,
    ...(row.exceptionCode ? { exception: { code: row.exceptionCode as ExceptionCode, accepted: row.exceptionAccepted } } : {}),
    streams: row.streams.map(s => ({ stream: s.stream, kg: Number(s.kg), segregation: s.segregation as Segregation, contamination: s.contamination, ...(s.contaminationNote ? { contaminationNote: s.contaminationNote } : {}), photoId: s.photoId ?? '' })),
  };
}
export async function dataset(db: Db, ulbId: string, societyIds: string[], from: Date, to: Date, contractorId?: string) {
  const where: Prisma.RouteStopWhereInput = { ulbId, property: { ulbId, societyId: { in: societyIds }, deletedAt: null }, windowStart: { gte: from, lte: to }, ...(contractorId ? { route: { ulbId, contractorId } } : {}) };
  const stops = await db.routeStop.findMany({ where, orderBy: { windowStart: 'asc' } });
  const pickups = await db.pickupEvent.findMany({ where: { ulbId, routeStopId: { in: stops.map(s => s.id) } }, include: { streams: true } });
  return { stops: stops.map(s => ({ id: s.id, windowStart: s.windowStart.toISOString(), windowEnd: s.windowEnd.toISOString() })), events: pickups.map(operationEvent), pickups };
}
export async function dashboard(db: Db, ulbId: string, societyIds: string[], from: Date, to: Date, contractorId?: string, compliance: Pick<DashboardInput, 'certificateCoverage' | 'massBalance'> = {}) {
  const data = await dataset(db, ulbId, societyIds, from, to, contractorId);
  const complaints = await db.complaint.findMany({ where: { ulbId, societyId: { in: societyIds }, createdAt: { gte: from, lte: to }, ...(contractorId ? { propertyId: { in: data.pickups.map(p => p.propertyId) } } : {}) } });
  const states = await Promise.all(complaints.map(async c => ({ id: c.id, ...await complaintState(db, c) })));
  const invoices = await db.invoice.findMany({ where: { ulbId, societyId: { in: societyIds }, periodStart: { gte: from, lte: to } } });
  const activeFlats = await db.property.count({ where: { ulbId, societyId: { in: societyIds }, status: 'ACTIVE', deletedAt: null } });
  const metrics = calculateDashboardMetrics({ ...data, ...compliance, complaints: states, invoices: invoices.map(i => ({ id: i.id, status: i.status as InvoiceStatus, totalPaise: i.totalPaise })), activeFlats, activeFlatsQueryRef: `properties:${ulbId}:${societyIds.join(',')}:ACTIVE`, now: new Date().toISOString() });
  return { metrics, trend: calculateWeeklyWaste(data.events, to.toISOString()), period: { from: from.toISOString(), to: to.toISOString() }, provenance: 'VERIFIED', ...metrics };
}
