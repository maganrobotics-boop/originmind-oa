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
const chatImport = await vite.ssrLoadModule("/lib/chat-knowledge-import.ts");
const [migration, hardeningMigration, visibilityMigration, reclassificationMigration] = await Promise.all([
  readFile(new URL("../drizzle/0026_rich_jocasta.sql", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0027_careless_winter_soldier.sql", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0028_needy_microchip.sql", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0029_knowledge_visibility_reclassification.sql", import.meta.url), "utf8"),
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
  database.exec(visibilityMigration);
  database.exec(reclassificationMigration);
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

test("Chat imports enter review exactly once and cannot enter either retrieval index before approval", async () => {
  const draft = submission();
  const submitter = actor("submitter");
  const identity = await chatImport.chatImportIdentity(submitter.accountUserId, "11111111-2222-4333-8444-555555555555", draft, 0);
  const imported = await Promise.all([1, 2].map(() => store.createChatImportedKnowledgeItem(submitter, draft, identity.contentHash, identity.itemId)));
  assert.equal(imported[0].id, imported[1].id);
  assert.equal(imported[0].status, "pending");
  assert.equal(imported[0].visibility, "internal");
  const db = globalThis[stateKey].sqlite;
  for (const table of ["knowledge_items", "knowledge_revisions", "knowledge_events"]) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1);
  assert.equal((await store.listKnowledgeItems("review", actor("reviewer"), true)).length, 1);
  assert.deepEqual(await store.getActiveKnowledgeChunks(submitter), []);
  assert.deepEqual(await store.getPublicActiveKnowledgeChunks(), []);
  const existing = await store.findKnowledgeItem(identity.itemId, actor("reviewer"));
  await store.reviewKnowledgeItem(existing, actor("reviewer"), "approve", "审核测试", "internal");
  assert.ok((await store.getActiveKnowledgeChunks(submitter)).length);
  assert.deepEqual(await store.getPublicActiveKnowledgeChunks(), []);
  const retry = await store.createChatImportedKnowledgeItem(submitter, draft, identity.contentHash, identity.itemId);
  assert.equal(retry.status, "active");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_events").get().n, 2);
  db.prepare("UPDATE members SET status='departed' WHERE id=?").run(submitter.memberId);
  assert.equal(await store.createChatImportedKnowledgeItem(submitter, draft, identity.contentHash, identity.itemId), null);
});

test("Chat import splits long drafts without losing Unicode and rejects injected approval or identity fields", async () => {
  const document = { id: "11111111-2222-4333-8444-555555555555", title: "导入资料", body: "机器人技术。".repeat(4_000), url: "", category: "research", updatedAt: "2026-09-12" };
  const parsed = chatImport.parseChatKnowledgeImport({ document });
  assert.equal(parsed.submissions.length, 2);
  assert.equal(parsed.submissions.map((part) => part.content).join(""), document.body);
  for (const length of [18001, 20000, 20001, 29999]) {
    const content = "a".repeat(length - 2) + "😀";
    const result = chatImport.parseChatKnowledgeImport({ document: { ...document, body: content } });
    assert.equal(result.submissions.map((part) => part.content).join(""), content);
    assert.ok(result.submissions.every((part) => part.content.length >= 10 && part.content.length <= 20_000));
  }
  assert.throws(() => chatImport.parseChatKnowledgeImport({ document: { ...document, visibility: "public" } }));
  assert.throws(() => chatImport.parseChatKnowledgeImport({ document, submitterEmail: "other@example.com" }));
  assert.throws(() => chatImport.parseChatKnowledgeImport({ document: { ...document, updatedAt: "2026-02-30" } }));
  const otherIdentity = await chatImport.chatImportIdentity("other-account", document.id, parsed.submissions[0], 0);
  const identity = await chatImport.chatImportIdentity("one-account", document.id, parsed.submissions[0], 0);
  assert.notEqual(identity.itemId, otherIdentity.itemId);
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
  assert.equal(created.visibility, "internal");
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
  assert.equal(await store.reviewKnowledgeItem(existing, actor("submitter"), "approve", "", "internal"), null, "投稿人不能自审");

  const approved = await store.reviewKnowledgeItem(existing, actor("reviewer"), "approve", "符合实验室规范", "internal");
  assert.equal(approved.status, "active");
  assert.equal(approved.visibility, "internal");
  assert.equal(approved.activeRevisionId, approved.currentRevisionId);
  assert.equal(approved.reviewedByMemberId, "member-review");
  const managed = await store.listKnowledgeItems("all", actor("reviewer"), true);
  assert.equal(managed[0].canRevoke, true);

  const chunks = await store.getActiveKnowledgeChunks(actor("submitter"));
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.every((chunk) => chunk.itemId === created.id));
  assert.equal(chunks[0].sourceLabel, "安全手册");
  assert.deepEqual(await store.getPublicActiveKnowledgeChunks(), []);

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

  for (const partialIdentity of [
    { ...actor("submitter"), email: "other@example.com" },
    { ...reader, email: "submit@example.com" },
  ]) {
    const partialDetail = await store.getKnowledgeItemDetail(created.id, partialIdentity, false);
    assert.equal("submitterMemberId" in partialDetail.item, false);
    assert.deepEqual(partialDetail.events, []);
  }

  globalThis[stateKey].sqlite.prepare("UPDATE members SET status = 'departed' WHERE id = 'member-reader'").run();
  assert.deepEqual(await store.listKnowledgeItems("all", reader, false), []);
  assert.equal(await store.getKnowledgeItemDetail(created.id, reader, false), null);
  assert.deepEqual(await store.getActiveKnowledgeChunks(reader), []);

  assert.equal(await store.reviewKnowledgeItem(existing, actor("reviewer"), "approve", "重复审核", "internal"), null, "旧 mutation revision 不能重复审核");
  const active = await store.findKnowledgeItem(created.id, actor("submitter"));
  const revoked = await store.reviewKnowledgeItem(active, actor("reviewer"), "revoke", "规范已废止");
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.activeRevisionId, undefined);
  assert.deepEqual(await store.getActiveKnowledgeChunks(actor("submitter")), []);

  const events = globalThis[stateKey].sqlite.prepare("SELECT action FROM knowledge_events ORDER BY created_at, rowid").all().map((row) => row.action);
  assert.deepEqual(events, ["submitted", "approved_internal", "revoked"]);
});

test("系统管理员可以批准并调整自己的知识，但不能自行退回、拒绝或撤销", async () => {
  const draft = submission({ title: "系统管理员本人投稿样例" });
  const created = await store.createKnowledgeItem(actor("submitter"), draft, await policy.hashKnowledgeSubmission(draft));
  const pending = await store.findKnowledgeItem(created.id, actor("submitter"));
  const projectOwnerSelf = { ...actor("submitter"), configuredReviewer: true };

  assert.deepEqual(await store.listKnowledgeItems("review", projectOwnerSelf, true), []);
  assert.equal(await store.countPendingKnowledgeItems(projectOwnerSelf), 0);
  assert.equal(await store.reviewKnowledgeItem(pending, projectOwnerSelf, "approve", "", "internal"), null);

  const adminSelf = { ...actor("submitter"), isAdmin: true };
  const reviewQueue = await store.listKnowledgeItems("review", adminSelf, true);
  assert.equal(reviewQueue.length, 1);
  assert.equal(reviewQueue[0].canReview, true);
  assert.equal(reviewQueue[0].canReturn, false);
  assert.equal(reviewQueue[0].canReject, false);
  assert.equal(await store.countPendingKnowledgeItems(adminSelf), 1);

  assert.equal(await store.reviewKnowledgeItem(pending, adminSelf, "return", "自行退回"), null);
  assert.equal(await store.reviewKnowledgeItem(pending, adminSelf, "reject", "自行拒绝"), null);
  const approved = await store.reviewKnowledgeItem(pending, adminSelf, "approve", "确认内容准确", "internal");
  assert.equal(approved.status, "active");
  assert.equal(approved.reviewNote, "确认内容准确");

  const managed = await store.listKnowledgeItems("all", adminSelf, true);
  assert.equal(managed[0].canSetVisibility, true);
  assert.equal(managed[0].canRevoke, false);
  const active = await store.findKnowledgeItem(created.id, adminSelf, true);
  const published = await store.setKnowledgeItemVisibility(active, adminSelf, "public", policy.PUBLIC_KNOWLEDGE_CONFIRMATION);
  assert.equal(published.visibility, "public");

  const publishedCurrent = await store.findKnowledgeItem(created.id, adminSelf, true);
  assert.equal(await store.reviewKnowledgeItem(publishedCurrent, adminSelf, "revoke", "本人不能自行撤销"), null);

  const events = globalThis[stateKey].sqlite
    .prepare("SELECT action, note FROM knowledge_events ORDER BY created_at, rowid")
    .all()
    .map((row) => ({ action: row.action, note: row.note }));
  assert.deepEqual(events, [
    { action: "submitted", note: "" },
    { action: "approved_internal", note: policy.knowledgeAdminSelfAuditNote("确认内容准确") },
    { action: "visibility_changed_public", note: policy.knowledgeAdminSelfAuditNote("") },
  ]);
});

test("审核必须明确选择内部或公开，公开知识才进入对外检索", async () => {
  const internalDraft = submission({ title: "仅 OA 可见的急停规范" });
  const internalCreated = await store.createKnowledgeItem(actor("submitter"), internalDraft, await policy.hashKnowledgeSubmission(internalDraft));
  const internalPending = await store.findKnowledgeItem(internalCreated.id, actor("submitter"));
  assert.equal(await store.reviewKnowledgeItem(internalPending, actor("reviewer"), "approve", "内部审核", "internal", policy.PUBLIC_KNOWLEDGE_CONFIRMATION), null);
  const internalApproved = await store.reviewKnowledgeItem(internalPending, actor("reviewer"), "approve", "内部审核", "internal");
  assert.equal(internalApproved.visibility, "internal");

  const publicDraft = submission({ title: "可公开的急停复位规范" });
  const publicCreated = await store.createKnowledgeItem(actor("submitter"), publicDraft, await policy.hashKnowledgeSubmission(publicDraft));
  const publicPending = await store.findKnowledgeItem(publicCreated.id, actor("submitter"));
  assert.equal(await store.reviewKnowledgeItem(publicPending, actor("reviewer"), "approve", "公开审核"), null);
  assert.equal(await store.reviewKnowledgeItem(publicPending, actor("reviewer"), "approve", "公开审核", "public"), null);
  assert.equal(await store.reviewKnowledgeItem(publicPending, actor("reviewer"), "approve", "公开审核", "public", "publish"), null);
  assert.equal(globalThis[stateKey].sqlite.prepare("SELECT status, visibility FROM knowledge_items WHERE id = ?").get(publicCreated.id).status, "pending");
  const publicApproved = await store.reviewKnowledgeItem(
    publicPending,
    actor("reviewer"),
    "approve",
    "公开审核",
    "public",
    policy.PUBLIC_KNOWLEDGE_CONFIRMATION,
  );
  assert.equal(publicApproved.status, "active");
  assert.equal(publicApproved.visibility, "public");

  const internalChunks = await store.getActiveKnowledgeChunks(actor("submitter"));
  assert.deepEqual(new Set(internalChunks.map((chunk) => chunk.itemId)), new Set([internalCreated.id, publicCreated.id]));
  const publicChunks = await store.getPublicActiveKnowledgeChunks();
  assert.ok(publicChunks.length >= 1);
  assert.equal(new Set(publicChunks.map((chunk) => chunk.itemId)).size, 1);
  assert.ok(publicChunks.every((chunk) => chunk.id.startsWith("public-chunk-")));
  assert.ok(publicChunks.every((chunk) => chunk.itemId.startsWith("public-item-")));
  assert.ok(publicChunks.every((chunk) => chunk.revisionId.startsWith("public-revision-")));
  assert.ok(publicChunks.every((chunk) => ![internalCreated.id, publicCreated.id].includes(chunk.itemId)));
  assert.ok(publicChunks.every((chunk) => chunk.sourceUrl === ""));

  const approvalEvents = globalThis[stateKey].sqlite.prepare("SELECT action FROM knowledge_events WHERE action LIKE 'approved_%' ORDER BY rowid").all().map((row) => row.action);
  assert.deepEqual(approvalEvents, ["approved_internal", "approved_public"]);
});

test("审核人可重新分类 active 知识且不改动正文、版本或分块", async () => {
  const draft = submission({ title: "可调整范围的设备规范" });
  const created = await store.createKnowledgeItem(actor("submitter"), draft, await policy.hashKnowledgeSubmission(draft));
  const pending = await store.findKnowledgeItem(created.id, actor("submitter"));
  const approved = await store.reviewKnowledgeItem(pending, actor("reviewer"), "approve", "先对内使用", "internal");
  const activeInternal = await store.findKnowledgeItem(created.id, actor("reviewer"), true);
  const sqlite = globalThis[stateKey].sqlite;
  const revisionBefore = sqlite.prepare("SELECT * FROM knowledge_revisions WHERE item_id = ? ORDER BY revision_no").all(created.id);
  const chunksBefore = sqlite.prepare("SELECT * FROM knowledge_chunks WHERE item_id = ? ORDER BY chunk_no").all(created.id);

  assert.equal(await store.setKnowledgeItemVisibility(activeInternal, actor("submitter"), "public", policy.PUBLIC_KNOWLEDGE_CONFIRMATION), null, "投稿人不能调整自己的知识范围");
  assert.equal(await store.setKnowledgeItemVisibility(activeInternal, actor("reviewer"), "internal"), null, "相同范围不能生成空审计事件");
  assert.equal(await store.setKnowledgeItemVisibility(activeInternal, actor("reviewer"), "public"), null, "公开必须二次确认");

  const published = await store.setKnowledgeItemVisibility(
    activeInternal,
    actor("reviewer"),
    "public",
    policy.PUBLIC_KNOWLEDGE_CONFIRMATION,
  );
  assert.equal(published.status, "active");
  assert.equal(published.visibility, "public");
  assert.notEqual(published.mutationRevision, approved.mutationRevision);
  assert.equal(published.currentRevisionId, approved.currentRevisionId);
  assert.equal(published.activeRevisionId, approved.activeRevisionId);
  assert.deepEqual(sqlite.prepare("SELECT * FROM knowledge_revisions WHERE item_id = ? ORDER BY revision_no").all(created.id), revisionBefore);
  assert.deepEqual(sqlite.prepare("SELECT * FROM knowledge_chunks WHERE item_id = ? ORDER BY chunk_no").all(created.id), chunksBefore);
  assert.ok((await store.getPublicActiveKnowledgeChunks()).length >= 1);
  assert.equal(await store.setKnowledgeItemVisibility(activeInternal, actor("reviewer"), "public", policy.PUBLIC_KNOWLEDGE_CONFIRMATION), null, "旧 mutation revision 不能重复调整");

  const current = await store.findKnowledgeItem(created.id, actor("reviewer"), true);
  const internal = await store.setKnowledgeItemVisibility(current, actor("reviewer"), "internal");
  assert.equal(internal.status, "active");
  assert.equal(internal.visibility, "internal");
  assert.deepEqual(await store.getPublicActiveKnowledgeChunks(), []);
  assert.deepEqual(sqlite.prepare("SELECT * FROM knowledge_revisions WHERE item_id = ? ORDER BY revision_no").all(created.id), revisionBefore);
  assert.deepEqual(sqlite.prepare("SELECT * FROM knowledge_chunks WHERE item_id = ? ORDER BY chunk_no").all(created.id), chunksBefore);

  const events = sqlite.prepare("SELECT action, created_at FROM knowledge_events WHERE item_id = ? ORDER BY created_at, id").all(created.id);
  assert.deepEqual(events.map((event) => event.action), ["submitted", "approved_internal", "visibility_changed_public", "visibility_changed_internal"]);
  assert.ok(Date.parse(events[2].created_at) > Date.parse(events[1].created_at));
  assert.ok(Date.parse(events[3].created_at) > Date.parse(events[2].created_at));

  const activeInternalAgain = await store.findKnowledgeItem(created.id, actor("reviewer"), true);
  sqlite.prepare("UPDATE members SET role = 'member' WHERE id = 'member-review'").run();
  assert.equal(await store.setKnowledgeItemVisibility(activeInternalAgain, actor("reviewer"), "public", policy.PUBLIC_KNOWLEDGE_CONFIRMATION), null, "SQL 写入时必须重新验证审核角色");
  sqlite.prepare("UPDATE members SET role = 'project_owner' WHERE id = 'member-review'").run();

  sqlite.exec(`
    CREATE TRIGGER fail_visibility_event
    BEFORE INSERT ON knowledge_events
    WHEN NEW.action IN ('visibility_changed_public', 'visibility_changed_internal')
    BEGIN
      SELECT RAISE(ABORT, 'forced visibility event failure');
    END;
  `);
  await assert.rejects(
    store.setKnowledgeItemVisibility(activeInternalAgain, actor("reviewer"), "public", policy.PUBLIC_KNOWLEDGE_CONFIRMATION),
    /forced visibility event failure/u,
  );
  assert.equal(sqlite.prepare("SELECT visibility FROM knowledge_items WHERE id = ?").get(created.id).visibility, "internal", "事件写入失败必须回滚范围更新");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM knowledge_events WHERE item_id = ?").get(created.id).total, 4);
  sqlite.exec("DROP TRIGGER fail_visibility_event");

  sqlite.prepare("INSERT INTO migration_control (freeze_id) VALUES ('active-freeze')").run();
  await assert.rejects(
    store.setKnowledgeItemVisibility(activeInternalAgain, actor("reviewer"), "public", policy.PUBLIC_KNOWLEDGE_CONFIRMATION),
    /migration write freeze active/u,
  );
  assert.equal(sqlite.prepare("SELECT visibility FROM knowledge_items WHERE id = ?").get(created.id).visibility, "internal");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM knowledge_events WHERE item_id = ?").get(created.id).total, 4);
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

  assert.equal(await store.reviewKnowledgeItem(pending, actor("reviewer"), "approve", "审核通过", "internal"), null);
  const configuredOwner = { ...actor("reviewer"), configuredReviewer: true };
  const approved = await store.reviewKnowledgeItem(pending, configuredOwner, "approve", "审核通过", "internal");
  assert.equal(approved.status, "active");

  const adminDraft = submission({ title: "OA 管理员审核样例" });
  const adminItem = await store.createKnowledgeItem(actor("submitter"), adminDraft, await policy.hashKnowledgeSubmission(adminDraft));
  const adminReviewer = { ...actor("reviewer"), isAdmin: true };
  assert.equal((await store.listKnowledgeItems("review", adminReviewer, true)).length, 1);
  assert.equal(await store.countPendingKnowledgeItems(adminReviewer), 1);
  const adminPending = await store.findKnowledgeItem(adminItem.id, actor("submitter"));
  const adminApproved = await store.reviewKnowledgeItem(adminPending, adminReviewer, "approve", "管理员审核通过", "internal");
  assert.equal(adminApproved.status, "active");
});
