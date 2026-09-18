-- Private task ledger. No task output is published into the knowledge base.
CREATE TABLE IF NOT EXISTS ai_workbench_tasks (
 id TEXT PRIMARY KEY,
 member_id TEXT NOT NULL REFERENCES members(id), account_user_id TEXT NOT NULL,
 member_revision TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
 instruction TEXT NOT NULL, material TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 result TEXT NOT NULL DEFAULT '', failure_code TEXT NOT NULL DEFAULT '',
 attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER,
 origin TEXT NOT NULL DEFAULT 'oa' CHECK(origin IN ('oa','feishu')),
 origin_key TEXT NOT NULL, feishu_subject TEXT NOT NULL DEFAULT '',
 delivery_parts INTEGER NOT NULL DEFAULT 0, delivery_started_at INTEGER,
 delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_status IN ('pending','sent','needs_review','skipped')),
 delivery_lease TEXT, delivery_lease_until INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(member_id, account_user_id, origin_key)
);
CREATE INDEX IF NOT EXISTS ai_workbench_owner ON ai_workbench_tasks(member_id, account_user_id, created_at);
CREATE INDEX IF NOT EXISTS ai_workbench_queue ON ai_workbench_tasks(status, created_at);
CREATE TABLE IF NOT EXISTS ai_workbench_feishu_inbox (
 message_id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), account_user_id TEXT NOT NULL,
 chat_id TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
);
