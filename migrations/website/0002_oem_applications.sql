CREATE TABLE IF NOT EXISTS oem_applications (
  id TEXT PRIMARY KEY NOT NULL,
  submission_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  language TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  source_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oem_applications_created ON oem_applications(created_at DESC, id);
CREATE INDEX IF NOT EXISTS oem_applications_source ON oem_applications(source_hash, created_at);
