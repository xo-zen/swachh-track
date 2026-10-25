import { pickupSchema, type PickupRequest, type Stream, type VerificationStatus } from '@swachh/contracts';
import { haversineDistanceM, type Coordinates } from './geo';
import { DAY_MS, istDate, nonnegative, timestamp } from './primitives';
import { verifyQrToken, type QrKey } from './qr';

export type VerificationReasonCode = 'INVALID_INPUT' | 'INVALID_QR' | 'WRONG_PROPERTY' | 'WRONG_ROUTE' | 'DEVICE_NOT_BOUND' | 'GEOFENCE_FAILED' | 'LOW_GPS_ACCURACY' | 'GPS_STALE' | 'CLOCK_SKEW' | 'OFFLINE_CAPTURE' | 'MISSING_PHOTO' | 'INVALID_PHOTO' | 'GALLERY_PHOTO' | 'DUPLICATE_PHOTO' | 'PHOTO_TIME_MISMATCH' | 'EXCEPTION_RECORDED' | 'RANDOM_AUDIT';
export interface VerificationReason {
  code: VerificationReasonCode;
  severity: 'HARD' | 'SOFT';
  message: string;
  penalty: number;
}
export interface PhotoEvidence {
  id: string;
  tenantId: string;
  propertyId: string;
  collectorId: string;
  deviceId: string;
  kind: 'DOORSTEP' | 'SCALE' | 'EXCEPTION';
  stream?: Stream;
  captureSource: 'CAMERA' | 'GALLERY';
  normalized: boolean;
  sha256: string;
  capturedAt: string;
}
export interface PriorPhotoEvidence { propertyId: string; sha256: string; receivedAt: string }
export interface VerificationConfig {
  geofenceM?: number;
  maxAccuracyM?: number;
  maxClockSkewMs?: number;
  maxEvidenceAgeMs?: number;
  auditRate?: number;
}
export interface VerificationContext {
  tenantId: string;
  collectorId: string;
  receivedAt: string;
  property: Coordinates & { id: string; tenantId: string; qrTokenHash: string };
  qrKey: QrKey;
  device: { deviceId: string; collectorId: string; tenantId: string; active: boolean } | null;
  assignment: { routeStopId: string; propertyId: string; collectorId: string; tenantId: string; date: string; active: boolean } | null;
  photos: readonly PhotoEvidence[];
  priorPhotos: readonly PriorPhotoEvidence[];
  random: () => number;
  config?: VerificationConfig;
}
export interface VerificationResult {
  status: VerificationStatus;
  score: number;
  reasons: VerificationReason[];
  distanceM: number | null;
  auditRequested: boolean;
}

export function isDuplicatePhoto(sha256: string, propertyId: string, receivedAt: string, previous: readonly PriorPhotoEvidence[]): boolean {
  const now = timestamp(receivedAt);
  return previous.some(photo => {
    const age = now - timestamp(photo.receivedAt);
    return photo.propertyId === propertyId && photo.sha256.toLowerCase() === sha256.toLowerCase() && age >= 0 && age < DAY_MS;
  });
}

