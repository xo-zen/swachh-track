import NetInfo from '@react-native-community/netinfo';
import { ApiError, CollectorApi } from './api';
import { parseResult, parseResultRow, record, text, type PhotoRow } from './model';
import { uploadJpeg } from './media';
import { checkpointPhoto, freezeWirePayload, listEvents, listPhotos, transition } from './storage';

let flight: Promise<void> | null = null;
let activeScope: string | null = null;
export function isSyncing(): boolean { return flight !== null; }

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    // Diagnostics keep server rejection details, never request headers or signed upload URLs.
    let details = '';
    try { const value = record(record(error.body).error).details; if (value !== undefined) details = ` ${JSON.stringify(value)}`; } catch { /* No structured details. */ }
    return `${error.message}${details}`.slice(0, 4000);
  }
  return error instanceof Error ? error.message : 'unexpectedError';
}

function isUploadExpired(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 422) return false;
  try { return record(record(error.body).error).code === 'UPLOAD_EXPIRED'; }
  catch { return false; }
}

async function syncPhoto(api: CollectorApi, initial: PhotoRow): Promise<void> {
  let photo = initial;
  const base = `/collector/pickups/${encodeURIComponent(photo.eventUuid)}/photos`;
  for (let renewal = 0; renewal < 2; renewal += 1) {
    if (photo.stage === 'CONFIRMED') return;
    if (photo.stage === 'LOCAL' || (photo.stage === 'PRESIGNED' && !photo.uploadUrl)) {
      const body = record(await api.request(`${base}/presign`, { kind: photo.kind, ...(photo.stream ? { stream: photo.stream } : {}), captureSource: 'CAMERA', contentType: 'image/jpeg' }));
      const uploadUrl = text(body.uploadUrl);
      if (!/^https?:\/\//.test(uploadUrl)) throw new Error('invalidResponse');
      photo = { ...photo, stage: 'PRESIGNED', photoId: text(body.photoId), uploadUrl };
      await checkpointPhoto(photo);
    }
    if (photo.stage === 'PRESIGNED') {
      if (!photo.uploadUrl) throw new Error('invalidResponse');
      const status = await uploadJpeg(photo.uri, photo.uploadUrl);
      if ([400, 401, 403, 410].includes(status)) {
        // Expiry may occur while the app was killed. A new presign is checkpointed before PUT.
        photo = { ...photo, stage: 'LOCAL', photoId: null, uploadUrl: null };
        await checkpointPhoto(photo);
        if (renewal === 0) continue;
      }
      if (status < 200 || status >= 300) throw new Error(`uploadFailed: HTTP ${status}`);
      photo = { ...photo, stage: 'UPLOADED', uploadUrl: null };
      await checkpointPhoto(photo);
    }
    if (photo.stage === 'UPLOADED') {
      if (!photo.photoId) throw new Error('invalidResponse');
      let metadata: Record<string, unknown>;
      try { metadata = record(await api.request(`${base}/${encodeURIComponent(photo.photoId)}/confirm`, {})); }
      catch (error) {
        if (!isUploadExpired(error)) throw error;
        // A successful PUT does not extend the reservation lifetime. Reset durably before
        // reserving/re-uploading the same local JPEG; confirmed evidence is never replaced.
        photo = { ...photo, stage: 'LOCAL', photoId: null, uploadUrl: null, metadataJson: null };
        await checkpointPhoto(photo);
        if (renewal === 0) continue;
        throw error;
      }
      if (typeof metadata.photoId === 'string' && metadata.photoId !== photo.photoId) throw new Error('invalidResponse');
      if (typeof metadata.id === 'string' && metadata.id !== photo.photoId) throw new Error('invalidResponse');
      photo = { ...photo, stage: 'CONFIRMED', uploadUrl: null, metadataJson: JSON.stringify(metadata) };
      await checkpointPhoto(photo);
    }
    return;
  }
}

async function run(api: CollectorApi, changed: () => void, manual: boolean): Promise<void> {
  const network = await NetInfo.fetch();
  if (!network.isConnected || network.isInternetReachable === false) throw new Error('offline');
  const events = await listEvents(api.scope);
  for (const item of events) {
    if (item.transport === 'SYNCED') continue;
    if (manual) await transition(item.uuid, api.scope, { type: 'RETRY' });
    else if (item.nextAttemptAt > Date.now()) continue;
    const connection = await NetInfo.fetch();
    if (!connection.isConnected || connection.isInternetReachable === false) break;
    await transition(item.uuid, api.scope, { type: 'START' });
    changed();
    let batching = false;
    try {
      for (const photo of await listPhotos(item.uuid)) await syncPhoto(api, photo);
      const payloadJson = await freezeWirePayload(item.uuid, api.scope);
      batching = true;
      const response = await api.request('/collector/pickups/batch', { events: [JSON.parse(payloadJson) as unknown] }, { 'Idempotency-Key': item.uuid });
      const result = parseResult(response, item.uuid);
      if (!result) throw new Error('invalidResponse');
      await transition(item.uuid, api.scope, { type: 'ACK', result });
    } catch (error) {
      const result = error instanceof ApiError && batching ? parseResult(error.body, item.uuid) : null;
      if (result) await transition(item.uuid, api.scope, { type: 'ACK', result });
      else if (error instanceof ApiError && error.status === 422 && (batching || !isUploadExpired(error))) await transition(item.uuid, api.scope, { type: 'HARD_REJECT', error: errorMessage(error) });
      else await transition(item.uuid, api.scope, { type: 'FAIL', now: Date.now(), error: errorMessage(error), permanent: error instanceof ApiError && [400, 403, 404, 409, 413].includes(error.status) });
      if (error instanceof ApiError && [401, 403, 429].includes(error.status)) break;
    } finally { changed(); }
  }
}

export function syncQueue(api: CollectorApi, changed: () => void, manual = false): Promise<void> {
  if (flight) {
    if (activeScope !== api.scope) return Promise.reject(new Error('syncBusy'));
    return flight;
  }
  activeScope = api.scope;
  flight = run(api, changed, manual).finally(() => { flight = null; activeScope = null; changed(); });
  return flight;
}

export async function refreshVerdicts(api: CollectorApi): Promise<unknown> {
  const remaining = new Map((await listEvents(api.scope)).filter((event) => event.transport === 'SYNCED').map((event) => [event.uuid, event]));
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let pagesFetched = 0;
  let matchedEvents = 0;
  let updatedEvents = 0;
  do {
    const page = record(await api.request(`/collector/sync/status?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    if (!Array.isArray(page.data) || !Array.isArray(page.rejectedSubmissions) || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor))) throw new Error('invalidResponse');
    const nextCursor = page.nextCursor as string | null;
    if (nextCursor && cursors.has(nextCursor)) throw new Error('invalidResponse');
    // Parse each page once, match by UUID in O(1), and never re-write unchanged verdicts.
    // Rejections repeat on each API page; deleting matched UUIDs also deduplicates them.
    const results = [...page.data, ...page.rejectedSubmissions].map(parseResultRow);
    if (results.some((result) => !result)) throw new Error('invalidResponse');
    for (const result of results) {
      if (!result) continue;
      const event = remaining.get(result.client_uuid);
      if (!event) continue;
      if (JSON.stringify(event.result) !== JSON.stringify(result) || event.verdict !== result.status || event.lastError !== null) {
        await transition(event.uuid, api.scope, { type: 'ACK', result });
        updatedEvents += 1;
      }
      remaining.delete(event.uuid);
      matchedEvents += 1;
    }
    pagesFetched += 1;
    cursor = nextCursor;
    if (cursor) cursors.add(cursor);
  } while (cursor && remaining.size);
  // Diagnostics summarize only this reconciliation; do not accumulate all server history.
  return { pagesFetched, matchedEvents, updatedEvents, unmatchedEvents: remaining.size, nextCursor: cursor };
}
