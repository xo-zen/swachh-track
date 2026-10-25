import { describe, expect, it, vi } from 'vitest';
import { haversineDistanceM, hashQrToken, isDuplicatePhoto, signQrToken, verifyPickup, verifyQrToken } from './index';
import { IDS, KEY, NOW, pickupFixture } from './fixtures.test-helper';

describe('versioned QR tokens', () => {
  it('matches a fixed HMAC fixture and wraps propertyId.signature in canonical base64url', () => {
    const token = signQrToken(IDS.property, KEY);
    expect(token).toBe('MTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExLlJrTFpRNng5RWZBaElvTVFkakJUTW9CQXQtczR4ZkVPQ0VnLXBoNHVFYjQ');
    expect(Buffer.from(token, 'base64url').toString()).toMatch(/^11111111-1111-4111-8111-111111111111\.[\w-]{43}$/);
    expect(verifyQrToken(token, IDS.property, KEY, hashQrToken(token))).toBe(true);
  });
  it('rejects wrong property, changed signature, secret/version rotation and revoked stored hash', () => {
    const token = signQrToken(IDS.property, KEY);
    expect(verifyQrToken(token, IDS.stop, KEY)).toBe(false);
    const tampered = Buffer.from(`${IDS.property}.${'A'.repeat(43)}`).toString('base64url');
    expect(verifyQrToken(tampered, IDS.property, KEY)).toBe(false);
    expect(verifyQrToken(token, IDS.property, { ...KEY, version: 'v2' })).toBe(false);
    expect(verifyQrToken(token, IDS.property, { ...KEY, secret: 'new-secret' })).toBe(false);
    expect(verifyQrToken(token, IDS.property, KEY, '0'.repeat(64))).toBe(false);
    expect(verifyQrToken(token, IDS.property, KEY, 'bad')).toBe(false);
    expect(verifyQrToken(signQrToken(IDS.property, { ...KEY, version: 'v2' }), IDS.property, { ...KEY, version: 'v2' })).toBe(true);
  });
  it.each(['', '%%%not-base64', 'AA==', 'a'.repeat(513), Buffer.from(`${IDS.property}.short`).toString('base64url')])('rejects malformed QR %s without a buffer-length crash', token => {
    expect(verifyQrToken(token, IDS.property, KEY)).toBe(false);
  });
  it('requires a UUID and configured secret/version', () => {
    expect(() => signQrToken('property', KEY)).toThrow();
    expect(() => signQrToken(IDS.property, { version: '', secret: '' })).toThrow();
  });
});

describe('haversine', () => {
  it('has zero distance and matches fixed equator and antipodal distances', () => {
    expect(haversineDistanceM({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 })).toBe(0);
    expect(haversineDistanceM({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })).toBeCloseTo(111194.9266, 3);
    expect(haversineDistanceM({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 })).toBeCloseTo(20015086.796, 2);
    expect(haversineDistanceM({ latitude: 0, longitude: 179.999 }, { latitude: 0, longitude: -179.999 })).toBeCloseTo(222.38985, 3);
  });
  it('rejects invalid coordinates', () => {
    expect(() => haversineDistanceM({ latitude: 91, longitude: 0 }, { latitude: 0, longitude: 0 })).toThrow();
    expect(() => haversineDistanceM({ latitude: 0, longitude: NaN }, { latitude: 0, longitude: 0 })).toThrow();
  });
});

