import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

import {
  buildMigrationPayload,
  canonicalJson,
  MIGRATION_EXPORT_EXPECTED_MIGRATIONS,
  MIGRATION_EXPORT_TABLES,
  migrationExportSelectSql,
  migrationLedgerSelectSql,
  migrationSchemaFingerprint,
  migrationSchemaSelectSql,
} from "../lib/migration-export.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const migrationDirectory = new URL("../drizzle/", import.meta.url);
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .sort();
const authKey = Buffer.alloc(32, 0x5a).toString("base64url");
const freezeId = "11111111-2222-4333-8444-555555555555";

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  server: { middlewareMode: true, hmr: false },
});
const migrationWorker = (await vite.ssrLoadModule("/scripts/migration-import-worker.ts")).default;
const { buildApprovalRevision } = await vite.ssrLoadModule("/lib/approval-revisions.ts");
const { chunkKnowledgeSubmission, hashKnowledgeSubmission } = await vite.ssrLoadModule("/lib/knowledge-policy.ts");

after(async () => vite.close());

function plainRows(rows) {
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
}

function createApplicationDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const name of migrationFiles) {
    const sql = readFileSync(new URL(name, migrationDirectory), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) database.exec(statement);
  }
  database.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL)");
  const insertMigration = database.prepare("INSERT INTO d1_migrations (id, name) VALUES (?, ?)");
  MIGRATION_EXPORT_EXPECTED_MIGRATIONS.forEach((name, index) => insertMigration.run(index + 1, name));
  return database;
}

function seedSource(database, displayName = "迁移管理员") {
  const timestamp = new Date().toISOString();
  database.prepare(`
    INSERT INTO members (
      id, full_name, identity_number, school_email, chatgpt_account,
      account_user_id, role, permissions_json, department_code, status,
      mutation_revision, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'member', '[]', '', 'active', ?, ?, ?)
  `).run(
    "member-admin",
    displayName,
    "OM-ADMIN",
    "admin@school.example",
    "admin@example.com",
    "email:admin@example.com",
    "0123456789abcdef0123456789abcdef",
    timestamp,
    timestamp,
  );
  database.prepare(`
    INSERT INTO auth_identities (
      id, member_id, provider, provider_subject, login_snapshot,
      verified_email_snapshot, linked_at, last_seen_at, unlinked_at
    ) VALUES (?, ?, 'github', ?, ?, ?, ?, ?, NULL)
  `).run(
    "identity-admin",
    "member-admin",
    "583231",
    "admin-login",
    "admin@example.com",
    timestamp,
    timestamp,
  );
}

