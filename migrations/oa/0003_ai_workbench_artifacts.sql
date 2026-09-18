-- Additive and repeat-safe. Keep existing tasks and any legacy extension data.
-- A task is successful only after both actual files are saved in the same D1 batch.
CREATE TABLE IF NOT EXISTS ai_workbench_artifacts (
 task_id TEXT NOT NULL REFERENCES ai_workbench_tasks(id),
 format TEXT NOT NULL CHECK(format IN ('md','docx')),
 content_base64 TEXT NOT NULL,
 byte_size INTEGER NOT NULL CHECK(byte_size > 0 AND byte_size <= 1000000),
 sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
 lease_token TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(task_id, format)
);
