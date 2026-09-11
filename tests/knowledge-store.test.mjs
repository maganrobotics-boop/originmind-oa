import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaKnowledgeStoreTestState";

class D1StatementAdapter {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new D1StatementAdapter(this.database, this.sql, bindings);
  }

  execute() {
    const statement = this.database.prepare(this.sql);
    const results = statement.all(...this.bindings);
    return { success: true, results };
  }

  async all() {
    return this.execute();
  }

  async first() {
    return this.execute().results[0] ?? null;
  }
}

class D1DatabaseAdapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementAdapter(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

globalThis[stateKey] = { database: null };

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "knowledge-store-test-db",
    enforce: "pre",
    resolveId(source) {
      if (/^(?:\.\.\/)+db$/u.test(source)) return "\0knowledge-store-test-db";
      return null;
    },
    load(id) {
      if (id === "\0knowledge-store-test-db") return `
        export async function getD1Database() {
          return globalThis.${stateKey}.database;
        }
      `;
      return null;
    },
  }],
});

const policy = await vite.ssrLoadModule("/lib/knowledge-policy.ts");
const store = await vite.ssrLoadModule("/lib/knowledge-store.ts");
const [migration, hardeningMigration] = await Promise.all([
  readFile(new URL("../drizzle/0026_rich_jocasta.sql", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0027_careless_winter_soldier.sql", import.meta.url), "utf8"),
]);

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE migration_control (freeze_id TEXT PRIMARY KEY, activated_at TEXT, deactivated_at TEXT);
    CREATE TABLE members (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      account_user_id TEXT,
      mutation_revision TEXT NOT NULL,
      nda_accepted_at TEXT,
      nda_agreement_version TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      permissions_json TEXT NOT NULL DEFAULT '[]'
    );
  `);
  database.exec(migration);
  database.exec(hardeningMigration);
  for (const member of [
    ["member-submit", "account-submit", "member-revision-submit", "member"],
    ["member-review", "account-review", "member-revision-review", "project_owner"],
    ["member-reader", "account-reader", "member-revision-reader", "member"],
  ]) {
    database.prepare("INSERT INTO members (id, status, account_user_id, mutation_revision, nda_accepted_at, nda_agreement_version, role) VALUES (?, 'active', ?, ?, '2026-09-01T00:00:00.000Z', 'NDA-2026-09', ?)").run(...member);
  }
  return database;
}

function actor(kind) {
  return kind === "submitter" ? {
    memberId: "member-submit",
    accountUserId: "account-submit",
    memberMutationRevision: "member-revision-submit",
    name: "投稿成员",
    email: "submit@example.com",
    isAdmin: false,
  } : {
    memberId: "member-review",
    accountUserId: "account-review",
    memberMutationRevision: "member-revision-review",
    name: "项目管理员",
    email: "review@example.com",
    isAdmin: false,
  };
}

function submission(overrides = {}) {
  return {
    title: "机械臂急停复位",
    category: "安全规范",
    summary: "急停复位前先确认安全区。",
    sourceLabel: "安全手册",
    sourceUrl: "https://example.com/safety",
    content: "机械臂急停后，必须先确认安全区无人。\n\n由值班人员解除故障并执行复位。",
    ...overrides,
  };
}

beforeEach(() => {
  globalThis[stateKey].sqlite?.close();
  const sqlite = createDatabase();
  globalThis[stateKey].sqlite = sqlite;
  globalThis[stateKey].database = new D1DatabaseAdapter(sqlite);
});

after(async () => {
  globalThis[stateKey].database?.database.close();
  delete globalThis[stateKey];
  await vite.close();
});

test("投稿、审核、检索和下架形成完整且有审计的知识生命周期", async () => {
  const draft = submission();
  const contentHash = await policy.hashKnowledgeSubmission(draft);
  const created = await store.createKnowledgeItem(actor("submitter"), draft, contentHash);
  assert.equal(created.status, "pending");
  assert.equal(created.currentRevisionNo, 1);
  assert.equal(created.activeRevisionId, undefined);

  const list = await store.listKnowledgeItems("mine", actor("submitter"), false);
  assert.equal(list.length, 1);
  assert.equal(list[0].summary, draft.summary);
  assert.equal("content" in list[0], false, "列表不能披露整篇正文");

  const reviewList = await store.listKnowledgeItems("review", actor("reviewer"), true);
  assert.equal(reviewList.length, 1);
  assert.equal(reviewList[0].canReview, true);
  assert.equal(await store.countPendingKnowledgeItems(actor("reviewer")), 1);
  globalThis[stateKey].sqlite.prepare("UPDATE members SET role = 'project_owner' WHERE id = 'member-submit'").run();
  const selfReviewer = { ...actor("submitter"), configuredReviewer: true };
  assert.deepEqual(await store.listKnowledgeItems("review", selfReviewer, true), []);
  assert.equal(await store.countPendingKnowledgeItems(selfReviewer), 0);
  globalThis[stateKey].sqlite.prepare("UPDATE members SET role = 'member' WHERE id = 'member-submit'").run();

  const existing = await store.findKnowledgeItem(created.id, actor("submitter"));
  assert.equal(await store.reviewKnowledgeItem(existing, actor("submitter"), "approve", ""), null, "投稿人不能自审");

  const approved = await store.reviewKnowledgeItem(existing, actor("reviewer"), "approve", "符合实验室规范");
  assert.equal(approved.status, "active");
  assert.equal(approved.activeRevisionId, approved.currentRevisionId);
  assert.equal(approved.reviewedByMemberId, "member-review");
  const managed = await store.listKnowledgeItems("all", actor("reviewer"), true);
  assert.equal(managed[0].canRevoke, true);

  const chunks = await store.getActiveKnowledgeChunks(actor("submitter"));
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.every((chunk) => chunk.itemId === created.id));
  assert.equal(chunks[0].sourceLabel, "安全手册");

  const reader = {
    memberId: "member-reader",
    accountUserId: "account-reader",
    memberMutationRevision: "member-revision-reader",
    name: "阅读成员",
    email: "reader@example.com",
    isAdmin: false,
  };
  const publicList = await store.listKnowledgeItems("all", reader, false);
  assert.equal(publicList.length, 1);
  assert.equal(publicList[0].title, draft.title);
  assert.equal("submitterEmail" in publicList[0], false);
  assert.equal("reviewedByEmail" in publicList[0], false);
  assert.equal("mutationRevision" in publicList[0], false);

  const publicDetail = await store.getKnowledgeItemDetail(created.id, reader, false);
  assert.equal(publicDetail.revisions[0].content, draft.content);
  assert.equal("contentHash" in publicDetail.revisions[0], false);
  assert.equal("submitterMemberId" in publicDetail.item, false);

  globalThis[stateKey].sqlite.prepare("UPDATE members SET status = 'departed' WHERE id = 'member-reader'").run();
  assert.deepEqual(await store.listKnowledgeItems("all", reader, false), []);
  assert.equal(await store.getKnowledgeItemDetail(created.id, reader, false), null);
  assert.deepEqual(await store.getActiveKnowledgeChunks(reader), []);

  assert.equal(await store.reviewKnowledgeItem(existing, actor("reviewer"), "approve", "重复审核"), null, "旧 mutation revision 不能重复审核");
  const active = await store.findKnowledgeItem(created.id, actor("submitter"));
  const revoked = await store.reviewKnowledgeItem(active, actor("reviewer"), "revoke", "规范已废止");
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.activeRevisionId, undefined);
  assert.deepEqual(await store.getActiveKnowledgeChunks(actor("submitter")), []);

  const events = globalThis[stateKey].sqlite.prepare("SELECT action FROM knowledge_events ORDER BY created_at, rowid").all().map((row) => row.action);
  assert.deepEqual(events, ["submitted", "approved", "revoked"]);
});

test("退回后只能由投稿人创建不可变的新版本并再次进入待审核", async () => {
  const first = submission();
  const created = await store.createKnowledgeItem(actor("submitter"), first, await policy.hashKnowledgeSubmission(first));
  const pending = await store.findKnowledgeItem(created.id, actor("submitter"));
  const returned = await store.reviewKnowledgeItem(pending, actor("reviewer"), "return", "请补充责任人");
  assert.equal(returned.status, "returned");

  const returnedRow = await store.findKnowledgeItem(created.id, actor("submitter"));
  const second = submission({ content: `${first.content}\n\n责任人：当日值班工程师。` });
  const resubmitted = await store.resubmitKnowledgeItem(returnedRow, actor("submitter"), second, await policy.hashKnowledgeSubmission(second));
  assert.equal(resubmitted.status, "pending");
  assert.equal(resubmitted.currentRevisionNo, 2);

  const revisions = globalThis[stateKey].sqlite.prepare("SELECT revision_no, status, previous_revision_id FROM knowledge_revisions ORDER BY revision_no").all();
  assert.deepEqual(revisions.map((row) => row.status), ["returned", "pending"]);
  assert.equal(revisions[1].previous_revision_id, created.currentRevisionId);
  const events = globalThis[stateKey].sqlite.prepare("SELECT action FROM knowledge_events ORDER BY created_at, rowid").all().map((row) => row.action);
  assert.deepEqual(events, ["submitted", "returned", "resubmitted"]);
});

test("SQL-time 成员快照失效会原子拒绝投稿", async () => {
  const staleActor = { ...actor("submitter"), memberMutationRevision: "stale-member-revision" };
  const draft = submission();
  assert.equal(await store.createKnowledgeItem(staleActor, draft, await policy.hashKnowledgeSubmission(draft)), null);
  assert.equal(globalThis[stateKey].sqlite.prepare("SELECT COUNT(*) AS total FROM knowledge_items").get().total, 0);
  assert.equal(globalThis[stateKey].sqlite.prepare("SELECT COUNT(*) AS total FROM knowledge_revisions").get().total, 0);
  assert.equal(globalThis[stateKey].sqlite.prepare("SELECT COUNT(*) AS total FROM knowledge_events").get().total, 0);
});

test("审核写入在 SQL 时间复核项目负责人角色，配置型负责人和 OA 管理员显式例外", async () => {
  const draft = submission();
  const created = await store.createKnowledgeItem(actor("submitter"), draft, await policy.hashKnowledgeSubmission(draft));
  const pending = await store.findKnowledgeItem(created.id, actor("submitter"));
  globalThis[stateKey].sqlite.prepare("UPDATE members SET role = 'member' WHERE id = 'member-review'").run();

  assert.equal(await store.reviewKnowledgeItem(pending, actor("reviewer"), "approve", "审核通过"), null);
  const configuredOwner = { ...actor("reviewer"), configuredReviewer: true };
  const approved = await store.reviewKnowledgeItem(pending, configuredOwner, "approve", "审核通过");
  assert.equal(approved.status, "active");

  const adminDraft = submission({ title: "OA 管理员审核样例" });
  const adminItem = await store.createKnowledgeItem(actor("submitter"), adminDraft, await policy.hashKnowledgeSubmission(adminDraft));
  const adminReviewer = { ...actor("reviewer"), isAdmin: true };
  assert.equal((await store.listKnowledgeItems("review", adminReviewer, true)).length, 1);
  assert.equal(await store.countPendingKnowledgeItems(adminReviewer), 1);
  const adminPending = await store.findKnowledgeItem(adminItem.id, actor("submitter"));
  const adminApproved = await store.reviewKnowledgeItem(adminPending, adminReviewer, "approve", "管理员审核通过");
  assert.equal(adminApproved.status, "active");
});
