import { SEGREGATIONS, STREAMS, type InvoiceStatus, type Provenance, type Segregation, type Stream } from '@swachh/contracts';
import { calculateSla, type ComplaintState } from './complaints';
import type { calculateCertificateCoverage, calculateMassBalance } from './compliance';
import { verifiedStops, type OperationEvent, type ScheduledStop } from './operations';
import { DAY_MS, calendarDay, integer, istDate, kgToGrams, nonnegative, sumKg, timestamp } from './primitives';

export interface Metric {
  value: number | null;
  unit: 'COUNT' | '%' | 'KG' | 'PAISE/FLAT' | 'PAISE/KG';
  definition: string;
  provenance: Provenance;
  sourceIds: string[];
  numerator?: number;
  denominator?: number;
}
function metric(value: number | null, unit: Metric['unit'], definition: string, provenance: Provenance, sourceIds: readonly string[]): Metric {
  return { value, unit, definition, provenance: value === null ? 'NOT_MEASURED' : provenance, sourceIds: [...new Set(sourceIds)] };
}
function percentage(numerator: number, denominator: number, definition: string, provenance: Provenance, sourceIds: readonly string[]): Metric {
  return { ...metric(denominator === 0 ? null : numerator / denominator * 100, '%', definition, provenance, sourceIds), numerator, denominator };
}
function byStream(events: readonly OperationEvent[]): Record<Stream, Metric> {
  const result = {} as Record<Stream, Metric>;
  for (const stream of STREAMS) {
    const contributors = events.filter(event => event.streams.some(entry => entry.stream === stream));
    result[stream] = metric(sumKg(contributors.flatMap(event => event.streams.filter(entry => entry.stream === stream).map(entry => entry.kg))), 'KG', `Sum of ${stream} kg from verified pickups without exceptions.`, 'VERIFIED', contributors.map(event => event.id));
  }
  return result;
}
export interface DashboardInput {
  stops: readonly ScheduledStop[];
  events: readonly OperationEvent[];
  complaints: readonly (ComplaintState & { id: string })[];
  invoices: readonly { id: string; status: InvoiceStatus; totalPaise: number }[];
  activeFlats: number;
  activeFlatsQueryRef: string;
  now: string;
  certificateCoverage?: ReturnType<typeof calculateCertificateCoverage>;
  massBalance?: ReturnType<typeof calculateMassBalance>;
}

