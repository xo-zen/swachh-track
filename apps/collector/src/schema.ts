// Shared by the Expo store and host-side SQLite invariant tests (not native-device tests).
export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS routes (scope TEXT PRIMARY KEY, json TEXT NOT NULL, cached_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS drafts (uuid TEXT PRIMARY KEY, scope TEXT NOT NULL, stop_id TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(scope, stop_id));
  CREATE TABLE IF NOT EXISTS events (
    uuid TEXT PRIMARY KEY, scope TEXT NOT NULL, stop_id TEXT NOT NULL,
    capture_json TEXT NOT NULL, payload_json TEXT, state_json TEXT NOT NULL,
    created_at TEXT NOT NULL, UNIQUE(scope, stop_id)
  );
  CREATE INDEX IF NOT EXISTS events_scope ON events(scope, created_at);
  CREATE TABLE IF NOT EXISTS photos (
    local_id TEXT PRIMARY KEY, event_uuid TEXT NOT NULL REFERENCES events(uuid),
    uri TEXT NOT NULL, kind TEXT NOT NULL, stream TEXT,
    stage TEXT NOT NULL DEFAULT 'LOCAL', photo_id TEXT, upload_url TEXT, metadata_json TEXT
  );
  CREATE INDEX IF NOT EXISTS photos_event ON photos(event_uuid);
  CREATE TRIGGER IF NOT EXISTS immutable_capture BEFORE UPDATE OF uuid, scope, stop_id, capture_json, created_at ON events
    BEGIN SELECT RAISE(ABORT, 'Immutable capture'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_payload BEFORE UPDATE OF payload_json ON events
    WHEN OLD.payload_json IS NOT NULL AND NEW.payload_json IS NOT OLD.payload_json
    BEGIN SELECT RAISE(ABORT, 'Immutable payload'); END;
  CREATE TRIGGER IF NOT EXISTS retain_events BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'Event retention required'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_photo BEFORE UPDATE OF local_id, event_uuid, uri, kind, stream ON photos
    BEGIN SELECT RAISE(ABORT, 'Immutable photo evidence'); END;
  CREATE TRIGGER IF NOT EXISTS confirmed_photo BEFORE UPDATE ON photos
    WHEN OLD.stage = 'CONFIRMED'
    BEGIN SELECT RAISE(ABORT, 'Confirmed photo is immutable'); END;
  PRAGMA user_version = 1;
`;
