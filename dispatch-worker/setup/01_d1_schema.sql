-- Run once on a NEW D1 database named 2fly-dispatch-db. No Supabase SQL.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS staff (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 name TEXT NOT NULL, key_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff(id),
 key_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS photo_budget (id INTEGER PRIMARY KEY CHECK(id=1), used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes>=0), max_bytes INTEGER NOT NULL DEFAULT 8000000000);
INSERT OR IGNORE INTO photo_budget(id) VALUES(1);
CREATE TABLE IF NOT EXISTS records (
 id TEXT PRIMARY KEY,
 data TEXT NOT NULL CHECK(json_valid(data)), version INTEGER NOT NULL DEFAULT 1,
 kind TEXT GENERATED ALWAYS AS (json_extract(data,'$.kind')) STORED,
 status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
 reference TEXT GENERATED ALWAYS AS (json_extract(data,'$.reference')) STORED,
 customer TEXT GENERATED ALWAYS AS (json_extract(data,'$.customer')) STORED,
 tracking TEXT GENERATED ALWAYS AS (json_extract(data,'$.tracking')) STORED,
 created_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.created_at')) STORED,
 retention_from TEXT GENERATED ALWAYS AS (json_extract(data,'$.retention_from')) STORED
);
CREATE INDEX IF NOT EXISTS records_kind_date ON records(kind,created_at DESC);
CREATE INDEX IF NOT EXISTS records_reference_status ON records(reference,kind,status);
CREATE TABLE IF NOT EXISTS photos (
 path TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES staff(id), bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 600000),
 state TEXT NOT NULL CHECK(state IN ('uploading','uploaded','attached','deleting','deleted')),
 record_id TEXT REFERENCES records(id), created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS photos_state_date ON photos(state,created_at);
CREATE INDEX IF NOT EXISTS photos_record ON photos(record_id);
CREATE TRIGGER IF NOT EXISTS photo_reserve BEFORE INSERT ON photos BEGIN
 SELECT CASE WHEN (SELECT used_bytes+NEW.bytes>max_bytes FROM photo_budget WHERE id=1) THEN RAISE(ABORT,'PHOTO_BUDGET_FULL') END;
 UPDATE photo_budget SET used_bytes=used_bytes+NEW.bytes WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS photo_release AFTER UPDATE OF state ON photos WHEN NEW.state='deleted' AND OLD.state<>'deleted' BEGIN
 UPDATE photo_budget SET used_bytes=used_bytes-NEW.bytes WHERE id=1;
END;
-- Validate and attach photos in the SAME transaction as the record save.
CREATE TRIGGER IF NOT EXISTS attach_on_insert AFTER INSERT ON records BEGIN
 SELECT CASE WHEN EXISTS (
 SELECT 1 FROM json_each(NEW.data,'$.photos') j LEFT JOIN photos p ON p.path=json_extract(j.value,'$.path')
 WHERE p.path IS NULL OR p.state<>'uploaded' OR p.owner_id<>json_extract(j.value,'$.user_id')
 ) THEN RAISE(ABORT,'PHOTO_NOT_READY') END;
 UPDATE photos SET state='attached',record_id=NEW.id WHERE path IN (SELECT json_extract(value,'$.path') FROM json_each(NEW.data,'$.photos'));
END;
CREATE TRIGGER IF NOT EXISTS attach_on_update AFTER UPDATE OF data ON records BEGIN
 SELECT CASE WHEN EXISTS (
 SELECT 1 FROM json_each(NEW.data,'$.photos') j LEFT JOIN photos p ON p.path=json_extract(j.value,'$.path')
 WHERE p.path IS NULL OR COALESCE((
 p.record_id=NEW.id OR (p.record_id IS NULL AND p.state='uploaded' AND p.owner_id=json_extract(j.value,'$.user_id'))
 ),0)=0) THEN RAISE(ABORT,'PHOTO_NOT_READY') END;
 UPDATE photos SET state='attached',record_id=NEW.id WHERE record_id IS NULL AND path IN (SELECT json_extract(value,'$.path') FROM json_each(NEW.data,'$.photos'));
END;