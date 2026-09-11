import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { MIGRATION_FREEZE_ACTIVATE_SQL } from "../lib/migration-freeze.ts";
import { MIGRATION_SCHEMA_EXPECTED_OBJECT_COUNTS, migrationSchemaSelectSql } from "../lib/migration-export.mjs";

const migrationDirectory = new URL("../drizzle/", import.meta.url);
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .sort();
const migrationMetaDirectory = new URL("../drizzle/meta/", import.meta.url);

function applyMigrationRange(db, start, end) {
  for (const name of migrationFiles.slice(start, end)) {
    const sql = readFileSync(new URL(name, migrationDirectory), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      db.exec(statement);
    }
  }
}

test("verified schema projection counts include every retirement fence", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrationRange(db, 0, migrationFiles.length);
  const rows = db.prepare(migrationSchemaSelectSql()).all();
  const counts = rows.reduce((totals, row) => ({
    ...totals,
    [row.type]: (totals[row.type] || 0) + 1,
  }), {});
  assert.deepEqual({
    table: counts.table,
    index: counts.index,
    trigger: counts.trigger,
    total: rows.length,
  }, MIGRATION_SCHEMA_EXPECTED_OBJECT_COUNTS);
  db.close();
});

test("migration journal keeps one continuous snapshot chain", () => {
  const journal = JSON.parse(readFileSync(new URL("_journal.json", migrationMetaDirectory), "utf8"));
  assert.equal(journal.entries.length, migrationFiles.length);
  const snapshots = journal.entries.map((entry, index) => {
    assert.equal(entry.idx, index);
    assert.equal(`${entry.tag}.sql`, migrationFiles[index]);
    return JSON.parse(readFileSync(new URL(`${String(index).padStart(4, "0")}_snapshot.json`, migrationMetaDirectory), "utf8"));
  });
  for (let index = 1; index < snapshots.length; index += 1) {
    assert.equal(snapshots[index].prevId, snapshots[index - 1].id);
  }
});

