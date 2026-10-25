export const STREAMS = ['WET', 'DRY', 'SANITARY', 'SPECIAL_CARE'] as const;
export type Stream = (typeof STREAMS)[number];
export const SEGREGATIONS = ['GOOD', 'PARTIAL', 'MIXED'] as const;
export type Segregation = (typeof SEGREGATIONS)[number];
export const EXCEPTIONS = ['NOT_OUT', 'ACCESS_BLOCKED', 'CONTAMINATED', 'WRONG_STREAM', 'QUANTITY_DISPUTE', 'WEIGHT_UNAVAILABLE', 'OTHER'] as const;
export type ExceptionCode = (typeof EXCEPTIONS)[number];
export type Verdict = 'VERIFIED' | 'NEEDS_REVIEW' | 'REJECTED';
export type Transport = 'PENDING' | 'SYNCING' | 'SYNCED';
export type PhotoKind = 'DOORSTEP' | 'SCALE' | 'EXCEPTION';
export type PhotoStage = 'LOCAL' | 'PRESIGNED' | 'UPLOADED' | 'CONFIRMED';

export interface Membership { id: string; role: string; name?: string }
export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  user: { id: string; name?: string };
  memberships: Membership[];
  membershipId: string | null;
  registeredMemberships: string[];
}
export interface RouteStop {
  id: string;
  propertyId: string;
  property: { id: string; unitNo: string; block: string | null; latitude: number | null; longitude: number | null; propertyCode: string; qrToken: string | null };
  sequence: number;
  windowStart: string;
  windowEnd: string;
  streams: Stream[];
  status: string;
  lastPickup: unknown;
}
export interface Route { id: string; name: string; date: string; stops: RouteStop[] }
export interface Gps { latitude: number; longitude: number; accuracyM: number; gpsCapturedAt: string }
export interface LocalPhoto { id: string; uri: string; kind: PhotoKind; stream?: Stream; capturedAt: string; width: number; height: number }
export interface StreamDraft { stream: Stream; weight: string; segregation: Segregation; contamination: boolean; contaminationNote: string; photo: LocalPhoto | null }
export interface CaptureDraft {
  client_uuid: string;
  scope: string;
  routeId: string;
  routeDate: string;
  stop: RouteStop;
  qrToken: string | null;
  offline: boolean;
  gps: Gps | null;
  doorstep: LocalPhoto | null;
  streams: StreamDraft[];
  exception: { code: ExceptionCode; note: string; photo: LocalPhoto | null } | null;
}
export interface PickupPayload extends Gps {
  client_uuid: string;
  propertyId: string;
  routeStopId: string;
  deviceId: string;
  qrToken: string;
  capturedAt: string;
  offline: boolean;
  streams: { stream: Stream; kg: number; segregation: Segregation; contamination: boolean; contaminationNote?: string; photoId: string }[];
  doorstepPhotoId?: string;
  exception?: { code: ExceptionCode; note: string; photoId: string };
}
export interface Result {
  client_uuid: string;
  id: string;
  status: Verdict;
  verificationScore: number;
  verificationReasons: string[];
}
export interface QueueState {
  transport: Transport;
  verdict: Verdict | null;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  result: Result | null;
}
export interface QueueEvent extends QueueState {
  uuid: string;
  scope: string;
  stopId: string;
  captureJson: string;
  payloadJson: string | null;
  createdAt: string;
}
export interface PhotoRow {
  localId: string;
  eventUuid: string;
  uri: string;
  kind: PhotoKind;
  stream: Stream | null;
  stage: PhotoStage;
  photoId: string | null;
  uploadUrl: string | null;
  metadataJson: string | null;
}
export type ValidationCode = 'routeExpired' | 'identityRequired' | 'gpsRequired' | 'gpsStale' | 'doorstepRequired' | 'streamsRequired' | 'weightInvalid' | 'scaleRequired' | 'contaminationRequired' | 'exceptionRequired';

export function indiaDate(time = Date.now()): string {
  return new Date(time + 330 * 60_000).toISOString().slice(0, 10);
}

