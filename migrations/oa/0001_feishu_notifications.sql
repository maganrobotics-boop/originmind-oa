CREATE TABLE IF NOT EXISTS notification_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_event_id INTEGER NOT NULL
);
-- Start at the existing event watermark; do not message historical approvals.
INSERT OR IGNORE INTO notification_control (id, last_event_id)
SELECT 1, COALESCE(MAX(id), 0) FROM approval_events;
CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  approval_id TEXT,
  target_member_id TEXT NOT NULL,
  target_account_user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  step TEXT NOT NULL,
  cycle_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  first_attempt_at INTEGER,
  lease_token TEXT,
  lease_expires_at INTEGER,
  message_id TEXT,
  failure_code TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS notification_outbox_due ON notification_outbox(status, next_attempt_at);
