import { describe, expect, it } from 'vitest';
import {
  ManualScaleAdapter, freezeCapture, indiaDate, initialQueueState, materializePayload,
  parseResult, queueReducer, resolveIdentity, validateDraft,
  type CaptureDraft, type LocalPhoto, type PhotoRow, type Result, type Route,
} from './model';

const now = Date.parse('2026-04-01T04:00:00.000Z');
const photo = (id: string, kind: LocalPhoto['kind'], stream?: LocalPhoto['stream']): LocalPhoto => ({ id, kind, ...(stream ? { stream } : {}), uri: `file:///documents/evidence/${id}.jpg`, capturedAt: new Date(now).toISOString(), width: 1280, height: 960 });
function fixture(): CaptureDraft {
  return {
    client_uuid: 'a05444a8-54b0-43ca-8348-8b533e913698', scope: 'collector:membership', routeId: 'route', routeDate: '2026-04-01',
    stop: { id: 'stop-1', propertyId: 'property-1', property: { id: 'property-1', unitNo: '101', block: 'A', latitude: 19, longitude: 73, propertyCode: '123456', qrToken: 'signed-token' }, sequence: 1, windowStart: '09:00', windowEnd: '10:00', streams: ['WET', 'DRY'], status: 'PENDING', lastPickup: null },
    qrToken: 'signed-token', offline: true, gps: { latitude: 19, longitude: 73, accuracyM: 12, gpsCapturedAt: new Date(now).toISOString() },
    doorstep: photo('door', 'DOORSTEP'),
    streams: [
      { stream: 'WET', weight: '4.200', segregation: 'GOOD', contamination: false, contaminationNote: '', photo: photo('wet', 'SCALE', 'WET') },
      { stream: 'DRY', weight: '1.801', segregation: 'PARTIAL', contamination: true, contaminationNote: 'Food mixed in', photo: photo('dry', 'SCALE', 'DRY') },
    ], exception: null,
  };
}
const result: Result = { client_uuid: 'event', id: 'server-id', status: 'NEEDS_REVIEW', verificationScore: 80, verificationReasons: ['OFFLINE_CAPTURE'] };

describe('manual scale adapter', () => {
  const adapter = new ManualScaleAdapter();
  it.each([['0.001', 0.001], ['4.200', 4.2], [' 1.801 ', 1.801], ['9999999.999', 9999999.999]])('accepts positive %s kg at most 3 decimals', (value, expected) => {
    expect(adapter.readKg(String(value))).toBe(expected);
  });
  it.each(['', ' ', '0', '0.000', '-1', '1.0001', '.2', '1.', '1e2', 'NaN', 'Infinity', '1,200', '10000000', '+1', '4kg'])('rejects %s without manufacturing zero', (value) => {
    expect(() => adapter.readKg(value)).toThrow('weightInvalid');
  });
});

describe('assigned-route identity', () => {
  const draft = fixture();
  const route: Route = { id: 'route', date: '2026-04-01', name: 'Morning', stops: [draft.stop] };
  it('matches only exact signed QR on selected stop', () => {
    expect(resolveIdentity(route, 'stop-1', 'signed-token', 'QR', now)).toBe('signed-token');
    expect(resolveIdentity(route, 'other-stop', 'signed-token', 'QR', now)).toBeNull();
    expect(resolveIdentity(route, 'stop-1', 'signed-token-tampered', 'QR', now)).toBeNull();
  });
  it('resolves six digits to cached QR only inside current route', () => {
    expect(resolveIdentity(route, 'stop-1', '123456', 'CODE', now)).toBe('signed-token');
    expect(resolveIdentity(route, 'stop-1', '12345', 'CODE', now)).toBeNull();
    expect(resolveIdentity({ ...route, date: '2026-03-31' }, 'stop-1', '123456', 'CODE', now)).toBeNull();
    expect(resolveIdentity({ ...route, stops: [...route.stops, { ...draft.stop, id: 'duplicate' }] }, 'stop-1', '123456', 'CODE', now)).toBeNull();
  });
  it('uses Indian route date across UTC midnight', () => {
    expect(indiaDate(Date.parse('2026-03-31T20:00:00Z'))).toBe('2026-04-01');
  });
});

