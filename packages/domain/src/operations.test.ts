import { describe, expect, it } from 'vitest';
import { billableMissedStops, verifiedStops } from './operations';
import { operationFixture, stopFixture, streamFixture } from './fixtures.test-helper';

describe('operation selection and validation order', () => {
  it('keeps schedule order with interleaved retries and exceptions, without mutating inputs', () => {
    const stops = ['s3', 's5', 's2', 's1', 's4'].map(stopFixture);
    const first = operationFixture({ id: 'e1' });
    const third = operationFixture({ id: 'e3', routeStopId: 's3' });
    const events = [
      first,
      operationFixture({ id: 'e2-rejected', routeStopId: 's2', status: 'REJECTED', capturedAt: 'ignored', streams: [] }),
      operationFixture({ id: 'e3-exception', routeStopId: 's3', capturedAt: 'ignored', streams: [], exception: { code: 'NOT_OUT', accepted: false } }),
      operationFixture({ id: 'e2-accepted', routeStopId: 's2', exception: { code: 'ACCESS_BLOCKED', accepted: true } }),
      operationFixture({ id: 'e5-rejected', routeStopId: 's5', status: 'REJECTED' }),
      third,
      operationFixture({ id: 'e2-review', routeStopId: 's2', status: 'NEEDS_REVIEW', exception: { code: 'NOT_OUT', accepted: false } }),
    ];
    const original = structuredClone({ stops, events });
    expect(verifiedStops(stops, events)).toEqual([{ stop: stops[0], event: third }, { stop: stops[3], event: first }]);
    expect(billableMissedStops(stops, events)).toEqual([stops[1], stops[4]]);
    expect({ stops, events }).toEqual(original);
  });

  it.each([verifiedStops, billableMissedStops])('%s rejects duplicate IDs and out-of-schedule events before validating windows', select => {
    const stop = { ...stopFixture(), windowEnd: '2026-01-15T00:00:00Z' };
    const event = operationFixture({ routeStopId: 'outside', status: 'REJECTED' });
    expect(() => select([stop, stop], [event, event])).toThrow('Duplicate scheduled stop ID');
    expect(() => select([stop], [event, event])).toThrow('Duplicate event ID');
    expect(() => select([stop], [event])).toThrow('Event is outside the supplied schedule');
    expect(() => select([stop], [])).toThrow('Invalid scheduled window');
  });

  it('validates windows and multiple verified candidates in schedule order, not event order', () => {
    const stops = ['s2', 's1'].map(stopFixture);
    const events = ['s1', 's2', 's1', 's2'].map((routeStopId, index) => operationFixture({ id: `e${index}`, routeStopId, capturedAt: 'invalid', streams: [] }));
    expect(() => verifiedStops(stops, events)).toThrow('Multiple verified events for stop s2; reconcile before aggregation');
    expect(() => verifiedStops([{ ...stops[0], windowEnd: '2026-01-15T00:00:00Z' }, stops[1]], events)).toThrow('Invalid scheduled window');
  });

  it('still validates a single verified candidate timestamp and distinct positive streams', () => {
    const stops = [stopFixture()];
    expect(() => verifiedStops(stops, [operationFixture({ capturedAt: 'invalid' })])).toThrow();
    for (const streams of [[], [streamFixture({ kg: 0 })], [streamFixture(), streamFixture()]]) {
      expect(() => verifiedStops(stops, [operationFixture({ streams })])).toThrow('Verified operations require distinct positive weighed streams');
    }
  });
});
