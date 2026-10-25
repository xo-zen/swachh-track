import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoRow, PickupPayload, QueueAction, QueueEvent, Result } from './model';
import { initialQueueState } from './model';
import { ApiError, type CollectorApi } from './api';
import { refreshVerdicts, syncQueue } from './sync';
import { checkpointPhoto, listEvents, transition } from './storage';

// These are deterministic network/storage orchestration tests, not native device simulations.
const memory = vi.hoisted(() => ({ events: [] as QueueEvent[], photos: [] as PhotoRow[], wire: null as string | null, upload: vi.fn(), connected: true }));
vi.mock('@react-native-community/netinfo', () => ({ default: { fetch: async () => ({ isConnected: memory.connected, isInternetReachable: memory.connected }) } }));
vi.mock('./media', () => ({ uploadJpeg: memory.upload }));
vi.mock('./api', () => ({
  ApiError: class extends Error {
    constructor(readonly status: number, readonly body: unknown) { super(`HTTP ${status}`); }
  },
}));
vi.mock('./storage', async () => {
  const { materializePayload, queueReducer } = await import('./model');
  return {
    listEvents: vi.fn(async (scope: string) => memory.events.filter((event) => event.scope === scope)),
    listPhotos: async (uuid: string) => memory.photos.filter((photo) => photo.eventUuid === uuid),
    checkpointPhoto: vi.fn(async (photo: PhotoRow) => { memory.photos = memory.photos.map((row) => row.localId === photo.localId ? { ...photo } : row); }),
    transition: vi.fn(async (uuid: string, scope: string, action: QueueAction) => {
      const event = memory.events.find((row) => row.uuid === uuid && row.scope === scope);
      if (!event) throw new Error('eventMissing');
      const next = { ...event, ...queueReducer(event, action) };
      memory.events = memory.events.map((row) => row.uuid === uuid ? next : row);
      return next;
    }),
    freezeWirePayload: async () => {
      memory.wire ??= JSON.stringify(materializePayload(JSON.parse(memory.events[0].captureJson) as PickupPayload, memory.photos));
      return memory.wire;
    },
  };
});

const uuid = 'f991e57c-6f49-453c-aa5d-9cdf7cf16acf';
const result: Result = { client_uuid: uuid, id: 'server-event', status: 'NEEDS_REVIEW', verificationScore: 85, verificationReasons: ['OFFLINE_CAPTURE'] };
const payload: PickupPayload = {
  client_uuid: uuid, propertyId: 'property', routeStopId: 'stop', deviceId: 'device', qrToken: 'signed', capturedAt: '2026-04-01T04:00:00Z',
  latitude: 19, longitude: 73, accuracyM: 5, gpsCapturedAt: '2026-04-01T04:00:00Z', offline: true,
  doorstepPhotoId: 'door', streams: [{ stream: 'WET', kg: 4.2, segregation: 'GOOD', contamination: false, photoId: 'wet' }],
};

function createApi() {
  let presigns = 0;
  const request = vi.fn(async (path: string, _body?: unknown, _headers?: Record<string, string>): Promise<unknown> => {
    if (path.endsWith('/presign')) { presigns += 1; return { photoId: `server-photo-${presigns}`, uploadUrl: `https://private-storage.invalid/${presigns}` }; }
    if (path.endsWith('/confirm')) return { normalized: true, sha256: 'normalized-hash' };
    if (path === '/collector/pickups/batch') return { results: [result] };
    throw new Error('Unexpected test request');
  });
  const api: Pick<CollectorApi, 'scope' | 'request'> = { scope: 'user:membership', request };
  return { api, request };
}

beforeEach(() => {
  vi.clearAllMocks();
  memory.events = [{ ...initialQueueState, uuid, scope: 'user:membership', stopId: 'stop', captureJson: JSON.stringify(payload), payloadJson: null, createdAt: payload.capturedAt }];
  memory.photos = [
    { localId: 'door', eventUuid: uuid, uri: 'file:///documents/door.jpg', kind: 'DOORSTEP', stream: null, stage: 'LOCAL', photoId: null, uploadUrl: null, metadataJson: null },
    { localId: 'wet', eventUuid: uuid, uri: 'file:///documents/wet.jpg', kind: 'SCALE', stream: 'WET', stage: 'LOCAL', photoId: null, uploadUrl: null, metadataJson: null },
  ];
  memory.wire = null; memory.connected = true;
  memory.upload.mockReset().mockResolvedValue(200);
});