async function seedRevisionChains(database) {
  const approvalSpec = MIGRATION_EXPORT_TABLES.find((table) => table.name === "approvals");
  const revisionSpec = MIGRATION_EXPORT_TABLES.find((table) => table.name === "approval_revisions");
  const insert = (spec, values) => database.prepare(`INSERT INTO ${spec.name} (${spec.columns.join(", ")}) VALUES (${spec.columns.map(() => "?").join(", ")})`).run(...spec.columns.map((column) => values[column]));
  for (let index = 0; index < 23; index += 1) {
    const approval = Object.fromEntries(approvalSpec.columns.map((column) => [column, ""]));
    Object.assign(approval, { id: `approval-${String(index).padStart(2, "0")}`, type: "技术审核", title: "迁移验证", requester_email: "admin@example.com", client_creation_key: null, business_key: null, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z", status: "已归档", amount: null, period_key: null, signers_json: "[]", payload_json: "{}", current_revision_no: 0, current_revision_hash: null });
    for (let depth = 1; depth <= index % 4 + 1; depth += 1) {
      const projection = Object.fromEntries(Object.entries(approval).map(([column, value]) => [column.replace(/_([a-z])/gu, (_, char) => char.toUpperCase()), value]));
      const mutationRevision = `mutation-${index}-${depth}`;
      const revision = await buildApprovalRevision({ nextApproval: projection, revisionNo: depth, previousRevisionHash: approval.current_revision_hash, mutation: { workflowMutationRevision: mutationRevision }, event: { action: "created" } });
      insert(revisionSpec, { revision_hash: revision.revisionHash, approval_id: approval.id, revision_no: depth, previous_revision_hash: revision.previousRevisionHash, mutation_revision: mutationRevision, state_json: revision.stateJson, state_hash: revision.stateHash, event_json: revision.eventJson, created_at: approval.created_at });
      approval.current_revision_no = depth;
      approval.current_revision_hash = revision.revisionHash;
    }
    insert(approvalSpec, approval);
  }
}

async function seedMultipartKnowledge(database) {
  const createdAt = "2026-09-13T00:00:00.000Z";
  const reviewedAt = "2026-09-13T01:00:00.000Z";
  const submission = {
    title: "大型迁移文档",
    category: "产品资料",
    summary: "验证迁移导入保持分片正文",
    sourceLabel: "large.md",
    sourceUrl: "",
    content: `${"甲".repeat(20_000)}乙丙丁戊己庚辛壬癸`,
  };
  const contentHash = await hashKnowledgeSubmission(submission);
  database.prepare(`
    INSERT INTO members (
      id, full_name, identity_number, school_email, chatgpt_account,
      account_user_id, role, permissions_json, department_code, status,
      mutation_revision, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'member', '[]', '', 'active', ?, ?, ?)
  `).run(
    "member-review",
    "迁移审核人",
    "OM-REVIEW",
    "review@school.example",
    "review@example.com",
    "email:review@example.com",
    "fedcba9876543210fedcba9876543210",
    createdAt,
    createdAt,
  );
  database.prepare(`
    INSERT INTO knowledge_items (
      id, project, title, category, submitter_member_id, submitter_name, submitter_email,
      status, visibility, current_revision_no, current_revision_id, active_revision_id,
      mutation_revision, created_at, updated_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'internal', 1, ?, NULL, ?, ?, ?, NULL)
  `).run(
    "knowledge-large",
    "OriginMind × ARTS Robotics 联合研发项目",
    submission.title,
    submission.category,
    "member-admin",
    "迁移管理员",
    "admin@example.com",
    "knowledge-revision-large",
    "mutation-large",
    createdAt,
    createdAt,
  );
  database.prepare(`
    INSERT INTO knowledge_revisions (
      id, item_id, revision_no, previous_revision_id, title, category, content, summary,
      source_label, source_url, content_hash, status, created_by_member_id,
      created_by_name, created_by_email, review_note, created_at
    ) VALUES (?, ?, 1, NULL, ?, ?, '', ?, ?, ?, ?, 'pending', ?, ?, ?, '', ?)
  `).run(
    "knowledge-revision-large",
    "knowledge-large",
    submission.title,
    submission.category,
    submission.summary,
    submission.sourceLabel,
    submission.sourceUrl,
    contentHash,
    "member-admin",
    "迁移管理员",
    "admin@example.com",
    createdAt,
  );
  const insertPart = database.prepare(`
    INSERT INTO knowledge_revision_parts (id, item_id, revision_id, part_no, content, created_at)
    VALUES (?, 'knowledge-large', 'knowledge-revision-large', ?, ?, ?)
  `);
  insertPart.run("knowledge-part-1", 1, submission.content.slice(0, 20_000), createdAt);
  insertPart.run("knowledge-part-2", 2, submission.content.slice(20_000), createdAt);
  database.prepare(`
    UPDATE knowledge_revisions
    SET status = 'active', reviewed_by_member_id = 'member-review', reviewed_by_name = '迁移审核人',
        reviewed_by_email = 'review@example.com', reviewed_at = ?, activated_at = ?
    WHERE id = 'knowledge-revision-large'
  `).run(reviewedAt, reviewedAt);
  database.prepare(`
    UPDATE knowledge_items
    SET status = 'active', active_revision_id = 'knowledge-revision-large', updated_at = ?
    WHERE id = 'knowledge-large'
  `).run(reviewedAt);
  const insertChunk = database.prepare(`
    INSERT INTO knowledge_chunks (
      id, item_id, revision_id, chunk_no, section_title, paragraph_ref,
      content, search_text, is_active, created_at
    ) VALUES (?, 'knowledge-large', 'knowledge-revision-large', ?, ?, ?, ?, ?, 1, ?)
  `);
  for (const chunk of chunkKnowledgeSubmission(submission)) {
    insertChunk.run(
      `knowledge-chunk-${chunk.chunkNo}`,
      chunk.chunkNo,
      chunk.sectionTitle,
      chunk.paragraphRef,
      chunk.content,
      chunk.searchText,
      reviewedAt,
    );
  }
  database.prepare(`
    INSERT INTO knowledge_events (
      id, item_id, revision_id, actor_member_id, actor_name, actor_email, action, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'submitted', '', ?)
  `).run(
    "knowledge-event-large",
    "knowledge-large",
    "knowledge-revision-large",
    "member-admin",
    "迁移管理员",
    "admin@example.com",
    createdAt,
  );
  database.prepare(`
    INSERT INTO knowledge_events (
      id, item_id, revision_id, actor_member_id, actor_name, actor_email, action, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'approved_internal', '', ?)
  `).run(
    "knowledge-event-approved",
    "knowledge-large",
    "knowledge-revision-large",
    "member-review",
    "迁移审核人",
    "review@example.com",
    reviewedAt,
  );
}

async function makePayload({ displayName, duplicateProviderSubject = false, revisionChains = false, multipartKnowledge = false } = {}) {
  const source = createApplicationDatabase();
  try {
    seedSource(source, displayName);
    if (revisionChains) await seedRevisionChains(source);
    if (multipartKnowledge) await seedMultipartKnowledge(source);
    const ledger = { success: true, results: plainRows(source.prepare(migrationLedgerSelectSql()).all()) };
    const schema = { success: true, results: plainRows(source.prepare(migrationSchemaSelectSql()).all()) };
    const tableResults = MIGRATION_EXPORT_TABLES.map((table) => ({
      success: true,
      results: plainRows(source.prepare(migrationExportSelectSql(table)).all()),
    }));
    if (duplicateProviderSubject) {
      const identityIndex = MIGRATION_EXPORT_TABLES.findIndex((table) => table.name === "auth_identities");
      tableResults[identityIndex].results.push({ ...tableResults[identityIndex].results[0], id: "identity-conflict" });
    }
    const now = Date.now();
    const expectedSchemaSha256 = await migrationSchemaFingerprint(schema);
    return buildMigrationPayload({
      sourceOrigin: "https://oa.example.test",
      authKey,
      freezeId,
      writeFrozenAt: new Date(now - 20 * 60 * 1000).toISOString(),
      notBefore: new Date(now - 5 * 60 * 1000).toISOString(),
      notAfter: new Date(now + 30 * 60 * 1000).toISOString(),
      expectedSchemaSha256,
      exportedAt: new Date(now).toISOString(),
      batchResults: [
        ledger,
        schema,
        { success: true, results: [{ write_frozen_at: new Date(now - 20 * 60 * 1000).toISOString(), ready: 1 }] },
        { success: true, results: [{ active_count: 0 }] },
        ...tableResults,
      ],
    });
  } finally {
    source.close();
  }
}

class PreparedStatement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new PreparedStatement(this.database, this.sql, bindings);
  }
}