export interface ScaleAdapter { readonly kind: 'MANUAL' | 'BLUETOOTH'; readKg(manualInput?: string): number | Promise<number> }
export class ManualScaleAdapter implements ScaleAdapter {
  readonly kind = 'MANUAL' as const;
  readKg(value = ''): number {
    const trimmed = value.trim();
    if (!/^\d{1,7}(\.\d{1,3})?$/.test(trimmed)) throw new Error('weightInvalid');
    const grams = Math.round(Number(trimmed) * 1000);
    if (!Number.isSafeInteger(grams) || grams <= 0 || grams > 9_999_999_999) throw new Error('weightInvalid');
    return grams / 1000;
  }
}

// Match only the selected route/stop, never a global property lookup or decoded, unsigned QR.
export function resolveIdentity(route: Route, stopId: string, value: string, mode: 'QR' | 'CODE', now = Date.now()): string | null {
  if (route.date.slice(0, 10) !== indiaDate(now)) return null;
  const stop = route.stops.find((item) => item.id === stopId);
  if (!stop?.property.qrToken) return null;
  if (mode === 'QR') return value === stop.property.qrToken ? value : null;
  if (!/^\d{6}$/.test(value)) return null;
  const matches = route.stops.filter((item) => item.property.propertyCode === value);
  return matches.length === 1 && matches[0].id === stopId ? stop.property.qrToken : null;
}

export function validateDraft(draft: CaptureDraft, now = Date.now()): ValidationCode[] {
  const errors: ValidationCode[] = [];
  if (draft.routeDate.slice(0, 10) !== indiaDate(now)) errors.push('routeExpired');
  if (!draft.qrToken || draft.qrToken !== draft.stop.property.qrToken) errors.push('identityRequired');
  const gps = draft.gps;
  if (!gps || !Number.isFinite(gps.latitude) || Math.abs(gps.latitude) > 90 || !Number.isFinite(gps.longitude) || Math.abs(gps.longitude) > 180 || !Number.isFinite(gps.accuracyM) || gps.accuracyM < 0 || !Number.isFinite(Date.parse(gps.gpsCapturedAt))) errors.push('gpsRequired');
  else if (Math.abs(now - Date.parse(gps.gpsCapturedAt)) > 120_000) errors.push('gpsStale');
  if (!draft.doorstep || draft.doorstep.kind !== 'DOORSTEP') errors.push('doorstepRequired');
  if (draft.exception) {
    if (!EXCEPTIONS.includes(draft.exception.code) || draft.exception.note.trim().length < 3 || !draft.exception.photo || draft.exception.photo.kind !== 'EXCEPTION') errors.push('exceptionRequired');
  } else {
    if (!draft.streams.length || draft.streams.length !== draft.stop.streams.length || new Set(draft.streams.map((s) => s.stream)).size !== draft.streams.length || draft.streams.some((s) => !draft.stop.streams.includes(s.stream))) errors.push('streamsRequired');
    for (const stream of draft.streams) {
      try { new ManualScaleAdapter().readKg(stream.weight); } catch { errors.push('weightInvalid'); }
      if (!SEGREGATIONS.includes(stream.segregation)) errors.push('streamsRequired');
      if (!stream.photo || stream.photo.kind !== 'SCALE' || stream.photo.stream !== stream.stream) errors.push('scaleRequired');
      if (stream.contamination && stream.contaminationNote.trim().length < 3) errors.push('contaminationRequired');
    }
  }
  return [...new Set(errors)];
}

export function freezeCapture(draft: CaptureDraft, deviceId: string, now = Date.now()): { payload: PickupPayload; photos: LocalPhoto[] } {
  const errors = validateDraft(draft, now);
  if (errors.length || !draft.gps || !draft.doorstep || !draft.qrToken) throw new Error(errors[0] ?? 'identityRequired');
  const photos = [draft.doorstep];
  const payload: PickupPayload = {
    client_uuid: draft.client_uuid, propertyId: draft.stop.propertyId, routeStopId: draft.stop.id,
    deviceId, qrToken: draft.qrToken, capturedAt: new Date(now).toISOString(), ...draft.gps,
    offline: draft.offline, doorstepPhotoId: draft.doorstep.id, streams: [],
  };
  if (draft.exception?.photo) {
    photos.push(draft.exception.photo);
    payload.exception = { code: draft.exception.code, note: draft.exception.note.trim(), photoId: draft.exception.photo.id };
  } else {
    payload.streams = draft.streams.map((stream) => {
      if (!stream.photo) throw new Error('scaleRequired');
      photos.push(stream.photo);
      return { stream: stream.stream, kg: new ManualScaleAdapter().readKg(stream.weight), segregation: stream.segregation, contamination: stream.contamination, ...(stream.contamination ? { contaminationNote: stream.contaminationNote.trim() } : {}), photoId: stream.photo.id };
    });
  }
  return { payload, photos };
}

