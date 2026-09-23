CREATE TABLE newbie_profiles (
  email TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '',
  major TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT 'undecided'
    CHECK (direction IN ('undecided', 'perception', 'navigation', 'control', 'mechanics', 'ai')),
  bio TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE newbie_task_progress (
  email TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'completed')),
  evidence TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (email, task_id)
);

CREATE INDEX idx_newbie_task_progress_email_updated
  ON newbie_task_progress (email, updated_at DESC);

