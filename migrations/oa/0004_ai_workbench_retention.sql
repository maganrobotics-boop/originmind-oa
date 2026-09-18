-- Forward-only enrollment: no INSERT SELECT from historical tasks.
-- Explicit archive intent protects the task before any knowledge write occurs.
CREATE TABLE IF NOT EXISTS ai_workbench_retention (
 task_id TEXT PRIMARY KEY REFERENCES ai_workbench_tasks(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('temporary','archiving','submitted','deleting')),
 expires_at INTEGER,
 knowledge_item_id TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_workbench_retention_due ON ai_workbench_retention(state, expires_at);
CREATE TRIGGER IF NOT EXISTS ai_workbench_retention_enroll
 AFTER INSERT ON ai_workbench_tasks WHEN NEW.origin = 'oa'
 BEGIN
  INSERT INTO ai_workbench_retention(task_id,state,expires_at,created_at,updated_at)
  VALUES(NEW.id,'temporary',NEW.created_at + 604800000,NEW.created_at,NEW.created_at);
 END;