export function calculateDashboardMetrics(input: DashboardInput) {
  integer(nonnegative(input.activeFlats, 'Active flats'), 'Active flats');
  if (!input.activeFlatsQueryRef.trim()) throw new Error('Active flats require provenance');
  timestamp(input.now);
  if (new Set(input.complaints.map(item => item.id)).size !== input.complaints.length || new Set(input.invoices.map(item => item.id)).size !== input.invoices.length) throw new Error('Duplicate complaint or invoice ID');
  const selected = verifiedStops(input.stops, input.events);
  const verified = selected.map(item => item.event);
  const eventIds = verified.map(event => event.id);
  const stopIds = input.stops.map(stop => stop.id);
  const allEventIds = input.events.map(event => event.id);
  const verifiedStopIds = new Set(selected.map(item => item.stop.id));
  const eventStopIds = new Set<string>();
  const notOutStopIds = new Set<string>();
  for (const event of input.events) {
    eventStopIds.add(event.routeStopId);
    if (event.exception?.code === 'NOT_OUT') notOutStopIds.add(event.routeStopId);
  }
  const missed = input.stops.filter(stop => !verifiedStopIds.has(stop.id) && (
    !eventStopIds.has(stop.id) || notOutStopIds.has(stop.id)
  ));
  const missedStopIds = new Set(missed.map(stop => stop.id));
  const onTime = selected.filter(({ event, stop }) => timestamp(event.capturedAt) >= timestamp(stop.windowStart) && timestamp(event.capturedAt) <= timestamp(stop.windowEnd));
  const contaminated = verified.filter(event => event.streams.some(stream => stream.contamination));
  const kgByStream = byStream(verified);
  const totalKg = sumKg(STREAMS.map(stream => kgByStream[stream].value ?? 0));
  const segregation = {} as Record<Segregation, { eventCount: Metric; eventPct: Metric; kg: Metric; kgPct: Metric }>;
  for (const quality of SEGREGATIONS) {
    const matching = verified.filter(event => event.streams.some(stream => stream.segregation === quality));
    const ids = matching.map(event => event.id);
    const kg = sumKg(matching.flatMap(event => event.streams.filter(stream => stream.segregation === quality).map(stream => stream.kg)));
    segregation[quality] = {
      eventCount: metric(matching.length, 'COUNT', `Verified events with at least one ${quality} stream; a multi-stream event may appear in multiple categories.`, 'VERIFIED', ids),
      eventPct: percentage(matching.length, verified.length, `Verified events with a ${quality} stream / verified events x 100; categories may overlap.`, 'VERIFIED', eventIds),
      kg: metric(kg, 'KG', `Sum of verified stream kg marked ${quality}.`, 'VERIFIED', ids),
      kgPct: percentage(kg, totalKg, `Verified ${quality} kg / all verified kg x 100.`, 'VERIFIED', eventIds),
    };
  }
  const complaints = input.complaints.map(complaint => ({ complaint, sla: calculateSla(complaint, input.now) }));
  const complaintIds = complaints.map(item => item.complaint.id);
  const resolved = complaints.filter(item => item.sla.resolved);
  const open = complaints.filter(item => !['RESOLVED', 'CLOSED'].includes(item.complaint.status));
  const invoiced = input.invoices.filter(invoice => invoice.status === 'ISSUED' || invoice.status === 'PAID');
  let cost = 0n;
  for (const invoice of invoiced) cost += BigInt(integer(nonnegative(invoice.totalPaise, 'Invoice total'), 'Invoice total'));
  integer(Number(cost), 'Total invoiced paise');
  const roundUnit = (denominator: bigint, multiplier = 1n): number | null => denominator === 0n || invoiced.length === 0 ? null : integer(Number((cost * multiplier * 2n + denominator) / (denominator * 2n)), 'Cost per unit');
  const costs = invoiced.map(invoice => invoice.id);
  const certificate = input.certificateCoverage;
  const certificateIds = certificate ? STREAMS.flatMap(stream => certificate.byStream[stream].certificateIds) : [];
  const quality = (status: OperationEvent['status']) => percentage(input.events.filter(event => event.status === status).length, input.events.length, `${status} events / all submitted events x 100; counts include exception events.`, 'VERIFIED', allEventIds);
  const recycling = input.massBalance?.recyclingRate;
  return {
    scheduledStops: metric(input.stops.length, 'COUNT', 'Number of distinct scheduled stops in the selected scope and period.', 'SELF_REPORTED', stopIds),
    verifiedStops: metric(selected.length, 'COUNT', 'Scheduled stops with one verified pickup and no exception.', 'VERIFIED', eventIds),
    missedStops: metric(missed.length, 'COUNT', 'Scheduled stops with NOT_OUT or no event, excluding any verified stop. Other rejected/review events are not counted as missed.', 'SELF_REPORTED', [...missedStopIds, ...input.events.filter(event => missedStopIds.has(event.routeStopId)).map(event => event.id)]),
    coveragePct: percentage(selected.length, input.stops.length, 'Verified stops / scheduled stops x 100.', 'VERIFIED', [...stopIds, ...eventIds]),
    onTimePct: percentage(onTime.length, selected.length, 'Verified stops captured within the inclusive scheduled window / verified stops x 100.', 'VERIFIED', [...stopIds, ...eventIds]),
    missedPct: percentage(missed.length, input.stops.length, '(Scheduled stops with NOT_OUT + scheduled stops with no event) / scheduled stops x 100, counting each stop once and excluding verified stops.', 'SELF_REPORTED', [...stopIds, ...allEventIds]),
    totalKg: metric(totalKg, 'KG', 'Sum of all stream kg from verified pickups without exceptions.', 'VERIFIED', eventIds),
    kgByStream, segregation,
    contaminationPct: percentage(contaminated.length, verified.length, 'Verified events with at least one contaminated stream / verified events x 100.', 'VERIFIED', eventIds),
    complaintCount: metric(complaints.length, 'COUNT', 'Distinct complaints in the selected scope and period.', 'SELF_REPORTED', complaintIds),
    openComplaints: metric(open.length, 'COUNT', 'Complaints not RESOLVED or CLOSED, including resident-wait and reopened complaints.', 'SELF_REPORTED', open.map(item => item.complaint.id)),
    slaCompliancePct: percentage(resolved.filter(item => !item.sla.breached).length, resolved.length, 'Resolved complaints within their pause-adjusted SLA / resolved complaints x 100; open complaints are excluded.', 'SELF_REPORTED', resolved.map(item => item.complaint.id)),
    slaBreaches: metric(open.filter(item => item.sla.breached).length, 'COUNT', 'Open complaints whose active elapsed SLA time exceeds the configured budget.', 'SELF_REPORTED', open.filter(item => item.sla.breached).map(item => item.complaint.id)),
    unresolvedExceptions: metric(input.events.filter(event => event.exception && !event.exception.accepted).length, 'COUNT', 'Exception events not accepted by a supervisor.', 'SELF_REPORTED', input.events.filter(event => event.exception && !event.exception.accepted).map(event => event.id)),
    certificateCoveragePct: metric(certificate?.coveragePct ?? null, '%', certificate?.definition ?? 'Valid ULB certificate kg / calculated obligation kg x 100.', certificate?.provenance ?? 'NOT_MEASURED', [...certificateIds, ...(certificate?.obligationSourceIds ?? [])]),
    certificateGapKg: metric(certificate?.gapKg ?? null, 'KG', 'Sum of per-stream max(obligation kg - valid held certificate kg, 0); stream surpluses cannot offset gaps.', certificate?.provenance ?? 'NOT_MEASURED', [...certificateIds, ...(certificate?.obligationSourceIds ?? [])]),
    costPerFlatPaise: metric(roundUnit(BigInt(input.activeFlats)), 'PAISE/FLAT', 'Issued/paid invoice total paise / active flats, rounded half-up to integer paise; no invoices means Not measured.', 'SELF_REPORTED', [...costs, input.activeFlatsQueryRef]),
    costPerVerifiedKgPaise: metric(roundUnit(BigInt(kgToGrams(totalKg)), 1000n), 'PAISE/KG', 'Issued/paid invoice total paise / verified kg, rounded half-up to integer paise; no invoices means Not measured.', 'SELF_REPORTED', [...costs, ...eventIds]),
    dataQuality: {
      verifiedPct: quality('VERIFIED'), needsReviewPct: quality('NEEDS_REVIEW'), rejectedPct: quality('REJECTED'),
      offlinePct: percentage(input.events.filter(event => event.offline).length, input.events.length, 'Events declared offline / all submitted events x 100.', 'SELF_REPORTED', allEventIds),
    },
    recyclingRatePct: metric(recycling?.value ?? null, '%', recycling?.definition ?? 'Verified processed/recycled kg / verified collected kg x 100; requires registered-processor handover and receipt evidence.', recycling?.provenance ?? 'NOT_MEASURED', recycling?.sourceIds ?? []),
  };
}