describe('expired confirmation recovery with mocked transport/storage', () => {
  const expired = () => new ApiError(422, { error: { code: 'UPLOAD_EXPIRED', message: 'Create a new photo reservation.' } });
  beforeEach(() => {
    memory.photos[0] = { ...memory.photos[0], stage: 'UPLOADED', photoId: 'expired-door' };
    memory.photos[1] = { ...memory.photos[1], stage: 'CONFIRMED', photoId: 'confirmed-wet', metadataJson: '{"sha256":"retained"}' };
  });
  it('renews a restarted UPLOADED checkpoint before PUT and leaves confirmed peers and capture immutable', async () => {
    const before = memory.events[0].captureJson;
    const peer = { ...memory.photos[1] };
    const { api, request } = createApi();
    const normal = request.getMockImplementation();
    request.mockImplementation(async (path, body, headers) => {
      if (path.endsWith('/expired-door/confirm')) throw expired();
      if (path.endsWith('/presign')) expect(memory.photos[0]).toMatchObject({ stage: 'LOCAL', photoId: null, uri: 'file:///documents/door.jpg' });
      return normal?.(path, body, headers);
    });
    memory.upload.mockImplementation(async (uri: string) => {
      expect(uri).toBe('file:///documents/door.jpg');
      expect(memory.photos[0]).toMatchObject({ stage: 'PRESIGNED', photoId: 'server-photo-1' });
      return 200;
    });
    await syncQueue(api, () => undefined);
    expect(vi.mocked(checkpointPhoto).mock.calls.map(([photo]) => photo.stage)).toEqual(['LOCAL', 'PRESIGNED', 'UPLOADED', 'CONFIRMED']);
    expect(memory.upload).toHaveBeenCalledTimes(1);
    expect(memory.photos[1]).toEqual(peer);
    expect(memory.events[0]).toMatchObject({ uuid, captureJson: before, transport: 'SYNCED', verdict: 'NEEDS_REVIEW' });
    expect(JSON.parse(memory.wire ?? '{}')).toMatchObject({ client_uuid: uuid, doorstepPhotoId: 'server-photo-1', streams: [{ photoId: 'confirmed-wet' }] });
    expect(request.mock.calls.at(-1)?.[2]).toEqual({ 'Idempotency-Key': uuid });
  });
  it('bounds repeated explicit expiry, preserves evidence, and backs off instead of hard-rejecting', async () => {
    const { api, request } = createApi();
    const normal = request.getMockImplementation();
    request.mockImplementation(async (path, body, headers) => {
      if (path.endsWith('/confirm')) throw expired();
      return normal?.(path, body, headers);
    });
    const before = memory.events[0].captureJson;
    await syncQueue(api, () => undefined);
    expect(request.mock.calls.filter(([path]) => path.endsWith('/confirm'))).toHaveLength(2);
    expect(memory.events[0]).toMatchObject({ uuid, captureJson: before, transport: 'PENDING', verdict: null, attempts: 1 });
    expect(memory.events[0].nextAttemptAt).toBeGreaterThan(Date.now());
    expect(memory.photos[0]).toMatchObject({ stage: 'LOCAL', photoId: null, uri: 'file:///documents/door.jpg' });
    expect(memory.photos).toHaveLength(2);
    expect(memory.wire).toBeNull();
    expect(request.mock.calls.some(([path]) => path.endsWith('/batch'))).toBe(false);
    request.mockImplementation(async (path, body, headers) => normal?.(path, body, headers));
    await syncQueue(api, () => undefined, true);
    expect(memory.events).toHaveLength(1);
    expect(memory.events[0]).toMatchObject({ uuid, captureJson: before, transport: 'SYNCED' });
  });
  it('resumes from the saved LOCAL checkpoint if renewal fails after expiry', async () => {
    const { api, request } = createApi();
    const normal = request.getMockImplementation();
    request.mockImplementation(async (path, body, headers) => {
      if (path.endsWith('/expired-door/confirm')) throw expired();
      if (path.endsWith('/presign')) throw new Error('Disconnected during renewal');
      return normal?.(path, body, headers);
    });
    await syncQueue(api, () => undefined);
    expect(memory.photos[0]).toMatchObject({ stage: 'LOCAL', photoId: null, eventUuid: uuid });
    expect(memory.events[0]).toMatchObject({ transport: 'PENDING', verdict: null });
    const calls = request.mock.calls.length;
    request.mockImplementation(async (path, body, headers) => normal?.(path, body, headers));
    await syncQueue(api, () => undefined, true);
    expect(request.mock.calls[calls][0]).toMatch(/\/presign$/);
    expect(memory.events[0].transport).toBe('SYNCED');
    expect(memory.photos).toHaveLength(2);
  });
  it('does not request a replacement before the reset checkpoint commits', async () => {
    const { api, request } = createApi();
    request.mockRejectedValue(expired());
    vi.mocked(checkpointPhoto).mockRejectedValueOnce(new Error('Storage full'));
    await syncQueue(api, () => undefined);
    expect(request).toHaveBeenCalledTimes(1);
    expect(memory.upload).not.toHaveBeenCalled();
    expect(memory.photos[0]).toMatchObject({ stage: 'UPLOADED', photoId: 'expired-door', uri: 'file:///documents/door.jpg' });
    expect(memory.events[0]).toMatchObject({ transport: 'PENDING', verdict: null, lastError: 'Storage full' });
  });
  it.each(['IMAGE_DECODE_FAILED', 'UPLOAD_MISSING', undefined])('does not renew arbitrary 422 code %s, even if its message mentions UPLOAD_EXPIRED', async (code) => {
    const { api, request } = createApi();
    request.mockRejectedValue(new ApiError(422, { error: { code, message: 'UPLOAD_EXPIRED is not this error code' } }));
    await syncQueue(api, () => undefined);
    expect(request).toHaveBeenCalledTimes(1);
    expect(memory.upload).not.toHaveBeenCalled();
    expect(checkpointPhoto).not.toHaveBeenCalled();
    expect(memory.events[0]).toMatchObject({ uuid, transport: 'SYNCED', verdict: 'REJECTED' });
    expect(memory.photos).toHaveLength(2);
  });
});