class TransactionalD1 {
  constructor(database, failBeforeCalls = []) {
    this.database = database;
    this.failBeforeCalls = new Set(failBeforeCalls);
    this.batchCalls = 0;
    this.queryCount = 0;
  }

  prepare(sql) {
    return new PreparedStatement(this.database, sql);
  }

  async batch(statements) {
    this.queryCount += statements.length;
    assert.ok(this.queryCount <= 50, "D1 Free-plan query limit");
    for (const statement of statements) assert.ok(statement.bindings.length <= 100, "D1 binding limit");
    this.batchCalls += 1;
    if (this.failBeforeCalls.delete(this.batchCalls)) throw new Error("simulated D1 transport failure");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((entry) => {
        const statement = this.database.prepare(entry.sql);
        if (/^\s*(?:SELECT|PRAGMA)\b/iu.test(entry.sql)) {
          return { success: true, results: plainRows(statement.all(...entry.bindings)), meta: { changes: 0 } };
        }
        const metadata = statement.run(...entry.bindings);
        return { success: true, results: [], meta: { changes: Number(metadata.changes) } };
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function environment(d1, payload) {
  return {
    DB: d1,
    MIGRATION_IMPORT_TOKEN: Buffer.alloc(32, 0x33).toString("base64url"),
    MIGRATION_IMPORT_AUTH_KEY: authKey,
    MIGRATION_IMPORT_ADMIN_EMAILS: "admin@example.com",
    MIGRATION_IMPORT_EXPECTED_ORIGIN: "https://oa.example.test",
    MIGRATION_IMPORT_EXPECTED_SCHEMA_SHA256: payload.schemaSha256,
    MIGRATION_IMPORT_EXPECTED_FREEZE_ID: freezeId,
    MIGRATION_IMPORT_READY_PROOF: Buffer.alloc(32, 0x44).toString("base64url"),
  };
}

async function importRequest(d1, payload) {
  d1.queryCount = 0;
  const serialized = canonicalJson(payload);
  return migrationWorker.fetch(new Request("http://127.0.0.1/import", {
    method: "POST",
    headers: {
      authorization: `Bearer ${Buffer.alloc(32, 0x33).toString("base64url")}`,
      "content-length": String(Buffer.byteLength(serialized)),
      "content-type": "application/json",
    },
    body: serialized,
  }), environment(d1, payload));
}

function targetCounts(database) {
  return {
    identities: database.prepare("SELECT COUNT(*) AS count FROM auth_identities").get().count,
    members: database.prepare("SELECT COUNT(*) AS count FROM members").get().count,
    guards: database.prepare("SELECT COUNT(*) AS count FROM write_rate_buckets").get().count,
  };
}

test("importer readiness rejects missing, invalid, or duplicate administrator lists without database access", async () => {
  const payload = await makePayload();
  const target = createApplicationDatabase();
  try {
    const d1 = new TransactionalD1(target);
    for (const administratorEmails of [undefined, "", "not-an-email", "admin@example.com,ADMIN@example.com"]) {
      const env = environment(d1, payload);
      if (administratorEmails === undefined) delete env.MIGRATION_IMPORT_ADMIN_EMAILS;
      else env.MIGRATION_IMPORT_ADMIN_EMAILS = administratorEmails;
      const response = await migrationWorker.fetch(new Request("http://127.0.0.1/ready"), env);
      assert.equal(response.status, 503);
      assert.equal(d1.queryCount, 0);
    }
  } finally {
    target.close();
  }
});

test("local importer commits, verifies, cleans its guard, and makes same-package replay read-only", async () => {
  const payload = await makePayload();
  const target = createApplicationDatabase();
  try {
    const d1 = new TransactionalD1(target);
    let response = await importRequest(d1, payload);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, "imported_verified");
    assert.deepEqual(targetCounts(target), { identities: 1, members: 1, guards: 0 });

    response = await importRequest(d1, payload);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, "already_imported_verified");
    assert.deepEqual(targetCounts(target), { identities: 1, members: 1, guards: 0 });

    const differentPayload = await makePayload({ displayName: "另一个管理员" });
    response = await importRequest(d1, differentPayload);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).state, "target_conflict");
    assert.deepEqual(targetCounts(target), { identities: 1, members: 1, guards: 0 });
  } finally {
    target.close();
  }
});

