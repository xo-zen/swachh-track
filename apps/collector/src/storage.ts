import * as SQLite from 'expo-sqlite';
import { SCHEMA } from './schema';
import {
  freezeCapture, initialQueueState, materializePayload, queueReducer,
  type CaptureDraft, type PhotoRow, type PickupPayload, type QueueAction, type QueueEvent,
  type QueueState, type Route,
} from './model';

let database: Promise<SQLite.SQLiteDatabase> | null = null;
let writes: Promise<unknown> = Promise.resolve();

async function open(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync('swachh-collector.db');
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  await db.withExclusiveTransactionAsync(async (tx) => {
    await tx.execAsync(SCHEMA);
    // A process can die after claiming an event, after PUT, or after the server accepts it.
    // Recover only the transport lease; payload and per-photo checkpoints never change.
    const rows = await tx.getAllAsync<{ uuid: string; state_json: string }>('SELECT uuid, state_json FROM events');
    for (const row of rows) {
      const state = JSON.parse(row.state_json) as QueueState;
      if (state.transport === 'SYNCING') await tx.runAsync('UPDATE events SET state_json = ? WHERE uuid = ?', JSON.stringify(queueReducer(state, { type: 'RECOVER' })), row.uuid);
    }
  });
  return db;
}

export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  database ??= open().catch((error: unknown) => { database = null; throw error; });
  return database;
}

function write<T>(action: (tx: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
  const result = writes.then(async () => {
    const db = await getDatabase();
    let value: T | undefined;
    await db.withExclusiveTransactionAsync(async (tx) => { value = await action(tx); });
    return value as T;
  });
  writes = result.catch(() => undefined);
  return result;
}

export async function cachedRoutes(scope: string): Promise<{ routes: Route[]; cachedAt: string } | null> {
  const row = await (await getDatabase()).getFirstAsync<{ json: string; cached_at: string }>('SELECT json, cached_at FROM routes WHERE scope = ?', scope);
  return row ? { routes: JSON.parse(row.json) as Route[], cachedAt: row.cached_at } : null;
}

export function cacheRoutes(scope: string, routes: Route[]): Promise<void> {
  return write(async (tx) => { await tx.runAsync('INSERT INTO routes(scope, json, cached_at) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET json=excluded.json, cached_at=excluded.cached_at', scope, JSON.stringify(routes), new Date().toISOString()); });
}

export async function loadDraft(scope: string, stopId: string): Promise<CaptureDraft | null> {
  const row = await (await getDatabase()).getFirstAsync<{ json: string }>('SELECT json FROM drafts WHERE scope = ? AND stop_id = ?', scope, stopId);
  return row ? JSON.parse(row.json) as CaptureDraft : null;
}

export function saveDraft(draft: CaptureDraft): Promise<void> {
  // Snapshot at invocation, before another keystroke can be persisted.
  const json = JSON.stringify(draft);
  return write(async (tx) => {
    const saved = await tx.getFirstAsync('SELECT uuid FROM events WHERE scope = ? AND stop_id = ?', draft.scope, draft.stop.id);
    if (saved) throw new Error('alreadyQueued');
    await tx.runAsync('INSERT INTO drafts(uuid, scope, stop_id, json) VALUES (?, ?, ?, ?) ON CONFLICT(scope, stop_id) DO UPDATE SET json=excluded.json', draft.client_uuid, draft.scope, draft.stop.id, json);
  });
}

export function enqueue(draft: CaptureDraft, deviceId: string): Promise<void> {
  const { payload, photos } = freezeCapture(draft, deviceId);
  return write(async (tx) => {
    await tx.runAsync('INSERT INTO events(uuid, scope, stop_id, capture_json, state_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', draft.client_uuid, draft.scope, draft.stop.id, JSON.stringify(payload), JSON.stringify(initialQueueState), payload.capturedAt);
    for (const photo of photos) await tx.runAsync('INSERT INTO photos(local_id, event_uuid, uri, kind, stream) VALUES (?, ?, ?, ?, ?)', photo.id, draft.client_uuid, photo.uri, photo.kind, photo.stream ?? null);
    await tx.runAsync('DELETE FROM drafts WHERE uuid = ? AND scope = ?', draft.client_uuid, draft.scope);
  });
}

interface EventRow { uuid: string; scope: string; stop_id: string; capture_json: string; payload_json: string | null; state_json: string; created_at: string }
function eventFromRow(row: EventRow): QueueEvent {
  return { uuid: row.uuid, scope: row.scope, stopId: row.stop_id, captureJson: row.capture_json, payloadJson: row.payload_json, createdAt: row.created_at, ...JSON.parse(row.state_json) as QueueState };
}

export async function listEvents(scope: string): Promise<QueueEvent[]> {
  return (await (await getDatabase()).getAllAsync<EventRow>('SELECT * FROM events WHERE scope = ? ORDER BY created_at', scope)).map(eventFromRow);
}

export function transition(uuid: string, scope: string, action: QueueAction): Promise<QueueEvent> {
  return write(async (tx) => {
    const row = await tx.getFirstAsync<EventRow>('SELECT * FROM events WHERE uuid = ? AND scope = ?', uuid, scope);
    if (!row) throw new Error('eventMissing');
    const state = queueReducer(JSON.parse(row.state_json) as QueueState, action);
    await tx.runAsync('UPDATE events SET state_json = ? WHERE uuid = ? AND scope = ?', JSON.stringify(state), uuid, scope);
    return eventFromRow({ ...row, state_json: JSON.stringify(state) });
  });
}

export async function listPhotos(uuid: string): Promise<PhotoRow[]> {
  return (await getDatabase()).getAllAsync<PhotoRow>(`SELECT local_id AS localId, event_uuid AS eventUuid, uri, kind, stream, stage, photo_id AS photoId, upload_url AS uploadUrl, metadata_json AS metadataJson FROM photos WHERE event_uuid = ? ORDER BY local_id`, uuid);
}

export function checkpointPhoto(photo: PhotoRow): Promise<void> {
  return write(async (tx) => { await tx.runAsync('UPDATE photos SET stage = ?, photo_id = ?, upload_url = ?, metadata_json = ? WHERE local_id = ? AND event_uuid = ?', photo.stage, photo.photoId, photo.uploadUrl, photo.metadataJson, photo.localId, photo.eventUuid); });
}

export function freezeWirePayload(uuid: string, scope: string): Promise<string> {
  return write(async (tx) => {
    const row = await tx.getFirstAsync<EventRow>('SELECT * FROM events WHERE uuid = ? AND scope = ?', uuid, scope);
    if (!row) throw new Error('eventMissing');
    if (row.payload_json) return row.payload_json;
    const photos = await tx.getAllAsync<PhotoRow>(`SELECT local_id AS localId, event_uuid AS eventUuid, uri, kind, stream, stage, photo_id AS photoId, upload_url AS uploadUrl, metadata_json AS metadataJson FROM photos WHERE event_uuid = ?`, uuid);
    const json = JSON.stringify(materializePayload(JSON.parse(row.capture_json) as PickupPayload, photos));
    await tx.runAsync('UPDATE events SET payload_json = ? WHERE uuid = ? AND scope = ?', json, uuid, scope);
    return json;
  });
}