describe('paginated server verdict reconciliation', () => {
  beforeEach(() => {
    memory.events[0] = { ...memory.events[0], transport: 'SYNCED', verdict: result.status, result };
  });
  it('reads data on later pages after supervisor approval and retains evidence and capture', async () => {
    const { api, request } = createApi();
    const before = memory.events[0];
    const photos = JSON.stringify(memory.photos);
    request.mockResolvedValueOnce({ data: [{ ...result, client_uuid: 'other-event' }], nextCursor: 'cursor-1', rejectedSubmissions: [] });
    // The real API changes status on approval but keeps the original verification reasons/score.
    request.mockResolvedValueOnce({ data: [{ ...result, status: 'VERIFIED' }], nextCursor: null, rejectedSubmissions: [] });
    expect(await refreshVerdicts(api)).toMatchObject({ pagesFetched: 2, updatedEvents: 1, unmatchedEvents: 0 });
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/collector/sync/status?limit=100', '/collector/sync/status?limit=100&cursor=cursor-1']);
    expect(memory.events[0]).toMatchObject({ uuid, captureJson: before.captureJson, payloadJson: before.payloadJson, verdict: 'VERIFIED', result: { verificationReasons: ['OFFLINE_CAPTURE'] } });
    expect(JSON.stringify(memory.photos)).toBe(photos);
    expect(listEvents).toHaveBeenCalledTimes(1);
  });
  it('reconciles rejectedSubmissions once without deleting them or traversing unrelated history', async () => {
    memory.events[0] = { ...memory.events[0], verdict: 'REJECTED', result: null, lastError: 'HTTP 422' };
    const rejected: Result = { ...result, status: 'REJECTED', verificationScore: 0, verificationReasons: ['INVALID_INPUT'] };
    const { api, request } = createApi();
    request.mockResolvedValue({ data: [], nextCursor: 'unneeded-page', rejectedSubmissions: [rejected, rejected] });
    expect(await refreshVerdicts(api)).toMatchObject({ pagesFetched: 1, matchedEvents: 1, updatedEvents: 1, nextCursor: 'unneeded-page' });
    expect(transition).toHaveBeenCalledTimes(1);
    expect(memory.events).toHaveLength(1);
    expect(memory.events[0]).toMatchObject({ verdict: 'REJECTED', result: rejected, lastError: null });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not acknowledge pending events or another membership, and retains unmatched rejections', async () => {
    const pending = { ...memory.events[0], uuid: 'pending', transport: 'PENDING' as const, result: null, verdict: null };
    const other = { ...memory.events[0], uuid: 'other', scope: 'user:other-membership' };
    memory.events = [{ ...memory.events[0], verdict: 'REJECTED', result: null, lastError: 'Older rejection outside latest 100' }, pending, other];
    const before = JSON.stringify(memory.events);
    const { api, request } = createApi();
    request.mockResolvedValue({ data: [{ ...result, client_uuid: 'pending', status: 'VERIFIED' }, { ...result, client_uuid: 'other', status: 'VERIFIED' }], nextCursor: null, rejectedSubmissions: [] });
    expect(await refreshVerdicts(api)).toMatchObject({ updatedEvents: 0, unmatchedEvents: 1 });
    expect(JSON.stringify(memory.events)).toBe(before);
    expect(transition).not.toHaveBeenCalled();
  });
  it('keeps completed page updates on network failure and skips them when retrying from page one', async () => {
    memory.events.push({ ...memory.events[0], uuid: 'second', result: { ...result, client_uuid: 'second' } });
    const { api, request } = createApi();
    const page1 = { data: [{ ...result, status: 'VERIFIED' }], nextCursor: 'page-2', rejectedSubmissions: [] };
    request.mockResolvedValueOnce(page1).mockRejectedValueOnce(new Error('Connection lost'));
    await expect(refreshVerdicts(api)).rejects.toThrow('Connection lost');
    expect(memory.events.map((event) => event.verdict)).toEqual(['VERIFIED', 'NEEDS_REVIEW']);
    request.mockResolvedValueOnce(page1).mockResolvedValueOnce({ data: [{ ...result, client_uuid: 'second', status: 'VERIFIED' }], nextCursor: null, rejectedSubmissions: [] });
    expect(await refreshVerdicts(api)).toMatchObject({ pagesFetched: 2, matchedEvents: 2, updatedEvents: 1 });
    expect(transition).toHaveBeenCalledTimes(2);
    expect(memory.events).toHaveLength(2);
  });
  it('rejects repeated cursors rather than looping indefinitely', async () => {
    const { api, request } = createApi();
    request.mockResolvedValue({ data: [], nextCursor: 'same-cursor', rejectedSubmissions: [] });
    await expect(refreshVerdicts(api)).rejects.toThrow('invalidResponse');
    expect(request).toHaveBeenCalledTimes(2);
    expect(transition).not.toHaveBeenCalled();
  });
  it.each([
    { data: [], rejectedSubmissions: [] },
    { data: [], nextCursor: null, rejectedSubmissions: null },
    { data: [{ ...result, status: 'INVALID' }], nextCursor: null, rejectedSubmissions: [] },
  ])('rejects malformed status pages without clearing local evidence', async (page) => {
    const before = JSON.stringify(memory.events);
    const { api, request } = createApi();
    request.mockResolvedValue(page);
    await expect(refreshVerdicts(api)).rejects.toThrow('invalidResponse');
    expect(JSON.stringify(memory.events)).toBe(before);
    expect(memory.photos).toHaveLength(2);
  });
  it('reconciles 500 terminal events using five 100-row pages; this is a request-count test, not a benchmark', async () => {
    memory.events = Array.from({ length: 500 }, (_, index) => ({ ...memory.events[0], uuid: `event-${index}`, result: { ...result, client_uuid: `event-${index}`, id: `server-${index}` } }));
    const rows = memory.events.map((event) => ({ ...event.result, status: 'VERIFIED' }));
    const { api, request } = createApi();
    for (let offset = 0; offset < 500; offset += 100) request.mockResolvedValueOnce({ data: rows.slice(offset, offset + 100), nextCursor: offset < 400 ? `server-${offset + 99}` : null, rejectedSubmissions: [] });
    expect(await refreshVerdicts(api)).toEqual({ pagesFetched: 5, matchedEvents: 500, updatedEvents: 500, unmatchedEvents: 0, nextCursor: null });
    expect(request).toHaveBeenCalledTimes(5);
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledTimes(500);
    expect(memory.events).toHaveLength(500);
    expect(memory.events.every((event) => event.verdict === 'VERIFIED')).toBe(true);
  });
});

