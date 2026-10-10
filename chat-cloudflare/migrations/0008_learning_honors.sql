-- Honors are independent of course progress, permissions and rescue rules.
CREATE TABLE learning_honors (
  id TEXT PRIMARY KEY NOT NULL,
  recipient_name TEXT NOT NULL CHECK (length(recipient_name) BETWEEN 1 AND 80),
  recipient_email TEXT,
  category TEXT NOT NULL CHECK (category IN ('newbie', 'alumni', 'competition', 'contribution', 'other')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  message TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 600),
  achievement_date TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('manual_confirmation', 'reference')),
  source_reference TEXT NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 1200),
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'hidden')),
  status TEXT NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_learning_honors_public
  ON learning_honors (status, visibility, granted_at DESC, id);
CREATE INDEX idx_learning_honors_recipient
  ON learning_honors (recipient_email, status, granted_at DESC);

CREATE TABLE learning_honor_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  honor_id TEXT NOT NULL REFERENCES learning_honors(id),
  version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('grant', 'import', 'bind', 'hide', 'show', 'revoke')),
  actor TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  UNIQUE (honor_id, version)
);

-- Preserve the IDs, wording and issuedAt read from the existing public API on
-- 2026-10-04. Completion and prior account verification were confirmed by Ma Gan.
-- Keep private emails out of this portable migration. Import the already verified
-- bindings from the existing honors registry; do not guess from editable names
-- or require the user to repeat the earlier identity confirmation.
INSERT INTO learning_honors
  (id, recipient_name, category, title, message, source_kind, source_reference,
   granted_by, granted_at, updated_at)
VALUES
  ('newbie-20261004-1', '崔航阁', 'newbie', '新手村通关 · 机器人探索者',
   '每一次认真尝试，都是走向真实机器人的一步。', 'manual_confirmation',
   '马淦于2026-10-04明确确认崔航阁完成新手村，并要求公开展示奖杯。原公开接口 /api/learning/honors 的 ID、标题和授予时间于2026-10-04读回核对；账户此前已核验，部署时沿用现网既有绑定，私有邮箱不在公开迁移中硬编码。',
   'import:owner-confirmed-20261004', 1791099900000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('newbie-20261004-2', '刘奕鹏', 'newbie', '新手村通关 · 机器人探索者',
   '每一次认真尝试，都是走向真实机器人的一步。', 'manual_confirmation',
   '马淦于2026-10-04明确确认刘奕鹏完成新手村，并要求公开展示奖杯。原公开接口 /api/learning/honors 的 ID、标题和授予时间于2026-10-04读回核对；账户此前已核验，部署时沿用现网既有绑定，私有邮箱不在公开迁移中硬编码。',
   'import:owner-confirmed-20261004', 1791099900000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('newbie-20261004-3', '邱衡', 'newbie', '新手村通关 · 机器人探索者',
   '每一次认真尝试，都是走向真实机器人的一步。', 'manual_confirmation',
   '马淦于2026-10-04明确确认邱衡完成新手村，并要求公开展示奖杯。原公开接口 /api/learning/honors 的 ID、标题和授予时间于2026-10-04读回核对；账户此前已核验，部署时沿用现网既有绑定，私有邮箱不在公开迁移中硬编码。',
   'import:owner-confirmed-20261004', 1791099900000, CAST(strftime('%s','now') AS INTEGER) * 1000);

INSERT INTO learning_honor_events (honor_id, version, action, actor, occurred_at, note)
SELECT id, 1, 'import', 'migration:0008', updated_at, source_reference
FROM learning_honors WHERE id IN ('newbie-20261004-1', 'newbie-20261004-2', 'newbie-20261004-3');
