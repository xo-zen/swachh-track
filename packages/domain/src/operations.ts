import type { ExceptionCode, PickupStream, VerificationStatus } from '@swachh/contracts';
import { kgToGrams, timestamp } from './primitives';

export interface OperationEvent {
  id: string;
  routeStopId: string;
  status: VerificationStatus;
  capturedAt: string;
  streams: readonly PickupStream[];
  offline: boolean;
  exception?: { code: ExceptionCode; accepted: boolean };
}
export interface ScheduledStop {
  id: string;
  windowStart: string;
  windowEnd: string;
}

export function verifiedStops(stops: readonly ScheduledStop[], events: readonly OperationEvent[]): { stop: ScheduledStop; event: OperationEvent }[] {
  const stopIds = new Set(stops.map(stop => stop.id));
  if (stopIds.size !== stops.length) throw new Error('Duplicate scheduled stop ID');
  if (new Set(events.map(event => event.id)).size !== events.length) throw new Error('Duplicate event ID');
  if (events.some(event => !stopIds.has(event.routeStopId))) throw new Error('Event is outside the supplied schedule');
  const verifiedByStop = new Map<string, OperationEvent[]>();
  for (const event of events) {
    if (event.status !== 'VERIFIED' || event.exception) continue;
    const candidates = verifiedByStop.get(event.routeStopId) ?? [];
    candidates.push(event);
    verifiedByStop.set(event.routeStopId, candidates);
  }
  // Keep validation and output in schedule order, not event order.
  return stops.flatMap(stop => {
    if (timestamp(stop.windowEnd) < timestamp(stop.windowStart)) throw new RangeError('Invalid scheduled window');
    const candidates = verifiedByStop.get(stop.id) ?? [];
    if (candidates.length > 1) throw new Error(`Multiple verified events for stop ${stop.id}; reconcile before aggregation`);
    for (const event of candidates) {
      timestamp(event.capturedAt);
      if (!event.streams.length || new Set(event.streams.map(stream => stream.stream)).size !== event.streams.length || event.streams.some(stream => kgToGrams(stream.kg) === 0)) throw new Error('Verified operations require distinct positive weighed streams');
    }
    return candidates[0] ? [{ stop, event: candidates[0] }] : [];
  });
}

export function billableMissedStops(stops: readonly ScheduledStop[], events: readonly OperationEvent[]): ScheduledStop[] {
  const verifiedIds = new Set(verifiedStops(stops, events).map(item => item.stop.id));
  const acceptedExceptionStopIds = new Set(events.filter(event => event.exception?.accepted).map(event => event.routeStopId));
  return stops.filter(stop => !verifiedIds.has(stop.id) && !acceptedExceptionStopIds.has(stop.id));
}