export function materializePayload(capture: PickupPayload, photos: PhotoRow[]): PickupPayload {
  const photoId = (localId: string): string => {
    const photo = photos.find((item) => item.localId === localId && item.eventUuid === capture.client_uuid);
    if (!photo?.photoId || photo.stage !== 'CONFIRMED') throw new Error('photoUnconfirmed');
    return photo.photoId;
  };
  return { ...capture, streams: capture.streams.map((stream) => ({ ...stream, photoId: photoId(stream.photoId) })), ...(capture.doorstepPhotoId ? { doorstepPhotoId: photoId(capture.doorstepPhotoId) } : {}), ...(capture.exception ? { exception: { ...capture.exception, photoId: photoId(capture.exception.photoId) } } : {}) };
}

export type QueueAction = { type: 'START' } | { type: 'RECOVER' } | { type: 'RETRY' } | { type: 'FAIL'; error: string; now: number; permanent?: boolean } | { type: 'ACK'; result: Result } | { type: 'HARD_REJECT'; error: string };
export const initialQueueState: QueueState = { transport: 'PENDING', verdict: null, attempts: 0, nextAttemptAt: 0, lastError: null, result: null };

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  if (action.type === 'ACK') return { ...state, transport: 'SYNCED', verdict: action.result.status, result: action.result, nextAttemptAt: 0, lastError: null };
  if (action.type === 'HARD_REJECT') return { ...state, transport: 'SYNCED', verdict: 'REJECTED', result: null, nextAttemptAt: 0, lastError: action.error };
  if (state.transport === 'SYNCED') return state;
  if (action.type === 'START') return { ...state, transport: 'SYNCING', attempts: state.attempts + 1, lastError: null };
  if (action.type === 'RECOVER') return { ...state, transport: 'PENDING', nextAttemptAt: 0 };
  if (action.type === 'RETRY') return { ...state, transport: 'PENDING', nextAttemptAt: 0, lastError: null };
  return { ...state, transport: 'PENDING', nextAttemptAt: action.permanent ? Number.MAX_SAFE_INTEGER : action.now + Math.min(3_600_000, 5_000 * 2 ** Math.min(Math.max(0, state.attempts - 1), 10)), lastError: action.error };
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalidResponse');
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('invalidResponse');
  return value;
}

export function parseResultRow(value: unknown): Result | null {
  try {
    const item = record(value);
    if (!['VERIFIED', 'NEEDS_REVIEW', 'REJECTED'].includes(String(item.status)) || typeof item.verificationScore !== 'number' || !Number.isFinite(item.verificationScore) || item.verificationScore < 0 || item.verificationScore > 100 || !Array.isArray(item.verificationReasons)) return null;
    return { client_uuid: text(item.client_uuid), id: text(item.id), status: item.status as Verdict, verificationScore: item.verificationScore, verificationReasons: item.verificationReasons.map((reason: unknown) => typeof reason === 'string' ? reason : JSON.stringify(reason)) };
  } catch { return null; }
}

export function parseResult(body: unknown, uuid: string): Result | null {
  try {
    const outer = record(body);
    const details = outer.error ? record(record(outer.error).details) : outer;
    const rows = Array.isArray(details.results) ? details.results : Array.isArray(details.data) ? [...details.data, ...(Array.isArray(details.rejectedSubmissions) ? details.rejectedSubmissions : [])] : [];
    for (const row of rows) {
      const result = parseResultRow(row);
      if (result?.client_uuid === uuid) return result;
    }
    return null;
  } catch { return null; }
}
