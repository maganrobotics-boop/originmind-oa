CREATE TABLE IF NOT EXISTS oa_review_policy (
  id INTEGER PRIMARY KEY CHECK(id=1),
  technical_json TEXT NOT NULL,
  finance_json TEXT NOT NULL,
  owner_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS expense_reviews (
  transaction_id TEXT PRIMARY KEY REFERENCES expense_transactions(id),
  basis TEXT NOT NULL DEFAULT '',
  finance_at TEXT NOT NULL DEFAULT '', finance_by TEXT NOT NULL DEFAULT '',
  owner_at TEXT NOT NULL DEFAULT '', owner_by TEXT NOT NULL DEFAULT '',
  archived_at TEXT NOT NULL DEFAULT '', archived_by TEXT NOT NULL DEFAULT '',
  return_note TEXT NOT NULL DEFAULT '', mutation_token TEXT NOT NULL DEFAULT ''
);
