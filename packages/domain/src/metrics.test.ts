import { describe, expect, it } from 'vitest';
import { calculateCertificateCoverage, calculateDashboardMetrics, calculateDestinationWaste, calculateMassBalance, calculateWeeklyWaste, type DashboardInput, type Metric } from './index';
import { operationFixture, stopFixture, streamFixture } from './fixtures.test-helper';

function fixture(): DashboardInput {
  const complaint = { createdAt: '2026-01-14T00:00:00Z', slaHours: 12, pauses: [], reopenedCount: 0 };
  return {
    stops: ['s1', 's2', 's3', 's4', 's5'].map(stopFixture),
    events: [
      operationFixture({ streams: [streamFixture({ kg: 1.5 }), streamFixture({ stream: 'DRY', kg: 0.5, segregation: 'MIXED', contamination: true, contaminationNote: 'Food residue' })] }),
      operationFixture({ id: 'e2', routeStopId: 's2', capturedAt: '2026-01-15T04:00:00Z', streams: [streamFixture({ kg: 2, segregation: 'PARTIAL' }), streamFixture({ stream: 'DRY', kg: 1 })] }),
      operationFixture({ id: 'e3', routeStopId: 's3', status: 'REJECTED', offline: true, streams: [streamFixture({ kg: 99 })] }),
      operationFixture({ id: 'e4', routeStopId: 's4', status: 'NEEDS_REVIEW', streams: [], exception: { code: 'NOT_OUT', accepted: true } }),
    ],
    complaints: [
      { ...complaint, id: 'c1', status: 'RESOLVED', resolvedAt: '2026-01-14T12:00:00Z' },
      { ...complaint, id: 'c2', status: 'CLOSED', resolvedAt: '2026-01-14T13:00:00Z' },
      { ...complaint, id: 'c3', status: 'OPEN' },
    ],
    invoices: [{ id: 'i1', status: 'ISSUED', totalPaise: 10005 }, { id: 'i2', status: 'PAID', totalPaise: 5000 }, { id: 'i3', status: 'DRAFT', totalPaise: 99999 }, { id: 'i4', status: 'VOID', totalPaise: 99999 }],
    activeFlats: 3, activeFlatsQueryRef: 'active-flat-query', now: '2026-01-15T06:00:00Z',
    certificateCoverage: calculateCertificateCoverage({ societyId: 'a', asOf: '2026-01-15', requiredKg: { WET: 100, DRY: 100, SANITARY: 0, SPECIAL_CARE: 0 }, obligationProvenance: 'ESTIMATED', obligationSourceIds: ['obligation-query'], certificates: [{ id: 'cert1', societyId: 'a', stream: 'WET', kg: 160, issuingUlbId: 'ulb', documentId: 'doc', issuedAt: '2026-01-01', status: 'ACTIVE' }] }),
    massBalance: calculateMassBalance({ collected: { kg: 100, provenance: 'VERIFIED', sourceIds: ['p1'] }, handedOver: { kg: 100, provenance: 'VERIFIED', sourceIds: ['h1'] }, processed: { kg: 90, provenance: 'VERIFIED', sourceIds: ['r1'] }, verifiedRegisteredProcessorReceipt: true }),
  };
}

