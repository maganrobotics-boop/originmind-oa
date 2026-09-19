-- Additive, explicit initialization. Do not run automatically on request or at import.
-- Control metadata only: no tenant access tokens, app secrets, passwords or transcript text.
CREATE TABLE IF NOT EXISTS oa_meeting_bot_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  binding TEXT NOT NULL,
  meeting_no TEXT NOT NULL CHECK(length(meeting_no)=9 AND meeting_no NOT GLOB '*[^0-9]*'),
  meeting_id TEXT NOT NULL DEFAULT '',
  owner_member_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('joining','accepted','verified','join_unknown','failed','leaving','leave_unknown','left')),
  last_code TEXT NOT NULL DEFAULT '',
  last_verified_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- The same application is one visible participant. Never issue a second join while
-- its preceding operation is active or uncertain, even from another browser/admin.
CREATE UNIQUE INDEX IF NOT EXISTS oa_meeting_bot_one_active
  ON oa_meeting_bot_sessions(binding,meeting_no)
  WHERE state NOT IN ('left','failed');
CREATE INDEX IF NOT EXISTS oa_meeting_bot_owner
  ON oa_meeting_bot_sessions(binding,owner_member_id,owner_account_id,updated_at DESC);