describe('capture validation and immutable evidence snapshot', () => {
  it('requires identity, GPS, doorstep and each scheduled weight/photo', () => {
    const draft = fixture();
    expect(validateDraft(draft, now)).toEqual([]);
    draft.qrToken = null; draft.gps = null; draft.doorstep = null;
    draft.streams[0].weight = ''; draft.streams[1].photo = null;
    expect(validateDraft(draft, now)).toEqual(expect.arrayContaining(['identityRequired', 'gpsRequired', 'doorstepRequired', 'weightInvalid', 'scaleRequired']));
    expect(() => freezeCapture(draft, 'device', now)).toThrow();
  });
  it('does not accept omitted/duplicate streams or another stream scale photo', () => {
    const draft = fixture();
    draft.streams[1] = { ...draft.streams[0] };
    expect(validateDraft(draft, now)).toContain('streamsRequired');
    draft.streams[0].photo = photo('other', 'SCALE', 'DRY');
    expect(validateDraft(draft, now)).toContain('scaleRequired');
  });
  it('requires a reason for contamination', () => {
    const draft = fixture(); draft.streams[1].contaminationNote = '  ';
    expect(validateDraft(draft, now)).toContain('contaminationRequired');
  });
  it('rejects stale, nonfinite and missing GPS while retaining poor accuracy for server review', () => {
    const draft = fixture();
    expect(validateDraft(draft, now + 120_001)).toContain('gpsStale');
    if (!draft.gps) throw new Error('fixture');
    draft.gps.latitude = Number.NaN;
    expect(validateDraft(draft, now)).toContain('gpsRequired');
    draft.gps.latitude = 19; draft.gps.accuracyM = 150;
    expect(validateDraft(draft, now)).toEqual([]);
  });
  it('requires exception note/photo and represents unavailable weight as no streams, never zero', () => {
    const draft = fixture(); draft.streams[0].weight = '';
    draft.exception = { code: 'WEIGHT_UNAVAILABLE', note: '', photo: null };
    expect(validateDraft(draft, now)).toContain('exceptionRequired');
    draft.exception.note = 'Scale battery failed'; draft.exception.photo = photo('exception', 'EXCEPTION');
    const saved = freezeCapture(draft, 'bound-device', now);
    expect(saved.payload.streams).toEqual([]);
    expect(saved.payload.exception?.code).toBe('WEIGHT_UNAVAILABLE');
    expect(saved.photos.map((item) => item.kind)).toEqual(['DOORSTEP', 'EXCEPTION']);
    expect(JSON.stringify(saved.payload)).not.toContain('"kg":0');
  });
  it('copies fields without mutating draft and preserves UUID, device, offline flag and millisecond timestamps', () => {
    const draft = fixture();
    const before = JSON.stringify(draft);
    const { payload } = freezeCapture(draft, 'bound-device', now);
    expect(JSON.stringify(draft)).toBe(before);
    expect(payload).toMatchObject({ deviceId: 'bound-device', client_uuid: draft.client_uuid, offline: true, capturedAt: new Date(now).toISOString() });
    expect(payload.streams.map((stream) => stream.kg)).toEqual([4.2, 1.801]);
    expect(payload.streams[0]).not.toHaveProperty('contaminationNote');
  });
  it('maps only confirmed server photo IDs without changing original capture', () => {
    const { payload, photos } = freezeCapture(fixture(), 'device', now);
    const rows: PhotoRow[] = photos.map((item) => ({ localId: item.id, eventUuid: payload.client_uuid, uri: item.uri, kind: item.kind, stream: item.stream ?? null, stage: 'CONFIRMED', photoId: `server-${item.id}`, uploadUrl: null, metadataJson: '{"normalized":true}' }));
    const json = JSON.stringify(payload);
    const wire = materializePayload(payload, rows);
    expect(wire.doorstepPhotoId).toBe('server-door');
    expect(wire.streams[0].photoId).toBe('server-wet');
    expect(JSON.stringify(payload)).toBe(json);
    expect(JSON.stringify(materializePayload(payload, rows))).toBe(JSON.stringify(wire));
    rows[0].stage = 'UPLOADED';
    expect(() => materializePayload(payload, rows)).toThrow('photoUnconfirmed');
  });
});

