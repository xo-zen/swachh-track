import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SCHEMA } from './schema';
import { initialQueueState, queueReducer, type QueueState, type Result } from './model';

function insertEvent(db: DatabaseSync): void {
  db.prepare('INSERT INTO events(uuid,scope,stop_id,capture_json,state_json,created_at) VALUES (?,?,?,?,?,?)').run('event', 'user:membership', 'stop', '{"offline":true}', JSON.stringify(initialQueueState), '2026-04-01T04:00:00Z');
}

describe('host SQLite invariants (not Expo/device integration)', () => {
  it('rolls back event plus photos together and preserves the capture draft', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`PRAGMA foreign_keys=ON; ${SCHEMA}`);
      db.prepare('INSERT INTO drafts VALUES (?,?,?,?)').run('event', 'user:membership', 'stop', '{}');
      db.exec('BEGIN IMMEDIATE');
      insertEvent(db);
      db.prepare('INSERT INTO photos(local_id,event_uuid,uri,kind) VALUES (?,?,?,?)').run('photo', 'event', 'file:///photo.jpg', 'DOORSTEP');
      expect(() => db.prepare('INSERT INTO photos(local_id,event_uuid,uri,kind) VALUES (?,?,?,?)').run('photo', 'event', 'file:///second.jpg', 'SCALE')).toThrow();
      db.exec('ROLLBACK');
      expect(db.prepare('SELECT * FROM events').all()).toHaveLength(0);
      expect(db.prepare('SELECT * FROM photos').all()).toHaveLength(0);
      expect(db.prepare('SELECT * FROM drafts').all()).toHaveLength(1);
    } finally { db.close(); }
  });
  it('prevents changing evidence, wire payload, confirmed photos or deleting rejected events', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(SCHEMA); insertEvent(db);
      expect(() => db.exec("UPDATE events SET capture_json='different' WHERE uuid='event'")).toThrow('Immutable capture');
      db.exec("UPDATE events SET payload_json='frozen' WHERE uuid='event'");
      expect(() => db.exec("UPDATE events SET payload_json='changed' WHERE uuid='event'")).toThrow('Immutable payload');
      db.prepare('UPDATE events SET state_json=? WHERE uuid=?').run(JSON.stringify(queueReducer(initialQueueState, { type: 'HARD_REJECT', error: 'BAD_QR' })), 'event');
      expect(() => db.exec("DELETE FROM events WHERE uuid='event'")).toThrow('Event retention required');
      db.exec("INSERT INTO photos(local_id,event_uuid,uri,kind) VALUES ('photo','event','file:///photo.jpg','DOORSTEP')");
      db.exec("UPDATE photos SET stage='CONFIRMED', photo_id='server-photo' WHERE local_id='photo'");
      expect(() => db.exec("UPDATE photos SET photo_id='replacement' WHERE local_id='photo'")).toThrow('Confirmed photo is immutable');
    } finally { db.close(); }
  });
  it('retains queue, cache and upload checkpoint across close/reopen; recovers only the sync lease', () => {
    const directory = mkdtempSync(join(tmpdir(), 'swachh-collector-test-'));
    const path = join(directory, 'queue.db');
    let db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; ${SCHEMA}`);
      insertEvent(db);
      db.prepare('UPDATE events SET state_json=? WHERE uuid=?').run(JSON.stringify(queueReducer(initialQueueState, { type: 'START' })), 'event');
      db.exec("INSERT INTO photos(local_id,event_uuid,uri,kind,stage,photo_id) VALUES ('photo','event','file:///photo.jpg','DOORSTEP','UPLOADED','server-photo')");
      db.prepare('INSERT INTO routes VALUES (?,?,?)').run('user:membership', '[]', '2026-04-01T04:00:00Z');
      db.close(); db = new DatabaseSync(path);
      const saved = db.prepare('SELECT state_json FROM events WHERE uuid=?').get('event');
      const recovered = queueReducer(JSON.parse(String(saved?.state_json)) as QueueState, { type: 'RECOVER' });
      expect(recovered).toMatchObject({ transport: 'PENDING', attempts: 1 });
      expect(db.prepare('SELECT stage,photo_id FROM photos').get()).toMatchObject({ stage: 'UPLOADED', photo_id: 'server-photo' });
      expect(db.prepare('SELECT scope FROM routes').all()).toHaveLength(1);
      expect(db.prepare('SELECT * FROM events WHERE scope=?').all('different:membership')).toHaveLength(0);
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('persists an expiry reset and later supervisor verdict without changing capture, wire payload or photo URI', () => {
    const directory = mkdtempSync(join(tmpdir(), 'swachh-collector-test-'));
    const path = join(directory, 'queue.db');
    let db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; ${SCHEMA}`);
      insertEvent(db);
      db.exec("INSERT INTO photos(local_id,event_uuid,uri,kind,stage,photo_id) VALUES ('photo','event','file:///documents/photo.jpg','DOORSTEP','UPLOADED','expired-photo')");
      db.exec('BEGIN IMMEDIATE');
      db.exec("UPDATE photos SET stage='LOCAL', photo_id=NULL, upload_url=NULL, metadata_json=NULL WHERE local_id='photo'");
      const failed = queueReducer(queueReducer(initialQueueState, { type: 'START' }), { type: 'FAIL', now: 1000, error: 'UPLOAD_EXPIRED' });
      db.prepare('UPDATE events SET state_json=? WHERE uuid=?').run(JSON.stringify(failed), 'event');
      db.exec('COMMIT');
      db.close(); db = new DatabaseSync(path);
      expect(db.prepare('SELECT stage,photo_id,uri,event_uuid FROM photos').get()).toMatchObject({ stage: 'LOCAL', photo_id: null, uri: 'file:///documents/photo.jpg', event_uuid: 'event' });
      expect(JSON.parse(String(db.prepare('SELECT state_json FROM events').get()?.state_json))).toMatchObject({ transport: 'PENDING', verdict: null });
      db.exec("UPDATE photos SET stage='CONFIRMED', photo_id='renewed-photo', metadata_json='{\"sha256\":\"normalized\"}' WHERE local_id='photo'");
      const wire = '{"client_uuid":"event","doorstepPhotoId":"renewed-photo"}';
      db.prepare('UPDATE events SET payload_json=? WHERE uuid=?').run(wire, 'event');
      const review: Result = { client_uuid: 'event', id: 'server-event', status: 'NEEDS_REVIEW', verificationScore: 85, verificationReasons: ['OFFLINE_CAPTURE'] };
      const received = queueReducer(failed, { type: 'ACK', result: review });
      const approved = queueReducer(received, { type: 'ACK', result: { ...review, status: 'VERIFIED' } });
      db.prepare('UPDATE events SET state_json=? WHERE uuid=?').run(JSON.stringify(approved), 'event');
      db.close(); db = new DatabaseSync(path);
      const row = db.prepare('SELECT * FROM events').get();
      expect(row).toMatchObject({ uuid: 'event', capture_json: '{"offline":true}', payload_json: wire });
      expect(JSON.parse(String(row?.state_json))).toMatchObject({ transport: 'SYNCED', verdict: 'VERIFIED', result: { verificationReasons: ['OFFLINE_CAPTURE'] } });
      expect(db.prepare('SELECT stage,photo_id,uri FROM photos').get()).toMatchObject({ stage: 'CONFIRMED', photo_id: 'renewed-photo', uri: 'file:///documents/photo.jpg' });
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
