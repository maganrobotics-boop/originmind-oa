CREATE TABLE IF NOT EXISTS expense_ledger_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO expense_ledger_meta(id,revision) VALUES(1,0);
CREATE TABLE IF NOT EXISTS expense_people (
  id TEXT PRIMARY KEY, bill_name TEXT NOT NULL UNIQUE, member_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS expense_people_member_unique ON expense_people(member_id) WHERE member_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS expense_imports (
  id TEXT PRIMARY KEY, filename TEXT NOT NULL, imported_at TEXT NOT NULL, actor TEXT NOT NULL,
  source_count INTEGER NOT NULL, selected_count INTEGER NOT NULL, ignored_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS expense_transactions (
  id TEXT PRIMARY KEY, order_no TEXT NOT NULL UNIQUE, merchant_order_no TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES expense_people(id), kind TEXT NOT NULL CHECK(kind IN ('payment','refund')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>=0), occurred_at TEXT NOT NULL,
  description TEXT NOT NULL, payment_method TEXT NOT NULL, trade_status TEXT NOT NULL,
  source_json TEXT NOT NULL, source_line INTEGER NOT NULL, import_id TEXT NOT NULL REFERENCES expense_imports(id)
);
CREATE INDEX IF NOT EXISTS expense_transactions_person_date ON expense_transactions(person_id,occurred_at);
CREATE TABLE IF NOT EXISTS expense_claims (
  transaction_id TEXT PRIMARY KEY REFERENCES expense_transactions(id),
  stage TEXT NOT NULL DEFAULT 'unknown', project_name TEXT NOT NULL DEFAULT '', approval_id TEXT NOT NULL DEFAULT '',
  expected_date TEXT NOT NULL DEFAULT '', submitted_date TEXT NOT NULL DEFAULT '', received_date TEXT NOT NULL DEFAULT '',
  reimbursed_cents INTEGER NOT NULL DEFAULT 0 CHECK(reimbursed_cents>=0),
  reference TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', handler TEXT NOT NULL DEFAULT '',
  confirmation_status TEXT NOT NULL DEFAULT 'pending', confirmed_at TEXT NOT NULL DEFAULT '', confirmed_by TEXT NOT NULL DEFAULT '',
  confirmed_net_cents INTEGER, confirmation_note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, mutation_token TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS expense_events (
  id TEXT PRIMARY KEY, target_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS expense_events_target ON expense_events(target_id,occurred_at);
CREATE TABLE IF NOT EXISTS expense_labor_payments (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(id), paid_cents INTEGER NOT NULL CHECK(paid_cents>=0),
  paid_date TEXT NOT NULL DEFAULT '', reference TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, mutation_token TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS personnel_workflow_config (
  id INTEGER PRIMARY KEY CHECK(id=1), reviewer_member_id TEXT NOT NULL REFERENCES members(id),
  dispute_owner_member_id TEXT NOT NULL REFERENCES members(id)
);
CREATE TABLE IF NOT EXISTS personnel_weekly_entries (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), source_key TEXT NOT NULL,
  source_title TEXT NOT NULL, source_text TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft', client_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, confirmed_at TEXT NOT NULL DEFAULT '', mutation_token TEXT NOT NULL,
  UNIQUE(member_id,source_key)
);
CREATE TABLE IF NOT EXISTS personnel_disputes (
  id TEXT PRIMARY KEY, target_type TEXT NOT NULL CHECK(target_type IN ('expense','work')), target_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id), assignee_member_id TEXT NOT NULL REFERENCES members(id),
  reason TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', resolution TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, resolved_at TEXT NOT NULL DEFAULT '', resolved_by TEXT NOT NULL DEFAULT '', mutation_token TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS personnel_disputes_open ON personnel_disputes(target_type,target_id) WHERE state='open';