export function verifyPickup(request: PickupRequest, context: VerificationContext): VerificationResult {
  const reasons: VerificationReason[] = [];
  const add = (code: VerificationReasonCode, severity: VerificationReason['severity'], message: string, penalty = 100) => {
    if (!reasons.some(reason => reason.code === code)) reasons.push({ code, severity, message, penalty });
  };
  const parsed = pickupSchema.safeParse(request);
  if (!parsed.success) return {
    status: 'REJECTED', score: 0, distanceM: null, auditRequested: false,
    reasons: [{ code: 'INVALID_INPUT', severity: 'HARD', penalty: 100, message: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') }],
  };
  const event = parsed.data;
  const config = {
    geofenceM: context.config?.geofenceM ?? 75,
    maxAccuracyM: context.config?.maxAccuracyM ?? 50,
    maxClockSkewMs: context.config?.maxClockSkewMs ?? 300_000,
    maxEvidenceAgeMs: context.config?.maxEvidenceAgeMs ?? 300_000,
    auditRate: context.config?.auditRate ?? 0.05,
  };
  for (const [name, value] of Object.entries(config)) nonnegative(value, name);
  if (config.auditRate > 1) throw new RangeError('Audit rate must be between zero and one');
  const receivedAt = timestamp(context.receivedAt);
  const capturedAt = timestamp(event.capturedAt);
  const gpsAt = timestamp(event.gpsCapturedAt);
  if (event.propertyId !== context.property.id || context.property.tenantId !== context.tenantId) add('WRONG_PROPERTY', 'HARD', 'Property is outside the trusted context');
  if (!verifyQrToken(event.qrToken, context.property.id, context.qrKey, context.property.qrTokenHash)) add('INVALID_QR', 'HARD', 'Unknown, rotated or invalid QR token');
  const assignment = context.assignment;
  if (!assignment || !assignment.active || assignment.tenantId !== context.tenantId || assignment.collectorId !== context.collectorId || assignment.propertyId !== event.propertyId || assignment.routeStopId !== event.routeStopId || assignment.date !== istDate(event.capturedAt)) add('WRONG_ROUTE', 'HARD', 'No active assignment for this collector, property, stop and IST date');
  const device = context.device;
  if (!device || !device.active || device.deviceId !== event.deviceId || device.collectorId !== context.collectorId || device.tenantId !== context.tenantId) add('DEVICE_NOT_BOUND', 'HARD', 'Device is not actively bound to this collector');
  const distanceM = haversineDistanceM(context.property, event);
  if (distanceM > config.geofenceM) add('GEOFENCE_FAILED', 'HARD', `Location is ${Math.round(distanceM)} m away; maximum ${config.geofenceM} m`);
  if (event.accuracyM > config.maxAccuracyM) add('LOW_GPS_ACCURACY', 'SOFT', 'GPS accuracy exceeds the configured limit', 20);
  if (Math.abs(capturedAt - gpsAt) > config.maxEvidenceAgeMs) add('GPS_STALE', 'SOFT', 'GPS fix does not coincide with capture', 20);
  if (Math.abs(receivedAt - capturedAt) > config.maxClockSkewMs) add('CLOCK_SKEW', 'SOFT', 'Capture/receive difference exceeds the limit; offline delay cannot be distinguished from clock skew', 15);
  if (event.offline) add('OFFLINE_CAPTURE', 'SOFT', 'Captured offline; supervisor review required', 15);

  const required: { id: string; kind: PhotoEvidence['kind']; stream?: Stream }[] = [];
  if (event.doorstepPhotoId) required.push({ id: event.doorstepPhotoId, kind: 'DOORSTEP' });
  for (const stream of event.streams) required.push({ id: stream.photoId, kind: 'SCALE', stream: stream.stream });
  if (event.exception) {
    required.push({ id: event.exception.photoId, kind: 'EXCEPTION' });
    add('EXCEPTION_RECORDED', 'SOFT', `${event.exception.code}: ${event.exception.note}`, 30);
  }
  const hashes = new Set<string>();
  for (const evidence of required) {
    const matches = context.photos.filter(photo => photo.id === evidence.id);
    const photo = matches[0];
    if (!photo) { add('MISSING_PHOTO', 'HARD', 'Referenced proof photo is not confirmed by the server'); continue; }
    if (matches.length !== 1 || photo.tenantId !== context.tenantId || photo.propertyId !== event.propertyId || photo.collectorId !== context.collectorId || photo.deviceId !== event.deviceId || photo.kind !== evidence.kind || (evidence.stream && photo.stream !== evidence.stream) || !photo.normalized || !/^[a-f\d]{64}$/i.test(photo.sha256)) add('INVALID_PHOTO', 'HARD', 'Photo ownership, kind, stream or normalized image metadata is invalid');
    if (photo.captureSource !== 'CAMERA') add('GALLERY_PHOTO', 'HARD', 'Only camera evidence is accepted');
    let photoTime: number;
    try { photoTime = timestamp(photo.capturedAt); } catch { add('INVALID_PHOTO', 'HARD', 'Invalid photo capture timestamp'); continue; }
    if (Math.abs(photoTime - capturedAt) > config.maxEvidenceAgeMs) add('PHOTO_TIME_MISMATCH', 'SOFT', 'Proof photo timestamp differs from pickup capture', 20);
    const hash = photo.sha256.toLowerCase();
    if (hashes.has(hash) || isDuplicatePhoto(hash, event.propertyId, context.receivedAt, context.priorPhotos)) add('DUPLICATE_PHOTO', 'HARD', 'Normalized image was reused at this stop or property within 24 server-receive hours');
    hashes.add(hash);
  }
  let auditRequested = false;
  if (reasons.length === 0 && config.auditRate > 0) {
    const draw = context.random();
    if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new RangeError('Random sample must be in [0,1)');
    auditRequested = draw < config.auditRate;
    if (auditRequested) add('RANDOM_AUDIT', 'SOFT', 'Selected for supervisor audit', 5);
  }
  const hard = reasons.some(reason => reason.severity === 'HARD');
  return {
    status: hard ? 'REJECTED' : reasons.length ? 'NEEDS_REVIEW' : 'VERIFIED',
    score: hard ? 0 : Math.max(0, 100 - reasons.reduce((sum, reason) => sum + reason.penalty, 0)),
    reasons, distanceM, auditRequested,
  };
}