test("local importer atomically restores multipart knowledge revisions", async () => {
  const payload = await makePayload({ multipartKnowledge: true });
  const target = createApplicationDatabase();
  try {
    const d1 = new TransactionalD1(target);
    const response = await importRequest(d1, payload);
    const receipt = await response.json();
    assert.equal(response.status, 200, JSON.stringify(receipt));
    assert.equal(receipt.state, "imported_verified");
    assert.deepEqual(
      target.prepare(`
        SELECT part_no, content
        FROM knowledge_revision_parts
        WHERE revision_id = 'knowledge-revision-large'
        ORDER BY part_no
      `).all().map((part) => [part.part_no, part.content.length]),
      [[1, 20_000], [2, 9]],
    );
    const restoredRevision = target.prepare("SELECT content, status FROM knowledge_revisions WHERE id = 'knowledge-revision-large'").get();
    assert.equal(restoredRevision.content, "");
    assert.equal(restoredRevision.status, "active");
    assert.ok(target.prepare("SELECT COUNT(*) AS count FROM knowledge_chunks WHERE revision_id = 'knowledge-revision-large' AND is_active = 1").get().count > 1);
    assert.ok(d1.queryCount <= 50);
  } finally {
    target.close();
  }
});

test("a conflict in the final insert rolls back every business row and the import guard", async () => {
  const payload = await makePayload({ duplicateProviderSubject: true });
  const target = createApplicationDatabase();
  try {
    const d1 = new TransactionalD1(target);
    const response = await importRequest(d1, payload);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).state, "commit_status_unknown");
    assert.deepEqual(targetCounts(target), { identities: 0, members: 0, guards: 0 });
  } finally {
    target.close();
  }
});

