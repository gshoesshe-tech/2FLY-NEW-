-- 2FLY Dispatch integration for the existing 2FLY Numbers website.
-- Run AFTER setup/01_d1_schema.sql in the existing 2fly-dispatch-db.
-- Safe to re-run. It does not alter or delete standalone tracker records.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS dispatch_orders (
  order_id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  fulfillment_method TEXT NOT NULL DEFAULT '',
  source_created_at TEXT NOT NULL,
  source_status TEXT NOT NULL DEFAULT '',
  source_payment_status TEXT NOT NULL DEFAULT '',
  tracking TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'needs_packing'
    CHECK(stage IN ('needs_packing','packing','packed','ready_for_pickup','shipped','cancelled')),
  queued_at TEXT NOT NULL,
  claimed_by TEXT,
  claimed_name TEXT,
  claimed_at TEXT,
  packed_by TEXT,
  packed_name TEXT,
  packed_at TEXT,
  ready_by TEXT,
  ready_name TEXT,
  ready_at TEXT,
  shipped_by TEXT,
  shipped_name TEXT,
  shipped_at TEXT,
  shipped_at_ph TEXT,
  updated_at TEXT NOT NULL,
  last_synced_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS dispatch_orders_stage_queue ON dispatch_orders(stage, queued_at, order_id);
CREATE INDEX IF NOT EXISTS dispatch_orders_search_order ON dispatch_orders(order_number);
CREATE INDEX IF NOT EXISTS dispatch_orders_search_customer ON dispatch_orders(customer_name);
CREATE INDEX IF NOT EXISTS dispatch_orders_tracking ON dispatch_orders(tracking);

CREATE TABLE IF NOT EXISTS dispatch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES dispatch_orders(order_id) ON DELETE CASCADE,
  issue_id TEXT,
  event_type TEXT NOT NULL,
  actor_user_id TEXT,
  actor_name TEXT,
  event_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  photo_path TEXT
);
CREATE INDEX IF NOT EXISTS dispatch_events_order ON dispatch_events(order_id, event_at DESC, id DESC);

-- Shared 8 GB safety budget with the original tracker. If the original schema already
-- exists, these statements are no-ops.
CREATE TABLE IF NOT EXISTS photo_budget (
  id INTEGER PRIMARY KEY CHECK(id=1),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
  max_bytes INTEGER NOT NULL DEFAULT 8000000000
);
INSERT OR IGNORE INTO photo_budget(id) VALUES(1);

CREATE TABLE IF NOT EXISTS dispatch_photos (
  path TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  issue_id TEXT,
  owner_user_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 600000),
  stage TEXT NOT NULL CHECK(stage IN ('packing','waybill','additional','missing_issue','missing_resolution')),
  state TEXT NOT NULL CHECK(state IN ('uploading','uploaded','attached','deleting','deleted')),
  created_at TEXT NOT NULL,
  attached_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS dispatch_photos_order ON dispatch_photos(order_id, created_at, path);
CREATE INDEX IF NOT EXISTS dispatch_photos_issue ON dispatch_photos(issue_id, created_at, path);
CREATE INDEX IF NOT EXISTS dispatch_photos_state_date ON dispatch_photos(state, created_at);

CREATE TRIGGER IF NOT EXISTS dispatch_photo_reserve
BEFORE INSERT ON dispatch_photos
BEGIN
  SELECT CASE WHEN (SELECT used_bytes + NEW.bytes > max_bytes FROM photo_budget WHERE id=1)
    THEN RAISE(ABORT,'PHOTO_BUDGET_FULL') END;
  UPDATE photo_budget SET used_bytes = used_bytes + NEW.bytes WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS dispatch_photo_release
AFTER UPDATE OF state ON dispatch_photos
WHEN NEW.state='deleted' AND OLD.state<>'deleted'
BEGIN
  UPDATE photo_budget SET used_bytes = used_bytes - NEW.bytes WHERE id=1;
END;

CREATE TABLE IF NOT EXISTS dispatch_missing_issues (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES dispatch_orders(order_id) ON DELETE CASCADE,
  item_key TEXT NOT NULL DEFAULT '',
  item_label TEXT NOT NULL,
  missing_quantity INTEGER NOT NULL CHECK(missing_quantity > 0),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  created_by TEXT NOT NULL,
  created_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_by TEXT,
  resolved_name TEXT,
  resolved_at TEXT,
  resolution_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS dispatch_missing_order_status ON dispatch_missing_issues(order_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS dispatch_notifications (
  id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  audience TEXT NOT NULL CHECK(audience IN ('packing','shipment')),
  order_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dispatch_notifications_audience_date ON dispatch_notifications(audience, created_at DESC);

CREATE TABLE IF NOT EXISTS dispatch_notification_reads (
  notification_id TEXT NOT NULL REFERENCES dispatch_notifications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY(notification_id, user_id)
);

CREATE TABLE IF NOT EXISTS dispatch_push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  can_pack INTEGER NOT NULL DEFAULT 0 CHECK(can_pack IN (0,1)),
  can_ship INTEGER NOT NULL DEFAULT 0 CHECK(can_ship IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dispatch_push_user ON dispatch_push_subscriptions(user_id, active);