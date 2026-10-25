import { describe, expect, it } from 'vitest';
import { batchSchema, certificateSchema, complaintSchema, complaintTransitionSchema, dateSchema, deviceRegistrationSchema, eligibilitySchema, handoverSchema, invoiceGenerateSchema, listQuerySchema, paymentSchema, photoConfirmSchema, photoPresignSchema, pickupSchema, propertySchema, ratingSchema, ROLES, scheduleSchema, STREAMS, vendorSchema } from './index';

const id = '11111111-1111-4111-8111-111111111111';
const photoId = '22222222-2222-4222-8222-222222222222';
const time = '2026-01-15T03:00:00Z';
function pickup() {
  return { client_uuid: id, propertyId: id, routeStopId: id, deviceId: 'device-a', qrToken: 'signed-token', capturedAt: time, latitude: 18.52, longitude: 73.85, accuracyM: 10, gpsCapturedAt: time, offline: false, streams: [{ stream: 'WET' as const, kg: 4.2, segregation: 'GOOD' as const, contamination: false, photoId }], doorstepPhotoId: id };
}
describe('locked pickup wire contract', () => {
  it('accepts camelCase and mandatory client_uuid with exactly the four stream enums', () => {
    expect(pickupSchema.parse(pickup())).toEqual(pickup());
    expect(STREAMS).toEqual(['WET', 'DRY', 'SANITARY', 'SPECIAL_CARE']);
    expect(ROLES).toHaveLength(6);
    const { client_uuid: omitted, ...rest } = pickup();
    expect(omitted).toBe(id);
    expect(pickupSchema.safeParse({ ...rest, clientUuid: id }).success).toBe(false);
  });
  it('rejects unknown fields at every object level, including client hashes and server-owned status', () => {
    expect(pickupSchema.safeParse({ ...pickup(), photoHash: 'spoof' }).success).toBe(false);
    expect(pickupSchema.safeParse({ ...pickup(), status: 'VERIFIED' }).success).toBe(false);
    expect(pickupSchema.safeParse({ ...pickup(), property_id: id }).success).toBe(false);
    expect(pickupSchema.safeParse({ ...pickup(), streams: [{ ...pickup().streams[0], sha256: 'spoof' }] }).success).toBe(false);
    expect(pickupSchema.safeParse({ ...pickup(), exception: { code: 'OTHER', note: 'Test', photoId, approved: true } }).success).toBe(false);
  });
  it('requires complete collection evidence and distinct streams', () => {
    expect(pickupSchema.safeParse({ ...pickup(), streams: [] }).success).toBe(false);
    expect(pickupSchema.safeParse({ ...pickup(), doorstepPhotoId: undefined }).success).toBe(false);
    expect(pickupSchema.safeParse({ ...pickup(), streams: [pickup().streams[0], pickup().streams[0]] }).success).toBe(false);
    expect(pickupSchema.safeParse({ ...pickup(), streams: [{ ...pickup().streams[0], photoId: undefined }] }).success).toBe(false);
    expect(pickupSchema.safeParse({ ...pickup(), streams: [{ ...pickup().streams[0], contamination: true }] }).success).toBe(false);
    expect(pickupSchema.safeParse({ ...pickup(), streams: [{ ...pickup().streams[0], contamination: true, contaminationNote: 'Plastic mixed in' }] }).success).toBe(true);
  });
  it('accepts evidenced exception-only events with omitted or empty streams', () => {
    const event = { ...pickup(), streams: undefined, doorstepPhotoId: undefined, exception: { code: 'WEIGHT_UNAVAILABLE', note: 'No scale available', photoId } };
    expect(pickupSchema.parse(event).streams).toEqual([]);
    expect(pickupSchema.safeParse({ ...event, streams: [] }).success).toBe(true);
    expect(pickupSchema.safeParse({ ...event, exception: { ...event.exception, note: ' ' } }).success).toBe(false);
    expect(pickupSchema.safeParse({ ...event, exception: { ...event.exception, photoId: 'not-a-uuid' } }).success).toBe(false);
  });
  it.each([0, -1, NaN, Infinity, 1.0001, 10000000])('rejects invalid kg %s', kg => {
    expect(pickupSchema.safeParse({ ...pickup(), streams: [{ ...pickup().streams[0], kg }] }).success).toBe(false);
  });
  it('validates coordinates, GPS timestamp, UUID, boolean and ISO timezone without coercion', () => {
    for (const patch of [{ latitude: 90.1 }, { longitude: -181 }, { accuracyM: -1 }, { capturedAt: '2026-01-15' }, { capturedAt: '2026-01-15T03:00:00+99:99' }, { gpsCapturedAt: '2026-01-15T03:00:00' }, { client_uuid: 'invalid' }, { offline: 'false' }]) {
      expect(pickupSchema.safeParse({ ...pickup(), ...patch }).success).toBe(false);
    }
    expect(pickupSchema.safeParse({ ...pickup(), capturedAt: '2026-01-15T08:30:00+05:30' }).success).toBe(true);
  });
  it('bounds strict batches to 1..500 events', () => {
    expect(batchSchema.safeParse({ events: [] }).success).toBe(false);
    expect(batchSchema.safeParse({ events: Array.from({ length: 500 }, pickup) }).success).toBe(true);
    expect(batchSchema.safeParse({ events: Array.from({ length: 501 }, pickup) }).success).toBe(false);
    expect(batchSchema.safeParse({ events: [pickup()], totalKg: 4.2 }).success).toBe(false);
  });
});
describe('strict standard operation schemas', () => {
  it('checks schedule calendars, unique weekdays, cycles and windows', () => {
    const schedule = { stream: 'DRY', pattern: { type: 'WEEKLY', weekdays: [1, 4] }, windowStart: '08:00', windowEnd: '10:00', activeFrom: '2026-01-01' };
    expect(scheduleSchema.safeParse(schedule).success).toBe(true);
    expect(scheduleSchema.safeParse({ ...schedule, pattern: { type: 'EVERY_N_DAYS', everyNDays: 4 } }).success).toBe(true);
    expect(scheduleSchema.safeParse({ ...schedule, pattern: { type: 'WEEKLY', weekdays: [1, 1] } }).success).toBe(false);
    expect(scheduleSchema.safeParse({ ...schedule, windowEnd: '07:00' }).success).toBe(false);
    expect(scheduleSchema.safeParse({ ...schedule, activeTo: '2025-12-31' }).success).toBe(false);
    expect(dateSchema.safeParse('2025-02-29').success).toBe(false);
    expect(dateSchema.safeParse('2024-02-29').success).toBe(true);
  });
  it('requires complaint photo and resolution proof but uses configurable category IDs', () => {
    const complaint = { propertyId: id, categoryId: id, description: 'Vehicle did not arrive', photoId };
    expect(complaintSchema.safeParse(complaint).success).toBe(true);
    expect(complaintSchema.safeParse({ ...complaint, photoId: undefined }).success).toBe(false);
    expect(complaintTransitionSchema.safeParse({ status: 'RESOLVED', note: 'Done' }).success).toBe(false);
    expect(complaintTransitionSchema.safeParse({ status: 'RESOLVED', note: 'Done', photoId }).success).toBe(true);
    expect(complaintTransitionSchema.safeParse({ status: 'WAITING_FOR_RESIDENT' }).success).toBe(false);
  });
  it('validates money, manual reasons, ratings and pagination', () => {
    expect(paymentSchema.safeParse({ amountPaise: 1.5, paidAt: time, reference: 'cash' }).success).toBe(false);
    expect(paymentSchema.safeParse({ amountPaise: 100, paidAt: time, reference: 'cash' }).success).toBe(true);
    expect(invoiceGenerateSchema.safeParse({ periodStart: '2026-01-01', periodEnd: '2026-01-31', dueDate: '2026-02-07', adjustmentPaise: -100 }).success).toBe(false);
    expect(ratingSchema.safeParse({ punctuality: 4, quality: 5, guidance: 3 }).success).toBe(true);
    expect(ratingSchema.safeParse({ punctuality: 6, quality: 5, guidance: 3 }).success).toBe(false);
    expect(listQuerySchema.parse({}).limit).toBe(25);
    expect(listQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(listQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
  it('excludes server state from property/device, certificate, handover and file confirmation', () => {
    expect(propertySchema.safeParse({ unitNo: 'A-1', latitude: 0, longitude: 0, tenantId: id }).success).toBe(false);
    expect(deviceRegistrationSchema.safeParse({ deviceId: 'd', platform: 'ANDROID', appVersion: '1.0', collectorId: id }).success).toBe(false);
    expect(photoConfirmSchema.safeParse({ photoId, sha256: 'client-hash' }).success).toBe(false);
    expect(photoPresignSchema.safeParse({ kind: 'SCALE', stream: 'WET', captureSource: 'GALLERY', contentType: 'image/jpeg', sizeBytes: 100, capturedAt: time }).success).toBe(false);
    expect(certificateSchema.safeParse({ certificateNo: 'ULB-001', issuingUlbId: id, stream: 'WET', kg: 100, issuedAt: '2026-01-01', documentId: photoId }).success).toBe(true);
    expect(handoverSchema.safeParse({ date: '2026-01-01', vendorId: id, stream: 'DRY', kg: 10, receiptNumber: 'R-1', documentId: photoId, destination: 'Registered recycler' }).success).toBe(true);
    expect(vendorSchema.safeParse({ name: 'Vendor', kind: 'RECYCLER', authorisationNumber: 'A-1', validFrom: '2026-01-01', validUntil: '2025-01-01', documentId: photoId }).success).toBe(false);
    expect(eligibilitySchema.parse({ floorAreaSqm: 1000, waterLitresPerDay: 1, wasteKgPerDay: 1, flats: 1 }).isRwaOrGatedCommunity).toBe(true);
  });
});