test("production-shaped v32 data safely migrates through the GitHub identity migration", () => {
  assert.equal(migrationFiles.at(-1), "0027_careless_winter_soldier.sql");
  const db = new DatabaseSync(":memory:");
  applyMigrationRange(db, 0, 7);

  const insertMember = db.prepare(`
    INSERT INTO members (
      id, full_name, identity_number, school_email, chatgpt_account,
      role, permissions_json, status, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `);
  const timestamp = "2026-08-31T00:00:00.000Z";
  for (let index = 1; index <= 8; index += 1) {
    insertMember.run(
      `member-${index}`,
      `成员${index}`,
      `OM-${String(index).padStart(3, "0")}`,
      `member${index}@school.example`,
      `Member${index}@Example.com`,
      "member",
      index === 2 ? '["technical_advisor"]' : "[]",
      timestamp,
      timestamp,
    );
    db.prepare("INSERT INTO member_sessions (token_hash, member_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .run(`token-${index}`, `member-${index}`, timestamp, timestamp);
  }

  const insertApproval = db.prepare(`
    INSERT INTO approvals (
      id, type, title, project, requester_name, requester_email,
      created_at, updated_at, status, current_step, summary, owner,
      amount, signers_json, payload_json, current_reviewer_name,
      current_reviewer_email, period_key
    ) VALUES (?, '保密协议', ?, 'OriginMind', ?, ?, ?, ?, '已归档', '已完成', '', ?, NULL, '[]', ?, '', '', NULL)
  `);
  for (let index = 1; index <= 2; index += 1) {
    const email = `member${index}@example.com`;
    insertApproval.run(
      `nda-${index}`,
      `NDA ${index}`,
      `成员${index}`,
      email,
      timestamp,
      timestamp,
      `成员${index}`,
      JSON.stringify({
        agreementVersion: "NDA-2026-09",
        signerName: `成员${index}`,
        signerEmail: email,
        confidentialScope: "联合研发资料",
        signatureDataUrl: "data:image/png;base64,bGVnYWN5",
        previewed: true,
        agreed: true,
        signedAt: timestamp,
      }),
    );
  }

  applyMigrationRange(db, 7, migrationFiles.length);

  const members = db.prepare(`
    SELECT id, chatgpt_account, account_user_id, mutation_revision, status, permissions_json, department_code,
           nda_accepted_at, nda_approval_id, nda_agreement_version
    FROM members ORDER BY id
  `).all();
  assert.equal(members.length, 8);
  assert.ok(members.every((member) => member.status === "active"));
  assert.ok(members.every((member) => /^member\d+@example\.com$/u.test(member.chatgpt_account)));
  assert.ok(members.every((member) => /^email:member\d+@example\.com$/u.test(member.account_user_id)));
  assert.ok(members.every((member) => /^[a-f0-9]{32}$/u.test(member.mutation_revision)));
  assert.equal(members.find((member) => member.id === "member-2").permissions_json, '["technical_advisor"]');
  assert.ok(members.every((member) => member.department_code === ""));
  assert.ok(members.every((member) => member.nda_accepted_at === null));
  assert.ok(members.every((member) => member.nda_approval_id === null));
  assert.ok(members.every((member) => member.nda_agreement_version === null));

  assert.equal(db.prepare("SELECT count(*) AS count FROM approvals").get().count, 2);
  assert.equal(db.prepare("SELECT count(*) AS count FROM member_sessions WHERE expires_at IS NOT NULL").get().count, 8);
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM member_events WHERE action = 'migration_supported_email_subject'").get().count,
    8,
  );
  const guardedWrite = db.prepare(`
    UPDATE members
    SET last_seen_at = '2026-09-01T00:00:00.000Z'
    WHERE id = ?
      AND status = 'active'
      AND account_user_id = ?
      AND mutation_revision = ?
  `).run("member-2", members[1].account_user_id, members[1].mutation_revision);
  assert.equal(guardedWrite.changes, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'write_rate_buckets'").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'auth_identities'").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'oauth_transactions'").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'oauth_sessions'").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'migration_control'").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM auth_identities").get().count, 0);
  const transactionColumns = db.prepare("PRAGMA table_info(oauth_transactions)").all();
  assert.ok(transactionColumns.some((column) => column.name === "provider" && column.notnull === 1 && column.dflt_value === "'github'"));
  db.close();
});

test("database migration gate fences every persistent business table at commit time", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrationRange(db, 0, migrationFiles.length);
  const persistentTables = [
    "approvals",
    "approval_events",
    "approval_revisions",
    "labor_source_claims",
    "external_archives",
    "members",
    "member_events",
    "auth_identities",
    "account_profiles",
    "direct_messages",
    "knowledge_items",
    "knowledge_revisions",
    "knowledge_chunks",
    "knowledge_events",
  ];
  for (const table of persistentTables) {
    const count = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND name LIKE ?")
      .get(table, `${table}_migration_freeze_%`).count;
    assert.equal(count, 3, `${table} must have INSERT, UPDATE, and DELETE freeze triggers`);
  }

  db.prepare("INSERT INTO migration_control (freeze_id) VALUES (?)").run("11111111-2222-4333-8444-555555555555");
  assert.throws(
    () => db.prepare("INSERT INTO account_profiles (chatgpt_account) VALUES ('blocked@example.com')").run(),
    /migration write freeze active/u,
  );
  db.prepare("UPDATE migration_control SET deactivated_at = CURRENT_TIMESTAMP WHERE freeze_id = ?").run("11111111-2222-4333-8444-555555555555");
  assert.equal(db.prepare("INSERT INTO account_profiles (chatgpt_account) VALUES ('allowed@example.com')").run().changes, 1);
  assert.throws(
    () => db.prepare(MIGRATION_FREEZE_ACTIVATE_SQL).run("11111111-2222-4333-8444-555555555555"),
    /UNIQUE constraint failed/u,
  );
  assert.equal(db.prepare(MIGRATION_FREEZE_ACTIVATE_SQL).run("66666666-7777-4888-8999-aaaaaaaaaaaa").changes, 1);
  assert.equal(db.prepare(MIGRATION_FREEZE_ACTIVATE_SQL).run("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee").changes, 0);
  db.close();
});

