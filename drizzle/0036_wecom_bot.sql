CREATE TABLE wecom_bot_links (
  bot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  account_user_id TEXT NOT NULL,
  linked_member_revision TEXT NOT NULL,
  revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (bot_id, user_id),
  CHECK (length(bot_id) BETWEEN 1 AND 128),
  CHECK (length(user_id) BETWEEN 1 AND 128),
  CHECK (length(member_id) > 0 AND length(account_user_id) > 0 AND length(revision) > 0)
);
CREATE UNIQUE INDEX wecom_bot_links_active_member_unique
  ON wecom_bot_links (bot_id, member_id) WHERE revoked_at IS NULL;

CREATE TABLE wecom_bot_pairings (
  id TEXT PRIMARY KEY NOT NULL,
  bot_id TEXT NOT NULL,
  code_hash TEXT UNIQUE NOT NULL,
  member_id TEXT NOT NULL,
  account_user_id TEXT NOT NULL,
  member_revision TEXT NOT NULL,
  member_nda_approval_id TEXT,
  member_nda_accepted_at TEXT,
  member_nda_agreement_version TEXT,
  member_is_admin INTEGER NOT NULL CHECK (member_is_admin IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'candidate', 'confirmed', 'cancelled')),
  candidate_user_id TEXT,
  link_revision TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (expires_at > created_at),
  CHECK ((state = 'pending' AND candidate_user_id IS NULL) OR state <> 'pending'),
  CHECK (state NOT IN ('candidate', 'confirmed') OR length(candidate_user_id) BETWEEN 1 AND 128)
);
CREATE UNIQUE INDEX wecom_bot_pairings_active_member_unique
  ON wecom_bot_pairings (bot_id, member_id) WHERE state IN ('pending', 'candidate');
CREATE INDEX wecom_bot_pairings_expiry_idx ON wecom_bot_pairings (expires_at);

CREATE TABLE wecom_bot_messages (
  bot_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (bot_id, message_id),
  CHECK (length(bot_id) BETWEEN 1 AND 128 AND length(message_id) BETWEEN 1 AND 128 AND length(user_id) BETWEEN 1 AND 128),
  CHECK (expires_at > created_at)
);
CREATE INDEX wecom_bot_messages_expiry_idx ON wecom_bot_messages (expires_at);
CREATE INDEX wecom_bot_messages_rate_idx ON wecom_bot_messages (bot_id, user_id, created_at);
CREATE INDEX wecom_bot_messages_bot_rate_idx ON wecom_bot_messages (bot_id, created_at);