function flattenMetrics(value: unknown, path = ''): Record<string, Metric> {
  if (typeof value !== 'object' || value === null) return {};
  if ('value' in value && 'unit' in value && 'definition' in value) return { [path]: value as Metric };
  return Object.assign({}, ...Object.entries(value).map(([key, entry]) => flattenMetrics(entry, path ? `${path}.${key}` : key))) as Record<string, Metric>;
}
describe('one source of truth dashboard formulas', () => {
  it('tests every dashboard metric against one explicit fixed fixture', () => {
    const metrics = flattenMetrics(calculateDashboardMetrics(fixture()));
    const values = Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, value.value]));
    expect(values).toEqual({
      scheduledStops: 5, verifiedStops: 2, missedStops: 2, coveragePct: 40, onTimePct: 50, missedPct: 40,
      totalKg: 5, 'kgByStream.WET': 3.5, 'kgByStream.DRY': 1.5, 'kgByStream.SANITARY': 0, 'kgByStream.SPECIAL_CARE': 0,
      'segregation.GOOD.eventCount': 2, 'segregation.GOOD.eventPct': 100, 'segregation.GOOD.kg': 2.5, 'segregation.GOOD.kgPct': 50,
      'segregation.PARTIAL.eventCount': 1, 'segregation.PARTIAL.eventPct': 50, 'segregation.PARTIAL.kg': 2, 'segregation.PARTIAL.kgPct': 40,
      'segregation.MIXED.eventCount': 1, 'segregation.MIXED.eventPct': 50, 'segregation.MIXED.kg': 0.5, 'segregation.MIXED.kgPct': 10,
      contaminationPct: 50, complaintCount: 3, openComplaints: 1, slaCompliancePct: 50, slaBreaches: 1,
      unresolvedExceptions: 0, certificateCoveragePct: 80, certificateGapKg: 100, costPerFlatPaise: 5002, costPerVerifiedKgPaise: 3001,
      'dataQuality.verifiedPct': 50, 'dataQuality.needsReviewPct': 25, 'dataQuality.rejectedPct': 25, 'dataQuality.offlinePct': 25,
      recyclingRatePct: 90,
    });
    for (const metric of Object.values(metrics)) {
      expect(metric.definition.length).toBeGreaterThan(10);
      expect(['VERIFIED', 'SELF_REPORTED', 'ESTIMATED', 'NOT_MEASURED']).toContain(metric.provenance);
      expect(metric.sourceIds).toEqual([...new Set(metric.sourceIds)]);
    }
    expect(metrics['kgByStream.WET'].sourceIds).toEqual(['e1', 'e2']);
    expect(metrics.certificateCoveragePct.provenance).toBe('ESTIMATED');
    expect(metrics.costPerFlatPaise.sourceIds).toEqual(['i1', 'i2', 'active-flat-query']);
  });
  it('returns null/NOT_MEASURED rather than fabricated percentages for empty denominators', () => {
    const result = calculateDashboardMetrics({ stops: [], events: [], complaints: [], invoices: [], activeFlats: 0, activeFlatsQueryRef: 'empty', now: '2026-01-15T06:00:00Z' });
    const metrics = flattenMetrics(result);
    for (const value of Object.values(metrics)) {
      if (value.unit === '%' || value.unit.startsWith('PAISE/')) expect(value).toMatchObject({ value: null, provenance: 'NOT_MEASURED' });
    }
    expect(result.totalKg.value).toBe(0);
    expect(result.scheduledStops.value).toBe(0);
  });
  it('counts a contaminated multi-stream event once and never lets rejected/review kg enter totals', () => {
    const input = fixture();
    input.events[0].streams = input.events[0].streams.map(stream => ({ ...stream, contamination: true }));
    expect(calculateDashboardMetrics(input).contaminationPct.value).toBe(50);
    expect(calculateDashboardMetrics(input).totalKg.value).toBe(5);
    input.events[3].exception = { code: 'ACCESS_BLOCKED', accepted: false };
    const metrics = calculateDashboardMetrics(input);
    expect(metrics.missedStops.value).toBe(1);
    expect(metrics.unresolvedExceptions.value).toBe(1);
  });
  it('does not report zero cost when invoices are unavailable', () => {
    expect(calculateDashboardMetrics({ ...fixture(), invoices: [] }).costPerFlatPaise.value).toBeNull();
  });
  it('keeps stop and event provenance order across retries, NOT_OUT exceptions and verified pickups', () => {
    const input: DashboardInput = {
      ...fixture(),
      stops: ['s5', 's2', 's4', 's1', 's3', 's6'].map(stopFixture),
      events: [
        operationFixture({ id: 'e4-review', routeStopId: 's4', status: 'NEEDS_REVIEW' }),
        operationFixture({ streams: [streamFixture({ kg: 1.5 })] }),
        operationFixture({ id: 'e2-not-out', routeStopId: 's2', streams: [], exception: { code: 'NOT_OUT', accepted: true } }),
        operationFixture({ id: 'e3-access', routeStopId: 's3', status: 'REJECTED', exception: { code: 'ACCESS_BLOCKED', accepted: false } }),
        operationFixture({ id: 'e4-not-out', routeStopId: 's4', status: 'NEEDS_REVIEW', exception: { code: 'NOT_OUT', accepted: true } }),
        operationFixture({ id: 'e2', routeStopId: 's2', streams: [streamFixture({ kg: 2 })] }),
        operationFixture({ id: 'e6-not-out', routeStopId: 's6', status: 'REJECTED', exception: { code: 'NOT_OUT', accepted: false } }),
        operationFixture({ id: 'e4-rejected', routeStopId: 's4', status: 'REJECTED' }),
      ],
    };
    const metrics = calculateDashboardMetrics(input);
    expect(metrics.verifiedStops).toMatchObject({ value: 2, sourceIds: ['e2', 'e1'] });
    expect(metrics.totalKg).toMatchObject({ value: 3.5, sourceIds: ['e2', 'e1'] });
    expect(metrics.missedStops).toEqual({
      value: 3, unit: 'COUNT', provenance: 'SELF_REPORTED',
      definition: 'Scheduled stops with NOT_OUT or no event, excluding any verified stop. Other rejected/review events are not counted as missed.',
      sourceIds: ['s5', 's4', 's6', 'e4-review', 'e4-not-out', 'e6-not-out', 'e4-rejected'],
    });
    expect(metrics.missedPct).toMatchObject({ value: 50, numerator: 3, denominator: 6, sourceIds: [...input.stops.map(stop => stop.id), ...input.events.map(event => event.id)] });
  });
  it('rejects duplicate input IDs and references outside the schedule', () => {
    const input = fixture();
    expect(() => calculateDashboardMetrics({ ...input, invoices: [...input.invoices, input.invoices[0]] })).toThrow('Duplicate');
    expect(() => calculateDashboardMetrics({ ...input, complaints: [...input.complaints, input.complaints[0]] })).toThrow('Duplicate');
    expect(() => calculateDashboardMetrics({ ...input, stops: [...input.stops, input.stops[0]] })).toThrow('Duplicate scheduled stop ID');
    expect(() => calculateDashboardMetrics({ ...input, events: [...input.events, input.events[0]] })).toThrow('Duplicate event ID');
    expect(() => calculateDashboardMetrics({ ...input, events: [...input.events, { ...input.events[0], id: 'another' }] })).toThrow('Multiple verified events for stop s1');
    expect(() => calculateDashboardMetrics({ ...input, stops: [] })).toThrow('outside');
  });
});
describe('12-week verified kg trend', () => {
  it('groups Monday-start IST weeks, excludes future/unverified events and fills missing weeks', () => {
    const events = [
      operationFixture({ capturedAt: '2026-01-11T18:29:59Z', streams: [streamFixture({ kg: 2 })] }),
      operationFixture({ id: 'e2', capturedAt: '2026-01-11T18:30:00Z', streams: [streamFixture({ kg: 3 })] }),
      operationFixture({ id: 'future', capturedAt: '2026-01-16T00:00:00Z', streams: [streamFixture({ kg: 99 })] }),
      operationFixture({ id: 'review', status: 'NEEDS_REVIEW', streams: [streamFixture({ kg: 99 })] }),
    ];
    const trend = calculateWeeklyWaste(events, '2026-01-15T06:00:00Z');
    expect(trend).toHaveLength(12);
    expect(trend[0].weekStart).toBe('2025-10-27');
    expect(trend[0].kgByStream.WET.value).toBe(0);
    expect(trend[10].weekStart).toBe('2026-01-05');
    expect(trend[10].kgByStream.WET.value).toBe(2);
    expect(trend[11].weekStart).toBe('2026-01-12');
    expect(trend[11].kgByStream.WET).toMatchObject({ value: 3, provenance: 'VERIFIED', sourceIds: ['e2'] });
  });
});

describe('destination evidence', () => {
  it('groups only verified documented registered-vendor handovers by destination and stream', () => {
    const handover = { id: 'h1', destination: 'MRF A', stream: 'DRY' as const, kg: 1.2, verified: true, registeredVendor: true, receiptId: 'receipt-1' };
    const result = calculateDestinationWaste([handover,
      { ...handover, id: 'h2', kg: 0.3, receiptId: 'receipt-2' },
      { ...handover, id: 'h3', destination: 'Plant B', stream: 'WET', kg: 2 },
      { ...handover, id: 'h4', verified: false },
      { ...handover, id: 'h5', registeredVendor: false },
      { ...handover, id: 'h6', receiptId: '' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ destination: 'MRF A', stream: 'DRY', kg: { value: 1.5, provenance: 'VERIFIED', sourceIds: ['h1', 'receipt-1', 'h2', 'receipt-2'] } });
    expect(result[1].kg.value).toBe(2);
    expect(result[0].kg.definition).toContain('not a claim of recycling');
    expect(() => calculateDestinationWaste([handover, handover])).toThrow('Duplicate');
  });
});