test("knowledge revisions, chunks, and audit evidence stay immutable outside migration freezes", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrationRange(db, 0, migrationFiles.length);
  const createdAt = "2026-09-10T00:00:00.000Z";
  const reviewedAt = "2026-09-10T01:00:00.000Z";
  const retiredAt = "2026-09-10T02:00:00.000Z";
  db.prepare(`
    INSERT INTO knowledge_items (
      id, project, title, category, submitter_member_id, submitter_name, submitter_email,
      status, current_revision_no, current_revision_id, active_revision_id, mutation_revision, created_at, updated_at
    ) VALUES (?, 'OriginMind × ARTS Robotics 联合研发项目', '安全流程', '安全规范', ?, '投稿成员',
      'member@example.com', 'pending', 1, ?, NULL, 'mutation-1', ?, ?)
  `).run("knowledge-1", "member-1", "revision-1", createdAt, createdAt);
  db.prepare(`
    INSERT INTO knowledge_revisions (
      id, item_id, revision_no, previous_revision_id, title, category, content, summary, source_label,
      source_url, content_hash, status, created_by_member_id, created_by_name, created_by_email, created_at
    ) VALUES (?, ?, 1, NULL, '安全流程', '安全规范', '确认安全区无人后执行复位。', '复位流程',
      '安全手册', '', ?, 'pending', ?, '投稿成员', 'member@example.com', ?)
  `).run("revision-1", "knowledge-1", "a".repeat(64), "member-1", createdAt);
  db.prepare(`
    INSERT INTO knowledge_events (id, item_id, revision_id, actor_member_id, actor_name, actor_email, action, note, created_at)
    VALUES ('event-1', 'knowledge-1', 'revision-1', 'member-1', '投稿成员', 'member@example.com', 'submitted', '', ?)
  `).run(createdAt);

  assert.throws(() => db.prepare("UPDATE knowledge_items SET submitter_name = '篡改' WHERE id = 'knowledge-1'").run(), /identity is immutable/u);
  assert.throws(() => db.prepare("UPDATE knowledge_revisions SET content = '篡改' WHERE id = 'revision-1'").run(), /content is immutable/u);
  assert.throws(() => db.prepare("UPDATE knowledge_events SET note = '篡改' WHERE id = 'event-1'").run(), /append-only/u);
  assert.throws(() => db.prepare("DELETE FROM knowledge_events WHERE id = 'event-1'").run(), /append-only/u);

  assert.equal(db.prepare(`
    UPDATE knowledge_revisions SET status = 'active', reviewed_by_member_id = 'member-reviewer',
      reviewed_by_name = '审核人', reviewed_by_email = 'reviewer@example.com', review_note = '',
      reviewed_at = ?, activated_at = ? WHERE id = 'revision-1'
  `).run(reviewedAt, reviewedAt).changes, 1);
  assert.equal(db.prepare(`
    UPDATE knowledge_items SET status = 'active', active_revision_id = 'revision-1', mutation_revision = 'mutation-2', updated_at = ?
    WHERE id = 'knowledge-1'
  `).run(reviewedAt).changes, 1);
  db.prepare(`
    INSERT INTO knowledge_chunks (id, item_id, revision_id, chunk_no, content, search_text, is_active, created_at)
    VALUES ('chunk-1', 'knowledge-1', 'revision-1', 1, '确认安全区无人后执行复位。', '安全区 复位', 1, ?)
  `).run(reviewedAt);
  assert.throws(() => db.prepare("UPDATE knowledge_chunks SET content = '篡改' WHERE id = 'chunk-1'").run(), /content is immutable/u);
  assert.equal(db.prepare("UPDATE knowledge_chunks SET is_active = 0 WHERE id = 'chunk-1'").run().changes, 1);
  assert.throws(() => db.prepare("UPDATE knowledge_chunks SET is_active = 1 WHERE id = 'chunk-1'").run(), /cannot be reactivated/u);

  assert.equal(db.prepare("UPDATE knowledge_revisions SET status = 'revoked', retired_at = ? WHERE id = 'revision-1'").run(retiredAt).changes, 1);
  assert.equal(db.prepare(`
    UPDATE knowledge_items SET status = 'revoked', active_revision_id = NULL, mutation_revision = 'mutation-3',
      updated_at = ?, revoked_at = ? WHERE id = 'knowledge-1'
  `).run(retiredAt, retiredAt).changes, 1);
  assert.throws(() => db.prepare("DELETE FROM knowledge_revisions WHERE id = 'revision-1'").run(), /immutable/u);
  assert.throws(() => db.prepare("DELETE FROM knowledge_chunks WHERE id = 'chunk-1'").run(), /cannot be deleted/u);
  assert.throws(() => db.prepare("DELETE FROM knowledge_items WHERE id = 'knowledge-1'").run(), /cannot be deleted/u);
  db.close();
});

