CREATE TABLE IF NOT EXISTS project_work_items (
 id TEXT PRIMARY KEY,
 project TEXT NOT NULL,
 title TEXT NOT NULL,
 detail TEXT NOT NULL DEFAULT '',
 kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task','meeting_action','risk','milestone')),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','done','cancelled')),
 priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
 assignee_name TEXT NOT NULL DEFAULT '',
 assignee_email TEXT NOT NULL DEFAULT '',
 due_at TEXT,
 source_type TEXT NOT NULL DEFAULT 'manual' CHECK(source_type IN ('manual','meeting','approval')),
 source_id TEXT NOT NULL DEFAULT '',
 source_key TEXT,
 created_by_name TEXT NOT NULL,
 created_by_email TEXT NOT NULL,
 completed_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS project_work_items_source_key_unique ON project_work_items(source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_work_items_assignee_status_idx ON project_work_items(assignee_email,status,due_at);
CREATE INDEX IF NOT EXISTS project_work_items_project_updated_idx ON project_work_items(project,updated_at);