describe('pickup evidence verification', () => {
  it('verifies a complete fixed fixture without mutation', () => {
    const { event, context } = pickupFixture();
    const before = JSON.stringify(event);
    expect(verifyPickup(event, context)).toEqual({ status: 'VERIFIED', score: 100, reasons: [], distanceM: 0, auditRequested: false });
    expect(JSON.stringify(event)).toBe(before);
  });
  it('requires positive three-decimal weights and all per-stream photos', () => {
    for (const kg of [0, -1, NaN, Infinity, 1.0001, 10_000_000]) {
      const { event, context } = pickupFixture();
      event.streams[0].kg = kg;
      expect(verifyPickup(event, context).status).toBe('REJECTED');
    }
    const { event, context } = pickupFixture();
    event.streams.push({ ...event.streams[0], stream: 'DRY', photoId: IDS.dryScale });
    expect(verifyPickup(event, context).status).toBe('VERIFIED');
    context.photos = context.photos.filter(photo => photo.id !== IDS.dryScale);
    expect(verifyPickup(event, context).reasons.map(reason => reason.code)).toContain('MISSING_PHOTO');
  });
  it('rejects empty collection, absent doorstep, repeated streams and untrusted client hashes', () => {
    const { event, context } = pickupFixture();
    expect(verifyPickup({ ...event, streams: [] }, context).status).toBe('REJECTED');
    expect(verifyPickup({ ...event, doorstepPhotoId: undefined }, context).status).toBe('REJECTED');
    expect(verifyPickup({ ...event, streams: [event.streams[0], event.streams[0]] }, context).status).toBe('REJECTED');
    const injected = { ...event, photoHash: 'a'.repeat(64) };
    expect(verifyPickup(injected, context).status).toBe('REJECTED');
  });
  it.each(['WEIGHT_UNAVAILABLE', 'NOT_OUT', 'ACCESS_BLOCKED', 'CONTAMINATED', 'WRONG_STREAM', 'QUANTITY_DISPUTE', 'OTHER'] as const)('accepts evidenced %s without streams only as review', code => {
    const { event, context } = pickupFixture();
    const result = verifyPickup({ ...event, streams: undefined, doorstepPhotoId: undefined, exception: { code, note: 'Evidence recorded', photoId: IDS.exception } }, context);
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.score).toBe(70);
    expect(result.reasons[0].code).toBe('EXCEPTION_RECORDED');
  });
  it('requires valid exception note/photo and retains hard checks for exceptions', () => {
    const { event, context } = pickupFixture();
    const exception = { code: 'WEIGHT_UNAVAILABLE' as const, note: 'Scale unavailable', photoId: IDS.exception };
    expect(verifyPickup({ ...event, streams: [], exception: { ...exception, note: '' } }, context).status).toBe('REJECTED');
    context.photos = [];
    expect(verifyPickup({ ...event, streams: [], exception }, context).status).toBe('REJECTED');
    context.device = null;
    expect(verifyPickup({ ...event, streams: [], exception }, context).reasons.map(reason => reason.code)).toContain('DEVICE_NOT_BOUND');
  });
  it('rejects unknown QR/property, assignment and device mismatches including tenant mismatch', () => {
    const { event, context } = pickupFixture();
    expect(verifyPickup({ ...event, qrToken: 'tampered' }, context).reasons[0].code).toBe('INVALID_QR');
    expect(verifyPickup(event, { ...context, property: { ...context.property, tenantId: 'tenant-b' } }).reasons[0].code).toBe('WRONG_PROPERTY');
    expect(verifyPickup(event, { ...context, assignment: null }).reasons.map(reason => reason.code)).toContain('WRONG_ROUTE');
    const assignment = context.assignment!;
    for (const patch of [{ tenantId: 'tenant-b' }, { collectorId: 'other' }, { propertyId: IDS.event }, { routeStopId: IDS.event }, { date: '2026-01-14' }, { active: false }]) {
      expect(verifyPickup(event, { ...context, assignment: { ...assignment, ...patch } }).status).toBe('REJECTED');
    }
    const device = context.device!;
    for (const patch of [{ tenantId: 'tenant-b' }, { collectorId: 'other' }, { deviceId: 'other' }, { active: false }]) {
      expect(verifyPickup(event, { ...context, device: { ...device, ...patch } }).reasons.map(reason => reason.code)).toContain('DEVICE_NOT_BOUND');
    }
  });
  it('uses IST route date rather than UTC date', () => {
    const { event, context } = pickupFixture();
    const time = '2026-01-14T19:00:00Z';
    const result = verifyPickup({ ...event, capturedAt: time, gpsCapturedAt: time }, { ...context, receivedAt: time, photos: context.photos.map(photo => ({ ...photo, capturedAt: time })) });
    expect(result.status).toBe('VERIFIED');
  });
  it('has configurable hard geofence and soft accuracy boundaries', () => {
    const { event, context } = pickupFixture();
    expect(verifyPickup({ ...event, accuracyM: 50 }, context).status).toBe('VERIFIED');
    expect(verifyPickup({ ...event, accuracyM: 50.001 }, context)).toMatchObject({ status: 'NEEDS_REVIEW', score: 80 });
    const distant = { ...event, latitude: event.latitude + 0.001 };
    expect(verifyPickup(distant, context)).toMatchObject({ status: 'REJECTED', score: 0 });
    expect(verifyPickup(distant, { ...context, config: { geofenceM: 120 } }).status).toBe('VERIFIED');
    const distance = haversineDistanceM(context.property, distant);
    expect(verifyPickup(distant, { ...context, config: { geofenceM: distance } }).status).toBe('VERIFIED');
  });
  it('scores soft flags deterministically and never overrides hard failures', () => {
    const { event, context } = pickupFixture();
    const result = verifyPickup({ ...event, offline: true, accuracyM: 51 }, { ...context, receivedAt: '2026-01-15T03:06:00Z' });
    expect(result).toMatchObject({ status: 'NEEDS_REVIEW', score: 50 });
    expect(result.reasons.map(reason => reason.code)).toEqual(['LOW_GPS_ACCURACY', 'CLOCK_SKEW', 'OFFLINE_CAPTURE']);
    expect(verifyPickup({ ...event, offline: true, qrToken: 'bad' }, context)).toMatchObject({ status: 'REJECTED', score: 0 });
    expect(verifyPickup(event, { ...context, receivedAt: '2026-01-15T03:05:00Z' }).status).toBe('VERIFIED');
    expect(verifyPickup({ ...event, gpsCapturedAt: '2026-01-15T02:54:59Z' }, context).reasons[0].code).toBe('GPS_STALE');
    expect(verifyPickup(event, { ...context, receivedAt: '2026-01-15T02:54:59Z' }).reasons[0].code).toBe('CLOCK_SKEW');
  });
  it('rejects gallery, unnormalized, wrong owner/kind/stream and invalid image hashes', () => {
    const { event, context } = pickupFixture();
    for (const patch of [{ captureSource: 'GALLERY' as const }, { normalized: false }, { tenantId: 'tenant-b' }, { propertyId: IDS.event }, { collectorId: 'other' }, { deviceId: 'other' }, { kind: 'EXCEPTION' as const }, { sha256: 'client-hash' }, { stream: 'DRY' as const }]) {
      const result = verifyPickup(event, { ...context, photos: context.photos.map(photo => photo.id === IDS.scale ? { ...photo, ...patch } : photo) });
      expect(result.status).toBe('REJECTED');
    }
    expect(verifyPickup(event, { ...context, photos: context.photos.map(photo => ({ ...photo, capturedAt: '2026-01-15T02:54:00Z' })) })).toMatchObject({ status: 'NEEDS_REVIEW', score: 80 });
  });
  it('rejects repeated hashes within a stop or same property within 24 server hours', () => {
    const { event, context } = pickupFixture();
    expect(verifyPickup(event, { ...context, photos: context.photos.map(photo => ({ ...photo, sha256: 'a'.repeat(64) })) }).reasons.map(reason => reason.code)).toContain('DUPLICATE_PHOTO');
    const previous = { propertyId: event.propertyId, sha256: 'B'.repeat(64), receivedAt: '2026-01-14T03:00:00.001Z' };
    expect(verifyPickup(event, { ...context, priorPhotos: [previous] }).status).toBe('REJECTED');
    expect(isDuplicatePhoto('b'.repeat(64), event.propertyId, NOW, [{ ...previous, receivedAt: '2026-01-14T03:00:00Z' }])).toBe(false);
    expect(isDuplicatePhoto('b'.repeat(64), IDS.stop, NOW, [previous])).toBe(false);
    expect(isDuplicatePhoto('b'.repeat(64), event.propertyId, NOW, [{ ...previous, receivedAt: '2026-01-15T03:00:01Z' }])).toBe(false);
  });
  it('injects audit randomness with an exact 5% boundary and only audits otherwise valid events', () => {
    const { event, context } = pickupFixture();
    expect(verifyPickup(event, { ...context, random: () => 0.049999 })).toMatchObject({ status: 'NEEDS_REVIEW', score: 95, auditRequested: true });
    expect(verifyPickup(event, { ...context, random: () => 0.05 }).status).toBe('VERIFIED');
    const random = vi.fn(() => 0);
    verifyPickup({ ...event, offline: true }, { ...context, random });
    expect(random).not.toHaveBeenCalled();
    expect(() => verifyPickup(event, { ...context, random: () => 1 })).toThrow();
    expect(() => verifyPickup(event, { ...context, config: { auditRate: -1 } })).toThrow();
    expect(verifyPickup(event, { ...context, config: { auditRate: 0 }, random: () => 1 }).status).toBe('VERIFIED');
  });
});