test("OAuth provider migration backfills existing transactions as GitHub", () => {
  const providerMigrationIndex = migrationFiles.indexOf("0022_exotic_shooting_star.sql");
  assert.notEqual(providerMigrationIndex, -1);

  const db = new DatabaseSync(":memory:");
  applyMigrationRange(db, 0, providerMigrationIndex);
  db.prepare(`
    INSERT INTO oauth_transactions (
      state_hash, browser_nonce_hash, pkce_verifier, action,
      member_id, return_path, created_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL)
  `).run(
    "legacy-state-hash",
    "legacy-browser-nonce-hash",
    "legacy-pkce-verifier",
    "login",
    "/profile",
    "2026-09-02T00:00:00.000Z",
    "2026-09-02T00:05:00.000Z",
  );

  applyMigrationRange(db, providerMigrationIndex, providerMigrationIndex + 1);

  const transaction = db.prepare(`
    SELECT provider FROM oauth_transactions WHERE state_hash = ?
  `).get("legacy-state-hash");
  assert.equal(transaction.provider, "github");
  db.close();
});

test("retired provider migration preserves history while ending every active integration state", () => {
  const retirementIndex = migrationFiles.indexOf("0024_retire_feishu.sql");
  assert.notEqual(retirementIndex, -1);
  const db = new DatabaseSync(":memory:");
  applyMigrationRange(db, 0, retirementIndex);

  const oldTimestamp = "2026-09-03T00:00:00.000Z";
  db.prepare("INSERT INTO auth_identities (id, member_id, provider, provider_subject, unlinked_at) VALUES (?, ?, 'feishu', ?, NULL)")
    .run("identity-active", "member-history", "cli_old_app:tenant_old:ou_active_1234");
  db.prepare("INSERT INTO auth_identities (id, member_id, provider, provider_subject, unlinked_at) VALUES (?, ?, 'feishu', ?, ?)")
    .run("identity-history", "member-history", "cli_old_app:tenant_old:ou_history_1234", oldTimestamp);
  db.prepare("INSERT INTO auth_identities (id, member_id, provider, provider_subject, unlinked_at) VALUES (?, ?, 'github', ?, NULL)")
    .run("identity-github", "member-history", "583231");

  db.prepare("INSERT INTO oauth_sessions (token_hash, provider, provider_subject, email_snapshot, expires_at, revoked_at) VALUES (?, 'feishu', ?, ?, ?, NULL)")
    .run("session-active", "cli_old_app:tenant_old:ou_active_1234", "member@example.com", "2026-10-01T00:00:00.000Z");
  db.prepare("INSERT INTO oauth_sessions (token_hash, provider, provider_subject, email_snapshot, expires_at, revoked_at) VALUES (?, 'feishu', ?, ?, ?, ?)")
    .run("session-history", "cli_old_app:tenant_old:ou_history_1234", "member@example.com", "2026-10-01T00:00:00.000Z", oldTimestamp);
  db.prepare("INSERT INTO oauth_sessions (token_hash, provider, provider_subject, email_snapshot, expires_at, revoked_at) VALUES (?, 'github', ?, ?, ?, NULL)")
    .run("session-github", "583231", "member@example.com", "2026-10-01T00:00:00.000Z");

  db.prepare("INSERT INTO oauth_transactions (state_hash, browser_nonce_hash, pkce_verifier, action, expires_at, consumed_at, provider) VALUES (?, ?, ?, 'login', ?, NULL, 'feishu')")
    .run("transaction-active", "nonce-active", "verifier-active", "2026-10-01T00:00:00.000Z");
  db.prepare("INSERT INTO oauth_transactions (state_hash, browser_nonce_hash, pkce_verifier, action, expires_at, consumed_at, provider) VALUES (?, ?, ?, 'login', ?, ?, 'feishu')")
    .run("transaction-history", "nonce-history", "verifier-history", "2026-10-01T00:00:00.000Z", oldTimestamp);
  db.prepare("INSERT INTO oauth_transactions (state_hash, browser_nonce_hash, pkce_verifier, action, expires_at, consumed_at, provider) VALUES (?, ?, ?, 'login', ?, NULL, 'github')")
    .run("transaction-github", "nonce-github", "verifier-github", "2026-10-01T00:00:00.000Z");

  const insertArchive = db.prepare("INSERT INTO external_archives (id, approval_id, destination, manifest_hash, content_hash, file_name, status, lease_token, lease_expires_at, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insertArchive.run("archive-uploaded", "approval-history", "feishu_drive", "manifest-uploaded", "content-uploaded", "uploaded.md", "uploaded", null, null, null);
  insertArchive.run("archive-failed", "approval-history", "feishu_drive", "manifest-failed", "content-failed", "failed.md", "failed", null, null, "OLD_FAILURE");
  insertArchive.run("archive-internal", "approval-history", "internal", "manifest-internal", "content-internal", "internal.md", "pending", "lease-internal", "2026-09-05T00:00:00.000Z", null);

  const insertBucket = db.prepare("INSERT INTO write_rate_buckets (bucket_key, actor_subject, scope, window_started_at, used, updated_at) VALUES (?, ?, ?, ?, 1, ?)");
  insertBucket.run("bucket-oauth", "actor", "feishu_oauth_start", oldTimestamp, oldTimestamp);
  insertBucket.run("bucket-crosswalk", "actor", "feishu_crosswalk", oldTimestamp, oldTimestamp);
  insertBucket.run("bucket-assertion", "actor", "feishu_crosswalk_assertion", oldTimestamp, oldTimestamp);
  insertBucket.run("bucket-github", "actor", "github_oauth_start", oldTimestamp, oldTimestamp);

  applyMigrationRange(db, retirementIndex, retirementIndex + 1);

  assert.notEqual(db.prepare("SELECT unlinked_at FROM auth_identities WHERE id = 'identity-active'").get().unlinked_at, null);
  assert.equal(db.prepare("SELECT unlinked_at FROM auth_identities WHERE id = 'identity-history'").get().unlinked_at, oldTimestamp);
  assert.equal(db.prepare("SELECT unlinked_at FROM auth_identities WHERE id = 'identity-github'").get().unlinked_at, null);
  assert.notEqual(db.prepare("SELECT revoked_at FROM oauth_sessions WHERE token_hash = 'session-active'").get().revoked_at, null);
  assert.equal(db.prepare("SELECT revoked_at FROM oauth_sessions WHERE token_hash = 'session-history'").get().revoked_at, oldTimestamp);
  assert.equal(db.prepare("SELECT revoked_at FROM oauth_sessions WHERE token_hash = 'session-github'").get().revoked_at, null);
  assert.notEqual(db.prepare("SELECT consumed_at FROM oauth_transactions WHERE state_hash = 'transaction-active'").get().consumed_at, null);
  assert.equal(db.prepare("SELECT consumed_at FROM oauth_transactions WHERE state_hash = 'transaction-history'").get().consumed_at, oldTimestamp);
  assert.equal(db.prepare("SELECT consumed_at FROM oauth_transactions WHERE state_hash = 'transaction-github'").get().consumed_at, null);
  assert.equal(db.prepare("SELECT status FROM external_archives WHERE id = 'archive-uploaded'").get().status, "uploaded");
  assert.equal(db.prepare("SELECT error_code FROM external_archives WHERE id = 'archive-failed'").get().error_code, "OLD_FAILURE");
  assert.equal(db.prepare("SELECT status FROM external_archives WHERE id = 'archive-internal'").get().status, "pending");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM write_rate_buckets WHERE scope LIKE 'feishu_%'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM write_rate_buckets WHERE scope = 'github_oauth_start'").get().count, 1);

  assert.throws(() => db.prepare("INSERT INTO auth_identities (id, member_id, provider, provider_subject) VALUES ('blocked-identity', 'member-history', 'feishu', 'cli_old_app:tenant_old:ou_blocked_1234')").run(), /feishu integration retired/u);
  assert.throws(() => db.prepare("UPDATE auth_identities SET unlinked_at = NULL WHERE id = 'identity-history'").run(), /feishu integration retired/u);
  assert.throws(() => db.prepare("INSERT INTO oauth_sessions (token_hash, provider, provider_subject, email_snapshot, expires_at) VALUES ('blocked-session', 'feishu', 'cli_old_app:tenant_old:ou_blocked_1234', 'member@example.com', '2026-10-01T00:00:00.000Z')").run(), /feishu integration retired/u);
  assert.throws(() => db.prepare("UPDATE oauth_sessions SET revoked_at = NULL WHERE token_hash = 'session-history'").run(), /feishu integration retired/u);
  assert.throws(() => db.prepare("INSERT INTO oauth_transactions (state_hash, browser_nonce_hash, pkce_verifier, action, expires_at, provider) VALUES ('blocked-transaction', 'nonce', 'verifier', 'login', '2026-10-01T00:00:00.000Z', 'feishu')").run(), /feishu integration retired/u);
  assert.throws(() => db.prepare("UPDATE oauth_transactions SET consumed_at = NULL WHERE state_hash = 'transaction-history'").run(), /feishu integration retired/u);
  assert.throws(() => insertArchive.run("archive-blocked", "approval-history", "feishu_drive", "manifest-blocked", "content-blocked", "blocked.md", "pending", null, null, null), /feishu integration retired/u);
  assert.throws(() => db.prepare("UPDATE external_archives SET status = 'pending' WHERE id = 'archive-uploaded'").run(), /feishu integration retired/u);
  assert.throws(() => insertBucket.run("bucket-blocked", "actor", "feishu_oauth_start", oldTimestamp, oldTimestamp), /feishu integration retired/u);
  assert.throws(() => db.prepare("UPDATE write_rate_buckets SET scope = 'feishu_crosswalk' WHERE bucket_key = 'bucket-github'").run(), /feishu integration retired/u);

  assert.equal(db.prepare("INSERT INTO auth_identities (id, member_id, provider, provider_subject, unlinked_at) VALUES ('allowed-history', 'member-history', 'feishu', 'cli_old_app:tenant_old:ou_allowed_1234', ?)").run(oldTimestamp).changes, 1);
  db.close();
});

test("Feishu login restoration reopens OAuth and explicit identity binding only", () => {
  const restorationIndex = migrationFiles.indexOf("0025_restore_feishu_login.sql");
  assert.notEqual(restorationIndex, -1);
  const db = new DatabaseSync(":memory:");
  applyMigrationRange(db, 0, restorationIndex + 1);

  assert.equal(db.prepare("INSERT INTO auth_identities (id, member_id, provider, provider_subject) VALUES ('restored-identity', 'member-history', 'feishu', 'cli_old_app:tenant_old:ou_restored_1234')").run().changes, 1);
  assert.equal(db.prepare("INSERT INTO oauth_sessions (token_hash, provider, provider_subject, email_snapshot, expires_at) VALUES ('restored-session', 'feishu', 'cli_old_app:tenant_old:ou_restored_1234', 'feishu@example.invalid', '2026-10-01T00:00:00.000Z')").run().changes, 1);
  assert.equal(db.prepare("INSERT INTO oauth_transactions (state_hash, browser_nonce_hash, pkce_verifier, action, expires_at, provider) VALUES ('restored-transaction', 'nonce', 'verifier', 'login', '2026-10-01T00:00:00.000Z', 'feishu')").run().changes, 1);
  assert.equal(db.prepare("INSERT INTO write_rate_buckets (bucket_key, actor_subject, scope, window_started_at, used, updated_at) VALUES ('restored-oauth-bucket', 'actor', 'feishu_oauth_start', '2026-09-05T00:00:00.000Z', 1, '2026-09-05T00:00:00.000Z')").run().changes, 1);

  assert.throws(() => db.prepare("INSERT INTO external_archives (id, approval_id, destination, manifest_hash, content_hash, file_name, status) VALUES ('archive-still-blocked', 'approval-history', 'feishu_drive', 'manifest', 'content', 'blocked.md', 'pending')").run(), /feishu integration retired/u);
  assert.throws(() => db.prepare("INSERT INTO write_rate_buckets (bucket_key, actor_subject, scope, window_started_at, used, updated_at) VALUES ('crosswalk-still-blocked', 'actor', 'feishu_crosswalk', '2026-09-05T00:00:00.000Z', 1, '2026-09-05T00:00:00.000Z')").run(), /directory crosswalk retired/u);
  db.close();
});

test("retired provider migration refuses to modify state during an active migration freeze", () => {
  const retirementIndex = migrationFiles.indexOf("0024_retire_feishu.sql");
  const db = new DatabaseSync(":memory:");
  applyMigrationRange(db, 0, retirementIndex);
  db.prepare("INSERT INTO auth_identities (id, member_id, provider, provider_subject) VALUES ('identity-active', 'member-history', 'feishu', 'cli_old_app:tenant_old:ou_active_1234')").run();
  db.prepare("INSERT INTO migration_control (freeze_id) VALUES ('11111111-2222-4333-8444-555555555555')").run();
  const retirementSql = readFileSync(new URL("0024_retire_feishu.sql", migrationDirectory), "utf8");
  const firstStatement = retirementSql.split("--> statement-breakpoint")[0].trim();
  assert.throws(() => db.exec(firstStatement), /UNIQUE constraint failed/u);
  assert.equal(db.prepare("SELECT unlinked_at FROM auth_identities WHERE id = 'identity-active'").get().unlinked_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_feishu_retired_%'").get().count, 0);
  db.close();
});

test("retired provider migration refuses to race a pending remote upload", () => {
  const retirementIndex = migrationFiles.indexOf("0024_retire_feishu.sql");
  const db = new DatabaseSync(":memory:");
  applyMigrationRange(db, 0, retirementIndex);
  db.prepare("INSERT INTO external_archives (id, approval_id, destination, manifest_hash, content_hash, file_name, status, lease_token) VALUES ('archive-active', 'approval-history', 'feishu_drive', 'manifest', 'content', 'active.md', 'pending', 'live-lease')").run();
  const retirementStatements = readFileSync(new URL("0024_retire_feishu.sql", migrationDirectory), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  assert.doesNotThrow(() => db.exec(retirementStatements[0]));
  assert.throws(() => db.exec(retirementStatements[1]), /UNIQUE constraint failed/u);
  assert.equal(db.prepare("SELECT status FROM external_archives WHERE id = 'archive-active'").get().status, "pending");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_feishu_retired_%'").get().count, 0);
  db.close();
});

test("email-subject migration leaves ambiguous or malformed legacy accounts unbound", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrationRange(db, 0, 7);
  const insert = db.prepare(`
    INSERT INTO members (
      id, full_name, identity_number, school_email, chatgpt_account,
      role, permissions_json, status, created_at, last_seen_at
    ) VALUES (?, ?, ?, '', ?, 'member', '[]', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  insert.run("case-a", "A", "CASE-A", "Case@Example.com");
  insert.run("case-b", "B", "CASE-B", "case@example.com");
  insert.run("malformed", "C", "CASE-C", "invalid account");

  applyMigrationRange(db, 7, migrationFiles.length);

  assert.equal(db.prepare("SELECT count(*) AS count FROM members WHERE account_user_id IS NULL").get().count, 3);
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM member_events WHERE action = 'migration_supported_email_subject'").get().count,
    0,
  );
  db.close();
});