export function calculateWeeklyWaste(events: readonly OperationEvent[], asOf: string, weeks = 12): { weekStart: string; kgByStream: Record<Stream, Metric> }[] {
  integer(weeks, 'Weeks');
  if (weeks < 1 || weeks > 104) throw new RangeError('Weeks must be 1 to 104');
  const end = timestamp(asOf);
  const today = calendarDay(istDate(asOf));
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY_MS;
  if (new Set(events.map(event => event.id)).size !== events.length) throw new Error('Duplicate event ID');
  return Array.from({ length: weeks }, (_, index) => {
    const start = monday - (weeks - 1 - index) * 7 * DAY_MS;
    const selected = events.filter(event => {
      const day = calendarDay(istDate(event.capturedAt));
      return event.status === 'VERIFIED' && !event.exception && day >= start && day < start + 7 * DAY_MS && timestamp(event.capturedAt) <= end;
    });
    return { weekStart: new Date(start).toISOString().slice(0, 10), kgByStream: byStream(selected) };
  });
}

export interface DestinationHandover {
  id: string;
  destination: string;
  stream: Stream;
  kg: number;
  verified: boolean;
  registeredVendor: boolean;
  receiptId: string;
}
export function calculateDestinationWaste(handovers: readonly DestinationHandover[]): { destination: string; stream: Stream; kg: Metric }[] {
  if (new Set(handovers.map(handover => handover.id)).size !== handovers.length) throw new Error('Duplicate handover ID');
  const groups = new Map<string, DestinationHandover[]>();
  for (const handover of handovers) {
    if (!handover.verified || !handover.registeredVendor || !handover.receiptId.trim()) continue;
    if (!handover.destination.trim() || kgToGrams(handover.kg) === 0) throw new Error('Verified handover requires destination and positive kg');
    const key = JSON.stringify([handover.destination, handover.stream]);
    const group = groups.get(key) ?? [];
    group.push(handover);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    destination: group[0].destination, stream: group[0].stream,
    kg: metric(sumKg(group.map(handover => handover.kg)), 'KG', 'Sum of verified handover kg for this destination and stream, supported by registered-vendor receipt evidence; not a claim of recycling.', 'VERIFIED', group.flatMap(handover => [handover.id, handover.receiptId])),
  })).sort((a, b) => a.destination.localeCompare(b.destination) || a.stream.localeCompare(b.stream));
}