describe('sync protocol with explicit mocked transport/storage', () => {
  it('confirms all photos before batching with stable idempotency key and retains local files', async () => {
    const { api, request } = createApi();
    await syncQueue(api, () => undefined);
    expect(request.mock.calls.map(([path]) => path.split('/').at(-1))).toEqual(['presign', 'confirm', 'presign', 'confirm', 'batch']);
    expect(request.mock.calls[0][1]).toEqual({ kind: 'DOORSTEP', captureSource: 'CAMERA', contentType: 'image/jpeg' });
    expect(request.mock.calls[2][1]).toMatchObject({ kind: 'SCALE', stream: 'WET' });
    expect(request.mock.calls.at(-1)?.[2]).toEqual({ 'Idempotency-Key': uuid });
    expect(memory.events[0]).toMatchObject({ transport: 'SYNCED', verdict: 'NEEDS_REVIEW' });
    expect(memory.photos.every((photo) => photo.stage === 'CONFIRMED' && photo.uri.startsWith('file:///documents/'))).toBe(true);
  });
  it('renews an expired presign and checkpoints the replacement ID before batching', async () => {
    memory.upload.mockResolvedValueOnce(403).mockResolvedValue(200);
    const { api, request } = createApi();
    await syncQueue(api, () => undefined);
    expect(request.mock.calls.filter(([path]) => path.endsWith('/presign'))).toHaveLength(3);
    expect(memory.photos[0].photoId).toBe('server-photo-2');
    expect(JSON.parse(memory.wire ?? '{}')).toMatchObject({ doorstepPhotoId: 'server-photo-2' });
  });
  it('after confirmation failure retries confirmation without repeating successful PUT', async () => {
    const { api, request } = createApi();
    const normal = request.getMockImplementation();
    let failed = false;
    request.mockImplementation(async (path, body, headers) => {
      if (path.endsWith('/confirm') && !failed) { failed = true; throw new Error('Network timeout'); }
      return normal?.(path, body, headers);
    });
    await syncQueue(api, () => undefined);
    expect(memory.photos[0].stage).toBe('UPLOADED');
    expect(memory.events[0].transport).toBe('PENDING');
    await syncQueue(api, () => undefined, true);
    expect(memory.upload).toHaveBeenCalledTimes(2);
    expect(memory.events[0].transport).toBe('SYNCED');
  });
  it('reuses frozen batch bytes and confirmed IDs after a lost batch response', async () => {
    const { api, request } = createApi();
    const normal = request.getMockImplementation();
    let failed = false;
    request.mockImplementation(async (path, body, headers) => {
      if (path.endsWith('/batch') && !failed) { failed = true; throw new Error('Response lost after commit'); }
      return normal?.(path, body, headers);
    });
    await syncQueue(api, () => undefined);
    const wire = memory.wire;
    await syncQueue(api, () => undefined, true);
    expect(memory.wire).toBe(wire);
    expect(memory.upload).toHaveBeenCalledTimes(2);
    const batches = request.mock.calls.filter(([path]) => path.endsWith('/batch'));
    expect(JSON.stringify(batches[0])).toBe(JSON.stringify(batches[1]));
  });
  it('preserves 422 rejection, reasons and evidence and never retries it as a new event', async () => {
    const { api, request } = createApi();
    const normal = request.getMockImplementation();
    request.mockImplementation(async (path, body, headers) => {
      if (path.endsWith('/batch')) throw new ApiError(422, { error: { details: { results: [{ ...result, status: 'REJECTED', verificationReasons: ['INVALID_QR'] }] } } });
      return normal?.(path, body, headers);
    });
    await syncQueue(api, () => undefined);
    expect(memory.events).toHaveLength(1);
    expect(memory.events[0]).toMatchObject({ transport: 'SYNCED', verdict: 'REJECTED', result: { verificationReasons: ['INVALID_QR'] } });
    expect(memory.photos).toHaveLength(2);
    await syncQueue(api, () => undefined, true);
    expect(request.mock.calls.filter(([path]) => path.endsWith('/batch'))).toHaveLength(1);
  });
  it('coalesces overlapping automatic/manual calls into one flight', async () => {
    const { api, request } = createApi();
    const normal = request.getMockImplementation();
    let release: ((value: unknown) => void) | undefined;
    const response = new Promise<unknown>((resolve) => { release = resolve; });
    request.mockImplementation(async (path, body, headers) => path.endsWith('/batch') ? response : normal?.(path, body, headers));
    const first = syncQueue(api, () => undefined);
    const second = syncQueue(api, () => undefined, true);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(request.mock.calls.some(([path]) => path.endsWith('/batch'))).toBe(true));
    release?.({ results: [result] });
    await first;
    expect(request.mock.calls.filter(([path]) => path.endsWith('/batch'))).toHaveLength(1);
  });
  it('does not claim events while offline', async () => {
    memory.connected = false;
    const { api, request } = createApi();
    await expect(syncQueue(api, () => undefined)).rejects.toThrow('offline');
    expect(request).not.toHaveBeenCalled();
    expect(memory.events[0]).toMatchObject({ transport: 'PENDING', attempts: 0 });
  });
});
