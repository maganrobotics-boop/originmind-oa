CREATE TABLE email_login_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER DEFAULT 0 NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX idx_email_login_challenges_email_expires ON email_login_challenges (email, expires_at);

CREATE TABLE visitor_sessions (
  hash TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student', 'staff')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_visitor_sessions_expires ON visitor_sessions (expires_at);