describe('durable queue reducer', () => {
  it('recovers interrupted SYNCING to PENDING without discarding attempts or verdict', () => {
    const started = queueReducer(initialQueueState, { type: 'START' });
    expect(started.transport).toBe('SYNCING');
    expect(queueReducer(started, { type: 'RECOVER' })).toMatchObject({ transport: 'PENDING', attempts: 1 });
    expect(initialQueueState.attempts).toBe(0);
  });
  it('uses exponential backoff capped at one hour and allows explicit retry', () => {
    let state = queueReducer(initialQueueState, { type: 'START' });
    state = queueReducer(state, { type: 'FAIL', error: 'timeout', now });
    expect(state.nextAttemptAt).toBe(now + 5000);
    state = queueReducer(state, { type: 'START' });
    state = queueReducer(state, { type: 'FAIL', error: 'timeout', now });
    expect(state.nextAttemptAt).toBe(now + 10000);
    expect(queueReducer({ ...state, attempts: 100 }, { type: 'FAIL', error: 'timeout', now }).nextAttemptAt).toBe(now + 3_600_000);
    expect(queueReducer(state, { type: 'RETRY' })).toMatchObject({ transport: 'PENDING', nextAttemptAt: 0, attempts: 2 });
  });
  it('pauses permanent transport failures without deleting evidence', () => {
    expect(queueReducer(initialQueueState, { type: 'FAIL', error: 'device revoked', now, permanent: true })).toMatchObject({ transport: 'PENDING', nextAttemptAt: Number.MAX_SAFE_INTEGER, lastError: 'device revoked' });
  });
  it.each(['VERIFIED', 'NEEDS_REVIEW', 'REJECTED'] as const)('keeps transport separate from %s and does not resend terminal events', (status) => {
    const state = queueReducer(initialQueueState, { type: 'ACK', result: { ...result, status } });
    expect(state.transport).toBe('SYNCED'); expect(state.verdict).toBe(status);
    expect(queueReducer(state, { type: 'RETRY' })).toBe(state);
    expect(queueReducer(state, { type: 'RECOVER' })).toBe(state);
  });
  it('preserves hard rejection without inventing a server ID or score', () => {
    expect(queueReducer(initialQueueState, { type: 'HARD_REJECT', error: 'INVALID_QR' })).toMatchObject({ transport: 'SYNCED', verdict: 'REJECTED', result: null, lastError: 'INVALID_QR' });
  });
  it('can update a reviewed verdict after explicit server refresh', () => {
    const reviewed = queueReducer(initialQueueState, { type: 'ACK', result });
    expect(queueReducer(reviewed, { type: 'ACK', result: { ...result, status: 'VERIFIED', verificationReasons: ['SUPERVISOR_APPROVED'] } }).verdict).toBe('VERIFIED');
  });
});

describe('server verdict parsing', () => {
  it('parses the actual status data and rejectedSubmissions collections', () => {
    const rejected = { ...result, client_uuid: 'rejected', status: 'REJECTED' };
    const page = { data: [result], nextCursor: null, rejectedSubmissions: [rejected] };
    expect(parseResult(page, 'event')).toEqual(result);
    expect(parseResult(page, 'rejected')).toEqual(rejected);
    expect(parseResult(page, 'unknown')).toBeNull();
  });
  it('parses success and 422 error.details.results, retaining reasons', () => {
    expect(parseResult({ results: [result] }, 'event')).toEqual(result);
    expect(parseResult({ error: { details: { results: [{ ...result, status: 'REJECTED' }] } } }, 'event')?.status).toBe('REJECTED');
    expect(parseResult({ results: [{ ...result, verificationReasons: [{ code: 'OUTSIDE_GEOFENCE', distanceM: 200 }] }] }, 'event')?.verificationReasons[0]).toContain('OUTSIDE_GEOFENCE');
  });
  it('does not acknowledge a missing, mismatched or malformed result', () => {
    expect(parseResult({ results: [result] }, 'different-uuid')).toBeNull();
    expect(parseResult({ results: [{ ...result, status: 'PENDING' }] }, 'event')).toBeNull();
    expect(parseResult({ error: { details: null } }, 'event')).toBeNull();
    expect(parseResult(null, 'event')).toBeNull();
  });
});
