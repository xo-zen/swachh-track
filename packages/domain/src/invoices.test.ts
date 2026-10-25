import { describe, expect, it } from 'vitest';
import { billableMissedStops, calculateInvoice, calculateWeightChargePaise, kgToGrams, sumKg, verifiedStops } from './index';
import { operationFixture, stopFixture, streamFixture } from './fixtures.test-helper';

function fixture() {
  return {
    activeFlats: 2, activeFlatsQueryRef: 'society-a/active-flats/2026-01',
    stops: ['s1', 's2', 's3', 's4', 's5'].map(stopFixture),
    events: [
      operationFixture({ streams: [streamFixture({ kg: 1.5 }), streamFixture({ stream: 'DRY', kg: 0.5 })] }),
      operationFixture({ id: 'e2', routeStopId: 's2', streams: [streamFixture({ kg: 2 }), streamFixture({ stream: 'DRY', kg: 1 })] }),
      operationFixture({ id: 'e3', routeStopId: 's3', status: 'REJECTED', streams: [streamFixture({ kg: 99 })] }),
      operationFixture({ id: 'e4', routeStopId: 's4', status: 'NEEDS_REVIEW', streams: [], exception: { code: 'NOT_OUT', accepted: true } }),
    ],
    rates: { perFlatPaise: 10_000, perVerifiedStopPaise: 123, handlingPaisePerKg: { WET: 125, DRY: 101 }, missedStopDeductionPaise: 100 },
    adjustments: [{ amountPaise: -36, reason: 'Agreed service adjustment' }],
  };
}
describe('integer paise billing and operation provenance', () => {
  it('calculates exact fixed service, pickup, handling, deduction and adjustment lines', () => {
    const result = calculateInvoice(fixture());
    expect(result.lines.map(line => line.amountPaise)).toEqual([20000, 246, 438, 152, -200, -36]);
    expect(result).toMatchObject({ currency: 'INR', subtotalPaise: 20836, deductionsPaise: 236, totalPaise: 20600 });
    expect(result.lines.find(line => line.type === 'PICKUP')).toMatchObject({ eventIds: ['e1', 'e2'], stopIds: ['s1', 's2'], quantity: 2 });
    expect(result.lines.find(line => line.stream === 'WET')).toMatchObject({ quantity: 3.5, eventIds: ['e1', 'e2'], stopIds: ['s1', 's2'] });
    expect(result.lines.find(line => line.type === 'MISSED_DEDUCTION')).toMatchObject({ stopIds: ['s3', 's5'], eventIds: ['e3'], quantity: 2 });
    expect(result.lines[0].aggregateQueryRef).toBe('society-a/active-flats/2026-01');
    expect(result.lines.every(line => Number.isSafeInteger(line.amountPaise))).toBe(true);
  });
  it('rounds half-up once per aggregated stream, not once per event', () => {
    expect(calculateWeightChargePaise(0.005, 100)).toBe(1);
    expect(calculateWeightChargePaise(0.004, 100)).toBe(0);
    expect(calculateWeightChargePaise(1.255, 100)).toBe(126);
    const input = fixture();
    input.events[0].streams = [streamFixture({ kg: 0.004 })];
    input.events[1].streams = [streamFixture({ kg: 0.004 })];
    input.rates.handlingPaisePerKg.WET = 100;
    expect(calculateInvoice(input).lines.find(line => line.stream === 'WET')?.amountPaise).toBe(1);
  });
  it('deducts unaccepted exceptions but not accepted exceptions or verified stops', () => {
    const input = fixture();
    expect(billableMissedStops(input.stops, input.events).map(stop => stop.id)).toEqual(['s3', 's5']);
    input.events[3].exception = { code: 'ACCESS_BLOCKED', accepted: false };
    expect(billableMissedStops(input.stops, input.events).map(stop => stop.id)).toEqual(['s3', 's4', 's5']);
    input.events[3].status = 'VERIFIED';
    expect(verifiedStops(input.stops, input.events)).toHaveLength(2);
  });
  it('rejects duplicate records, ambiguous multiple verified events and out-of-scope events', () => {
    const input = fixture();
    expect(() => calculateInvoice({ ...input, stops: [...input.stops, input.stops[0]] })).toThrow('Duplicate scheduled');
    expect(() => calculateInvoice({ ...input, events: [...input.events, input.events[0]] })).toThrow('Duplicate event');
    expect(() => calculateInvoice({ ...input, events: [...input.events, { ...input.events[0], id: 'different' }] })).toThrow('Multiple verified');
    expect(() => calculateInvoice({ ...input, events: [operationFixture({ routeStopId: 'foreign-stop' })] })).toThrow('outside');
  });
  it('rejects missing provenance, fractional paise, unsafe money, no-reason adjustments and negative totals', () => {
    const input = fixture();
    expect(() => calculateInvoice({ ...input, activeFlatsQueryRef: '' })).toThrow('query reference');
    expect(() => calculateInvoice({ ...input, activeFlats: 1.5 })).toThrow();
    expect(() => calculateInvoice({ ...input, rates: { perFlatPaise: 1.1 } })).toThrow();
    expect(() => calculateInvoice({ ...input, rates: { perFlatPaise: Number.MAX_SAFE_INTEGER } })).toThrow();
    expect(() => calculateInvoice({ ...input, adjustments: [{ amountPaise: 1, reason: ' ' }] })).toThrow();
    expect(() => calculateInvoice({ ...input, adjustments: [{ amountPaise: -100000, reason: 'Too much credit' }] })).toThrow('negative');
    expect(() => calculateWeightChargePaise(1.2345, 1)).toThrow();
    expect(() => calculateWeightChargePaise(1, -1)).toThrow();
    expect(() => calculateInvoice({ ...input, events: [operationFixture({ streams: [] })] })).toThrow('weighed streams');
    expect(() => calculateInvoice({ ...input, events: [operationFixture({ streams: [streamFixture({ kg: 0 })] })] })).toThrow('weighed streams');
  });
  it('supports exact grams and empty scopes without floating point drift', () => {
    expect(kgToGrams(1.001)).toBe(1001);
    expect(sumKg([0.1, 0.2])).toBe(0.3);
    expect(() => kgToGrams(-1)).toThrow();
    expect(calculateInvoice({ activeFlats: 0, activeFlatsQueryRef: 'empty-scope', stops: [], events: [], rates: { perFlatPaise: 100 } }).totalPaise).toBe(0);
  });
});
