import type { PickupInput, PickupStream } from '@swachh/contracts';
import { hashQrToken, signQrToken } from './qr';
import type { VerificationContext } from './verification';
import type { OperationEvent, ScheduledStop } from './operations';

export const IDS = {
  property: '11111111-1111-4111-8111-111111111111', stop: '22222222-2222-4222-8222-222222222222',
  event: '33333333-3333-4333-8333-333333333333', doorstep: '44444444-4444-4444-8444-444444444444',
  scale: '55555555-5555-4555-8555-555555555555', exception: '66666666-6666-4666-8666-666666666666',
  dryScale: '77777777-7777-4777-8777-777777777777',
};
export const KEY = { version: 'v1', secret: 'fixture-secret-not-production' };
export const NOW = '2026-01-15T03:00:00.000Z';
export function pickupFixture(): { event: PickupInput; context: VerificationContext } {
  const qrToken = signQrToken(IDS.property, KEY);
  const event: PickupInput = {
    client_uuid: IDS.event, propertyId: IDS.property, routeStopId: IDS.stop, deviceId: 'fixture-device',
    qrToken, capturedAt: NOW, gpsCapturedAt: NOW, latitude: 18.5204, longitude: 73.8567, accuracyM: 10,
    offline: false, doorstepPhotoId: IDS.doorstep,
    streams: [{ stream: 'WET', kg: 4.2, segregation: 'GOOD', contamination: false, photoId: IDS.scale }],
  };
  const owner = { tenantId: 'tenant-a', propertyId: IDS.property, collectorId: 'collector-a', deviceId: event.deviceId, captureSource: 'CAMERA' as const, normalized: true, capturedAt: NOW };
  return {
    event,
    context: {
      tenantId: 'tenant-a', collectorId: 'collector-a', receivedAt: NOW,
      property: { id: IDS.property, tenantId: 'tenant-a', latitude: event.latitude, longitude: event.longitude, qrTokenHash: hashQrToken(qrToken) },
      qrKey: KEY,
      device: { tenantId: 'tenant-a', collectorId: 'collector-a', deviceId: event.deviceId, active: true },
      assignment: { routeStopId: IDS.stop, propertyId: IDS.property, tenantId: 'tenant-a', collectorId: 'collector-a', date: '2026-01-15', active: true },
      photos: [
        { ...owner, id: IDS.doorstep, kind: 'DOORSTEP', sha256: 'a'.repeat(64) },
        { ...owner, id: IDS.scale, kind: 'SCALE', stream: 'WET', sha256: 'b'.repeat(64) },
        { ...owner, id: IDS.exception, kind: 'EXCEPTION', sha256: 'c'.repeat(64) },
        { ...owner, id: IDS.dryScale, kind: 'SCALE', stream: 'DRY', sha256: 'd'.repeat(64) },
      ],
      priorPhotos: [], random: () => 0.5,
    },
  };
}
export function streamFixture(overrides: Partial<PickupStream> = {}): PickupStream {
  return { stream: 'WET', kg: 1, segregation: 'GOOD', contamination: false, photoId: IDS.scale, ...overrides };
}
export function operationFixture(overrides: Partial<OperationEvent> = {}): OperationEvent {
  return { id: 'e1', routeStopId: 's1', status: 'VERIFIED', capturedAt: NOW, streams: [streamFixture()], offline: false, ...overrides };
}
export function stopFixture(id = 's1'): ScheduledStop {
  return { id, windowStart: '2026-01-15T02:30:00.000Z', windowEnd: '2026-01-15T03:30:00.000Z' };
}