test("batched revision chains import under D1 limits with real chain triggers and exact hashes", async () => {
  const payload = await makePayload({ revisionChains: true });
  const target = createApplicationDatabase();
  try {
    const d1 = new TransactionalD1(target);
    const response = await importRequest(d1, payload);
    const receipt = await response.json();
    assert.equal(response.status, 200, JSON.stringify(receipt));
    assert.equal(receipt.state, "imported_verified");
    assert.equal(target.prepare("SELECT COUNT(*) AS count FROM approvals").get().count, 23);
    assert.equal(target.prepare("SELECT COUNT(*) AS count FROM approval_revisions").get().count, 56);
    assert.ok(d1.queryCount <= 50);
    assert.equal(targetCounts(target).guards, 0);
  } finally {
    target.close();
  }
});

test("a lost post-commit verification response recovers by exact read-only comparison", async () => {
  const payload = await makePayload();
  const target = createApplicationDatabase();
  try {
    const d1 = new TransactionalD1(target, [3]);
    let response = await importRequest(d1, payload);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).state, "committed_unverified");
    assert.deepEqual(targetCounts(target), { identities: 1, members: 1, guards: 1 });

    response = await importRequest(d1, payload);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, "recovered_import_verified");
    assert.deepEqual(targetCounts(target), { identities: 1, members: 1, guards: 0 });
  } finally {
    target.close();
  }
});

test("guard cleanup transport failure is classified as committed and recoverable", async () => {
  const payload = await makePayload();
  const target = createApplicationDatabase();
  try {
    const d1 = new TransactionalD1(target, [4]);
    let response = await importRequest(d1, payload);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).state, "committed_verified_cleanup_pending");
    assert.deepEqual(targetCounts(target), { identities: 1, members: 1, guards: 1 });

    response = await importRequest(d1, payload);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, "recovered_import_verified");
    assert.deepEqual(targetCounts(target), { identities: 1, members: 1, guards: 0 });
  } finally {
    target.close();
  }
});
