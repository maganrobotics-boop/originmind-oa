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
    this.batchStatementCounts = [];
    this.preparedSql = [];
  }

  prepare(sql) {
    this.preparedSql.push(sql);
    return new D1StatementAdapter(this.database, sql);
  }

  async batch(statements) {
    this.batchStatementCounts.push(statements.length);
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
const [migration, hardeningMigration, visibilityMigration, reclassificationMigration, revisionPartsMigration] = await Promise.all([
  readFile(new URL("../drizzle/0026_rich_jocasta.sql", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0027_careless_winter_soldier.sql", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0028_needy_microchip.sql", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0029_knowledge_visibility_reclassification.sql", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0030_large_knowledge_revision_parts.sql", import.meta.url), "utf8"),
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
  database.exec(revisionPartsMigration);
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

function insertKnowledgeListFixture({
  number,
  title = `知识条目 ${number}`,
  category = "测试分类",
  summary = "测试摘要",
  sourceLabel = "测试来源",
  content = "测试正文",
  parts = [],
  status = "active",
  updatedAt = "2026-09-01T00:00:00.000Z",
}) {
  const sqlite = globalThis[stateKey].sqlite;
  const itemId = `list-item-${number}`;
  const revisionId = `list-revision-${number}`;
  const storedContent = parts.length ? "" : content;
  sqlite.prepare(`
    INSERT INTO knowledge_items (
      id, project, title, category, submitter_member_id, submitter_name, submitter_email,
      status, visibility, current_revision_no, current_revision_id, active_revision_id,
      mutation_revision, created_at, updated_at, revoked_at
    ) VALUES (?, '测试项目', ?, ?, 'member-submit', '投稿成员', 'submit@example.com', ?, 'internal', 1, ?, ?, ?, ?, ?, NULL)
  `).run(itemId, title, category, status, revisionId, status === "active" ? revisionId : null,
    `list-mutation-${number}`, updatedAt, updatedAt);
  sqlite.prepare(`
    INSERT INTO knowledge_revisions (
      id, item_id, revision_no, previous_revision_id, title, category, content, summary,
      source_label, source_url, content_hash, status, created_by_member_id, created_by_name,
      created_by_email, reviewed_by_member_id, reviewed_by_name, reviewed_by_email,
      review_note, created_at, reviewed_at, activated_at, retired_at
    ) VALUES (?, ?, 1, NULL, ?, ?, ?, ?, ?, '', ?, ?, 'member-submit', '投稿成员',
      'submit@example.com', NULL, NULL, NULL, '', ?, NULL, NULL, NULL)
  `).run(revisionId, itemId, title, category, storedContent, summary, sourceLabel,
    number.toString(16).padStart(64, "0"), status, updatedAt);
  const insertPart = sqlite.prepare(`
    INSERT INTO knowledge_revision_parts (id, item_id, revision_id, part_no, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  parts.forEach((part, index) => insertPart.run(`list-part-${number}-${index + 1}`, itemId, revisionId, index + 1, part, updatedAt));
  return itemId;
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

test("large Chat imports remain one item, reassemble exactly, and bulk-index on one review", async () => {
  const content = `# 大型 Markdown\n\n${"A".repeat(1_600_000)}`;
  const draft = submission({ title: "1.6 MB Markdown 导入", content });
  const parts = policy.splitKnowledgeStorageParts(content);
  const contentHash = await policy.hashKnowledgeSubmission(draft);
  const itemId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const submitter = actor("submitter");

  assert.ok(parts.length > 32);
  assert.equal(parts.map((part) => part.content).join(""), content);
  const created = await store.createChatImportedKnowledgeItem(submitter, draft, contentHash, itemId, parts);
  assert.equal(created.id, itemId);
  assert.equal(created.contentPartCount, parts.length);

  const sqlite = globalThis[stateKey].sqlite;
  const revision = sqlite.prepare("SELECT id, content, created_at FROM knowledge_revisions WHERE item_id = ?").get(itemId);
  assert.equal(revision.content, "", "multipart revisions must not duplicate the whole body inline");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM knowledge_revision_parts WHERE revision_id = ?").get(revision.id).total, parts.length);
  assert.equal(sqlite.prepare("SELECT COUNT(DISTINCT created_at) AS total FROM knowledge_revision_parts WHERE revision_id = ?").get(revision.id).total, 1);
  assert.equal(sqlite.prepare("SELECT MIN(created_at) AS created_at FROM knowledge_revision_parts WHERE revision_id = ?").get(revision.id).created_at, revision.created_at);

  const reviewList = await store.listKnowledgeItems("review", actor("reviewer"), true);
  assert.equal(reviewList.length, 1);
  assert.equal(reviewList[0].contentPartCount, parts.length);
  assert.equal((await store.findKnowledgeItem(itemId, actor("reviewer"))).content, content);
  const detail = await store.getKnowledgeItemDetail(itemId, actor("reviewer"), true);
  assert.equal(detail.item.content, content);
  assert.equal(detail.revisions[0].content, content);
  assert.equal(detail.revisions[0].contentPartCount, parts.length);

  assert.throws(
    () => sqlite.prepare("UPDATE knowledge_revision_parts SET content = 'tampered' WHERE revision_id = ? AND part_no = 1").run(revision.id),
    /knowledge revision part content is immutable/u,
  );
  assert.throws(
    () => sqlite.prepare("INSERT INTO knowledge_revision_parts (id, item_id, revision_id, part_no, content, created_at) VALUES ('bad-part', ?, 'missing-revision', 1, 'bad', ?)").run(itemId, revision.created_at),
    /knowledge revision part relationship is invalid/u,
  );
  for (const [id, invalidContent] of [["empty-part", ""], ["oversized-part", "x".repeat(20_001)]]) {
    assert.throws(
      () => sqlite.prepare("INSERT INTO knowledge_revision_parts (id, item_id, revision_id, part_no, content, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, itemId, revision.id, parts.length + 1, invalidContent, revision.created_at),
      /knowledge_revision_parts_content_length_check/u,
    );
  }

  const pending = await store.findKnowledgeItem(itemId, actor("reviewer"));
  const approved = await store.reviewKnowledgeItem(pending, actor("reviewer"), "approve", "大文件审核通过", "internal");
  assert.equal(approved.status, "active");
  assert.ok(globalThis[stateKey].database.batchStatementCounts.at(-1) < 40, "review batch must leave room under D1's 50-query request limit");
  const indexed = sqlite.prepare("SELECT chunk_no, length(content) AS content_length FROM knowledge_chunks WHERE item_id = ? ORDER BY chunk_no").all(itemId);
  assert.ok(indexed.length > 32);
  assert.ok(indexed.length <= policy.MAX_KNOWLEDGE_CHUNKS);
  assert.ok(indexed.every((chunk, index) => chunk.chunk_no === index + 1 && chunk.content_length <= 2_000));

  const retry = await store.createChatImportedKnowledgeItem(submitter, draft, contentHash, itemId, parts);
  assert.equal(retry.status, "active");
  assert.equal(retry.contentPartCount, parts.length);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM knowledge_events WHERE item_id = ?").get(itemId).total, 2);
});

test("worst-case escaped 5 MiB content keeps multipart writes below the D1 query budget", async () => {
  const prefix = "# JSON 转义压力测试\n\n";
  const pair = '\\"';
  const targetLength = 5 * 1024 * 1024;
  const content = `${prefix}${pair.repeat(Math.floor((targetLength - prefix.length) / pair.length))}${"x".repeat((targetLength - prefix.length) % pair.length)}`;
  const draft = submission({ title: "5 MiB 转义字符文档", content });
  const parts = policy.splitKnowledgeStorageParts(content);
  const itemId = "ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb";

  const created = await store.createChatImportedKnowledgeItem(
    actor("submitter"),
    draft,
    await policy.hashKnowledgeSubmission(draft),
    itemId,
    parts,
  );
  assert.equal(created.contentPartCount, parts.length);
  assert.ok(globalThis[stateKey].database.batchStatementCounts.at(-1) < 20, "multipart creation must use JSON1 bulk inserts");

  const pending = await store.findKnowledgeItem(itemId, actor("reviewer"));
  await store.reviewKnowledgeItem(pending, actor("reviewer"), "approve", "边界审核", "internal");
  assert.ok(globalThis[stateKey].database.batchStatementCounts.at(-1) < 40, "worst-case review must leave room under D1's 50-query request limit");
  const chunkCount = globalThis[stateKey].sqlite.prepare("SELECT COUNT(*) AS total FROM knowledge_chunks WHERE item_id = ?").get(itemId).total;
  assert.ok(chunkCount > 2_000 && chunkCount <= policy.MAX_KNOWLEDGE_CHUNKS);
});

test("multipart hydration fails closed when stored parts do not match the immutable revision hash", async () => {
  const content = "A".repeat(20_001);
  const draft = submission({ title: "分片哈希校验", content });
  const parts = policy.splitKnowledgeStorageParts(content);
  const itemId = "12345678-aaaa-4bbb-8ccc-123456789abc";
  await store.createChatImportedKnowledgeItem(
    actor("submitter"),
    draft,
    await policy.hashKnowledgeSubmission(draft),
    itemId,
    parts,
  );

  const sqlite = globalThis[stateKey].sqlite;
  sqlite.exec("DROP TRIGGER knowledge_revision_parts_content_immutable");
  sqlite.prepare("UPDATE knowledge_revision_parts SET content = ? WHERE item_id = ? AND part_no = 1")
    .run(`B${parts[0].content.slice(1)}`, itemId);
  await assert.rejects(
    store.findKnowledgeItem(itemId, actor("reviewer")),
    /knowledge revision parts do not match content hash/u,
  );
});

test("Chat import keeps one item, exposes lossless storage parts, and enforces a 5 MiB UTF-8 boundary", async () => {
  const document = { id: "11111111-2222-4333-8444-555555555555", title: "导入资料", body: "机器人技术。".repeat(4_000), url: "", category: "research", updatedAt: "2026-09-12" };
  const parsed = chatImport.parseChatKnowledgeImport({ document });
  assert.equal(parsed.submissions.length, 1);
  assert.equal(parsed.submissions[0].content, document.body);
  assert.equal(parsed.partCount, parsed.parts.length);
  assert.equal(parsed.parts.map((part) => part.content).join(""), parsed.submissions[0].content);
  assert.ok(parsed.parts.every((part) => part.content.length <= policy.MAX_KNOWLEDGE_CONTENT_LENGTH));
  for (const length of [18001, 20000, 20001, 29999]) {
    const content = "a".repeat(length - 2) + "😀";
    const result = chatImport.parseChatKnowledgeImport({ document: { ...document, body: content } });
    assert.equal(result.submissions.length, 1);
    assert.equal(result.submissions[0].content, content);
    assert.equal(result.parts.map((part) => part.content).join(""), content);
    assert.ok(result.parts.every((part) => part.content.length <= 20_000 && policy.isWellFormedUnicode(part.content)));
  }

  const onePointSixMiB = "a".repeat(Math.floor(1.6 * 1024 * 1024));
  const onePointSixResult = chatImport.parseChatKnowledgeImport({ document: { ...document, body: onePointSixMiB } });
  assert.equal(onePointSixResult.submissions.length, 1);
  assert.equal(onePointSixResult.parts.map((part) => part.content).join(""), onePointSixMiB);

  const exactLimitAscii = "a".repeat(chatImport.MAX_CHAT_KNOWLEDGE_IMPORT_BYTES);
  const exactAsciiResult = chatImport.parseChatKnowledgeImport({ document: { ...document, body: exactLimitAscii } });
  assert.equal(new TextEncoder().encode(exactAsciiResult.submissions[0].content).byteLength, chatImport.MAX_CHAT_KNOWLEDGE_IMPORT_BYTES);
  assert.equal(exactAsciiResult.parts.map((part) => part.content).join(""), exactLimitAscii);
  assert.ok(exactAsciiResult.parts.every((part) => part.content.length <= 20_000));
  assert.throws(() => chatImport.parseChatKnowledgeImport({
    document: { ...document, body: `${exactLimitAscii}a` },
  }), /UTF-8/u);

  const exactLimitEmoji = "😀".repeat(chatImport.MAX_CHAT_KNOWLEDGE_IMPORT_BYTES / 4);
  const exactEmojiResult = chatImport.parseChatKnowledgeImport({ document: { ...document, body: exactLimitEmoji } });
  assert.equal(new TextEncoder().encode(exactEmojiResult.submissions[0].content).byteLength, chatImport.MAX_CHAT_KNOWLEDGE_IMPORT_BYTES);
  assert.equal(exactEmojiResult.parts.map((part) => part.content).join(""), exactLimitEmoji);
  assert.ok(exactEmojiResult.parts.every((part) => policy.isWellFormedUnicode(part.content)));
  assert.throws(() => chatImport.parseChatKnowledgeImport({
    document: { ...document, body: `${exactLimitEmoji}😀` },
  }), /UTF-8/u);

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

test("管理列表关键词覆盖当前版本元数据、内联正文和 multipart 正文", async () => {
  const expected = new Map([
    ["TITLE-token", insertKnowledgeListFixture({ number: 1001, title: "title-token 操作规范" })],
    ["category-token", insertKnowledgeListFixture({ number: 1002, category: "category-token" })],
    ["summary-token", insertKnowledgeListFixture({ number: 1003, summary: "包含 summary-token 的摘要" })],
    ["source-token", insertKnowledgeListFixture({ number: 1004, sourceLabel: "source-token 手册" })],
    ["inline-token", insertKnowledgeListFixture({ number: 1005, content: "正文包含 inline-token" })],
    ["multipart-token", insertKnowledgeListFixture({ number: 1006, parts: ["第一部分", "第二部分包含 multipart-token"] })],
    ["100%_safe'", insertKnowledgeListFixture({ number: 1007, content: "字面量 100%_safe' 可检索" })],
  ]);
  insertKnowledgeListFixture({ number: 1008, title: "完全不匹配" });

  for (const [query, expectedId] of expected) {
    const matches = await store.listKnowledgeItems("all", actor("reviewer"), true, { query, sort: "updated_desc" });
    assert.deepEqual(matches.map((item) => item.id), [expectedId], `query ${query} should match its current revision field`);
  }
});

test("管理列表先过滤全库再应用 100 条上限，并由 SQL 按更新时间排序", async () => {
  const targetId = insertKnowledgeListFixture({
    number: 2000,
    title: "唯一目标记录",
    content: "正文含有 needle-token",
    updatedAt: "2020-01-01T00:00:00.000Z",
  });
  for (let index = 1; index <= 101; index += 1) {
    insertKnowledgeListFixture({
      number: 2000 + index,
      title: `无关记录 ${index}`,
      updatedAt: `2026-09-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    });
  }

  const filtered = await store.listKnowledgeItems("all", actor("reviewer"), true, { query: "needle-token", sort: "updated_desc" });
  assert.deepEqual(filtered.map((item) => item.id), [targetId]);

  const newestFirst = await store.listKnowledgeItems("all", actor("reviewer"), true, { sort: "updated_desc" });
  const oldestFirst = await store.listKnowledgeItems("all", actor("reviewer"), true, { sort: "updated_asc" });
  assert.equal(newestFirst.length, 100);
  assert.equal(oldestFirst.length, 100);
  assert.equal(oldestFirst[0].id, targetId);
  assert.ok(newestFirst.every((item, index) => index === 0 || item.updatedAt <= newestFirst[index - 1].updatedAt));
  assert.ok(oldestFirst.every((item, index) => index === 0 || item.updatedAt >= oldestFirst[index - 1].updatedAt));
});

test("标题按中文拼音对全匹配结果排序后再截取 100 条", async () => {
  const firstId = insertKnowledgeListFixture({
    number: 3000,
    title: "阿尔法规范",
    updatedAt: "2020-01-01T00:00:00.000Z",
  });
  for (let index = 1; index <= 100; index += 1) {
    insertKnowledgeListFixture({
      number: 3000 + index,
      title: `中间规范 ${index}`,
      updatedAt: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    });
  }

  const ascending = await store.listKnowledgeItems("all", actor("reviewer"), true, { sort: "title_asc" });
  const descending = await store.listKnowledgeItems("all", actor("reviewer"), true, { sort: "title_desc" });
  assert.equal(ascending.length, 100);
  assert.equal(descending.length, 100);
  assert.equal(ascending[0].id, firstId, "old but alphabetically first item must not be cut off before title sorting");
  assert.equal(descending.some((item) => item.id === firstId), false);
  const collator = new Intl.Collator("zh-CN-u-co-pinyin", { usage: "sort", sensitivity: "base", numeric: true });
  assert.ok(ascending.every((item, index) => index === 0 || collator.compare(ascending[index - 1].title, item.title) <= 0));
  assert.ok(descending.every((item, index) => index === 0 || collator.compare(descending[index - 1].title, item.title) >= 0));
});

test("管理列表无查询参数时保留待审核优先的原默认排序", async () => {
  insertKnowledgeListFixture({ number: 4001, title: "较新的已入库记录", status: "active", updatedAt: "2026-09-12T00:00:00.000Z" });
  const pendingId = insertKnowledgeListFixture({ number: 4002, title: "较旧的待审核记录", status: "pending", updatedAt: "2026-01-01T00:00:00.000Z" });
  const items = await store.listKnowledgeItems("all", actor("reviewer"), true);
  assert.equal(items[0].id, pendingId);
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

test("multipart 退回重提在真实 SQLite 中保留旧分片并原子创建新版本", async () => {
  const sqlite = globalThis[stateKey].sqlite;
  const itemId = "22222222-3333-4444-8555-666666666666";
  const storedParts = (revisionId) => sqlite
    .prepare("SELECT part_no, content FROM knowledge_revision_parts WHERE revision_id = ? ORDER BY part_no")
    .all(revisionId)
    .map((part) => ({ part_no: Number(part.part_no), content: part.content }));
  const firstContent = `# 第一版大文档\n\n${"第一版正文。".repeat(7_000)}`;
  const first = submission({ title: "第一版大文档", content: firstContent });
  const firstParts = policy.splitKnowledgeStorageParts(firstContent);
  assert.ok(firstParts.length > 1);
  assert.equal(firstParts.map((part) => part.content).join(""), firstContent);

  const created = await store.createChatImportedKnowledgeItem(
    actor("submitter"),
    first,
    await policy.hashKnowledgeSubmission(first),
    itemId,
    firstParts,
  );
  const firstRevisionId = created.currentRevisionId;
  const pending = await store.findKnowledgeItem(itemId, actor("submitter"));
  await store.reviewKnowledgeItem(pending, actor("reviewer"), "return", "请补充新版正文");
  const returnedBeforeFailure = await store.findKnowledgeItem(itemId, actor("submitter"));
  const returnedMutationRevision = returnedBeforeFailure.mutation_revision;

  const secondContent = `# 第二版大文档\n\n${"第二版补充正文。".repeat(6_000)}`;
  const second = submission({ title: "第二版大文档", content: secondContent });
  const secondParts = policy.splitKnowledgeStorageParts(secondContent);
  assert.ok(secondParts.length > 1);
  assert.equal(secondParts.map((part) => part.content).join(""), secondContent);

  sqlite.exec(`
    CREATE TRIGGER fail_multipart_resubmit_part
    BEFORE INSERT ON knowledge_revision_parts
    WHEN NEW.item_id = '${itemId}'
    BEGIN
      SELECT RAISE(ABORT, 'forced multipart resubmit part failure');
    END;
  `);
  await assert.rejects(
    store.resubmitKnowledgeItem(
      returnedBeforeFailure,
      actor("submitter"),
      second,
      await policy.hashKnowledgeSubmission(second),
      secondParts,
    ),
    /forced multipart resubmit part failure/u,
  );

  const rolledBackItem = sqlite.prepare(`
    SELECT status, current_revision_no, current_revision_id, mutation_revision
    FROM knowledge_items WHERE id = ?
  `).get(itemId);
  assert.equal(rolledBackItem.status, "returned");
  assert.equal(rolledBackItem.current_revision_no, 1);
  assert.equal(rolledBackItem.current_revision_id, firstRevisionId);
  assert.equal(rolledBackItem.mutation_revision, returnedMutationRevision);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM knowledge_revisions WHERE item_id = ?").get(itemId).total, 1);
  assert.deepEqual(
    storedParts(firstRevisionId),
    firstParts.map((part) => ({ part_no: part.partNo, content: part.content })),
  );
  assert.deepEqual(
    sqlite.prepare("SELECT action FROM knowledge_events WHERE item_id = ? ORDER BY created_at, rowid").all(itemId).map((event) => event.action),
    ["submitted", "returned"],
  );
  sqlite.exec("DROP TRIGGER fail_multipart_resubmit_part");

  const returned = await store.findKnowledgeItem(itemId, actor("submitter"));
  const resubmitted = await store.resubmitKnowledgeItem(
    returned,
    actor("submitter"),
    second,
    await policy.hashKnowledgeSubmission(second),
    secondParts,
  );
  const resubmitBatchSize = globalThis[stateKey].database.batchStatementCounts.at(-1);
  assert.equal(resubmitted.id, itemId);
  assert.equal(resubmitted.status, "pending");
  assert.equal(resubmitted.currentRevisionNo, 2);
  assert.equal(resubmitted.contentPartCount, secondParts.length);
  assert.ok(resubmitBatchSize < 50, "multipart resubmission must stay within D1's 50-query request limit");

  const revisions = sqlite.prepare(`
    SELECT id, revision_no, previous_revision_id, content, content_hash, status
    FROM knowledge_revisions WHERE item_id = ? ORDER BY revision_no
  `).all(itemId);
  assert.equal(revisions.length, 2);
  assert.deepEqual(revisions.map((revision) => revision.status), ["returned", "pending"]);
  assert.deepEqual(revisions.map((revision) => revision.content), ["", ""]);
  assert.equal(revisions[0].id, firstRevisionId);
  assert.equal(revisions[1].previous_revision_id, firstRevisionId);
  assert.notEqual(revisions[1].content_hash, revisions[0].content_hash);
  assert.deepEqual(
    storedParts(firstRevisionId),
    firstParts.map((part) => ({ part_no: part.partNo, content: part.content })),
  );
  assert.deepEqual(
    storedParts(revisions[1].id),
    secondParts.map((part) => ({ part_no: part.partNo, content: part.content })),
  );
  assert.throws(
    () => sqlite.prepare("UPDATE knowledge_revision_parts SET content = 'tampered' WHERE revision_id = ? AND part_no = 1").run(firstRevisionId),
    /knowledge revision part content is immutable/u,
  );

  const detail = await store.getKnowledgeItemDetail(itemId, actor("reviewer"), true);
  assert.equal(detail.item.content, secondContent);
  assert.deepEqual(detail.revisions.map((revision) => revision.content), [secondContent, firstContent]);
  assert.deepEqual(detail.revisions.map((revision) => revision.contentPartCount), [secondParts.length, firstParts.length]);
  assert.deepEqual(detail.events.map((event) => event.action), ["submitted", "returned", "resubmitted"]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM knowledge_chunks WHERE item_id = ?").get(itemId).total, 0);

  const secondPending = await store.findKnowledgeItem(itemId, actor("reviewer"));
  const approved = await store.reviewKnowledgeItem(secondPending, actor("reviewer"), "approve", "新版大文档审核通过", "internal");
  assert.equal(approved.status, "active");
  const activeRevisionIds = sqlite.prepare("SELECT DISTINCT revision_id FROM knowledge_chunks WHERE item_id = ? AND is_active = 1").all(itemId).map((chunk) => chunk.revision_id);
  assert.deepEqual(activeRevisionIds, [revisions[1].id]);
  assert.deepEqual(
    storedParts(firstRevisionId),
    firstParts.map((part) => ({ part_no: part.partNo, content: part.content })),
  );
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

test("问题预筛选不会让超过候选上限的旧文档尾部在内部或公共检索中饿死", async () => {
  const sqlite = globalThis[stateKey].sqlite;
  const insertItem = sqlite.prepare(`
    INSERT INTO knowledge_items (
      id, project, title, category, submitter_member_id, submitter_name, submitter_email,
      status, visibility, current_revision_no, current_revision_id, active_revision_id,
      mutation_revision, created_at, updated_at, revoked_at
    ) VALUES (?, ?, ?, '测试', 'member-submit', '投稿成员', 'submit@example.com',
      'active', 'public', 1, ?, ?, ?, ?, ?, NULL)
  `);
  const insertRevision = sqlite.prepare(`
    INSERT INTO knowledge_revisions (
      id, item_id, revision_no, previous_revision_id, title, category, content, summary,
      source_label, source_url, content_hash, status, created_by_member_id, created_by_name,
      created_by_email, reviewed_by_member_id, reviewed_by_name, reviewed_by_email,
      review_note, created_at, reviewed_at, activated_at, retired_at
    ) VALUES (?, ?, 1, NULL, ?, '测试', '固定夹具正文', '', '测试夹具', '', ?, 'active',
      'member-submit', '投稿成员', 'submit@example.com', 'member-review', '项目管理员',
      'review@example.com', '夹具审核', ?, ?, ?, NULL)
  `);
  const insertChunk = sqlite.prepare(`
    INSERT INTO knowledge_chunks (
      id, item_id, revision_id, chunk_no, section_title, paragraph_ref,
      content, search_text, is_active, created_at
    ) VALUES (?, ?, ?, ?, '', ?, ?, ?, 1, ?)
  `);
  const fixtures = [
    { itemId: "fixture-old-item", revisionId: "fixture-old-revision", title: "旧版长文", updatedAt: "2026-01-01T00:00:00.000Z", hash: "a".repeat(64) },
    { itemId: "fixture-middle-item", revisionId: "fixture-middle-revision", title: "中间长文", updatedAt: "2026-05-01T00:00:00.000Z", hash: "c".repeat(64) },
    { itemId: "fixture-new-item", revisionId: "fixture-new-revision", title: "新版长文", updatedAt: "2026-09-01T00:00:00.000Z", hash: "b".repeat(64) },
  ];

  sqlite.exec("BEGIN IMMEDIATE");
  try {
    for (const fixture of fixtures) {
      insertItem.run(
        fixture.itemId,
        policy.KNOWLEDGE_PROJECT,
        fixture.title,
        fixture.revisionId,
        fixture.revisionId,
        `${fixture.itemId}-mutation`,
        fixture.updatedAt,
        fixture.updatedAt,
      );
      insertRevision.run(
        fixture.revisionId,
        fixture.itemId,
        fixture.title,
        fixture.hash,
        fixture.updatedAt,
        fixture.updatedAt,
        fixture.updatedAt,
      );
      for (let chunkNo = 1; chunkNo <= policy.MAX_KNOWLEDGE_CHUNKS; chunkNo += 1) {
        const hasRareTailTerm = fixture.itemId === "fixture-old-item" && chunkNo === policy.MAX_KNOWLEDGE_CHUNKS;
        const content = hasRareTailTerm
          ? "冷门尾段校验词只出现在旧文档最后一块"
          : `${fixture.itemId === "fixture-new-item" ? "commonroboticskeyword 机械臂" : ""}${fixture.title}普通内容 ${chunkNo}`;
        insertChunk.run(
          `${fixture.itemId}-chunk-${chunkNo}`,
          fixture.itemId,
          fixture.revisionId,
          chunkNo,
          `第 ${chunkNo} 段`,
          content,
          content.toLocaleLowerCase("zh-CN"),
          fixture.updatedAt,
        );
      }
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }

  const unfilteredInternal = await store.getActiveKnowledgeChunks(actor("submitter"));
  assert.equal(unfilteredInternal.length, policy.MAX_KNOWLEDGE_CHUNKS);
  assert.deepEqual(new Set(unfilteredInternal.map((chunk) => chunk.itemId)), new Set(["fixture-new-item"]));
  const unfilteredPublic = await store.getPublicActiveKnowledgeChunks();
  assert.equal(unfilteredPublic.length, policy.MAX_KNOWLEDGE_CHUNKS);
  assert.ok(unfilteredPublic.every((chunk) => !chunk.content.includes("冷门尾段校验词")));

  const question = "机械臂 冷门尾段校验词在哪里？";
  const internal = await store.getActiveKnowledgeChunks(actor("submitter"), question);
  assert.ok(internal.length > 1 && internal.length <= policy.MAX_KNOWLEDGE_CHUNKS);
  const rareInternal = internal.find((chunk) => chunk.content.includes("冷门尾段校验词"));
  assert.equal(rareInternal?.itemId, "fixture-old-item");
  assert.ok(policy.rankKnowledgeChunks(question, internal, 6).some((chunk) => chunk.content.includes("冷门尾段校验词")));

  const publicChunks = await store.getPublicActiveKnowledgeChunks(question);
  assert.ok(publicChunks.length > 1 && publicChunks.length <= policy.MAX_KNOWLEDGE_CHUNKS);
  const rarePublic = publicChunks.find((chunk) => chunk.content.includes("冷门尾段校验词"));
  assert.ok(rarePublic?.itemId.startsWith("public-item-"));
  assert.ok(policy.rankKnowledgeChunks(question, publicChunks, 6).some((chunk) => chunk.content.includes("冷门尾段校验词")));

  const maximumTermQuestion = [
    "commonroboticskeyword",
    "冷门尾段校验词",
    ...Array.from({ length: 51 }, (_, index) => `q${String(index).padStart(2, "0")}`),
  ].join(" ");
  assert.equal(policy.knowledgeSearchTerms(maximumTermQuestion).length, 64);

  let statementCount = globalThis[stateKey].database.preparedSql.length;
  let startedAt = performance.now();
  const maximumInternal = await store.getActiveKnowledgeChunks(actor("submitter"), maximumTermQuestion);
  const internalElapsed = performance.now() - startedAt;
  assert.equal(globalThis[stateKey].database.preparedSql.length - statementCount, 1, "internal prefilter must remain one D1 query");
  assert.equal(globalThis[stateKey].database.preparedSql.at(-1).match(/\(\d+, \?, \d+\)/gu)?.length, 16);
  assert.ok(maximumInternal.length <= policy.MAX_KNOWLEDGE_CHUNKS);
  assert.ok(maximumInternal.some((chunk) => chunk.content.includes("冷门尾段校验词")));
  assert.ok(internalElapsed < 8_000, `64-term internal prefilter took ${internalElapsed.toFixed(0)} ms`);

  statementCount = globalThis[stateKey].database.preparedSql.length;
  startedAt = performance.now();
  const maximumPublic = await store.getPublicActiveKnowledgeChunks(maximumTermQuestion);
  const publicElapsed = performance.now() - startedAt;
  assert.equal(globalThis[stateKey].database.preparedSql.length - statementCount, 1, "public prefilter must remain one D1 query");
  assert.equal(globalThis[stateKey].database.preparedSql.at(-1).match(/\(\d+, \?, \d+\)/gu)?.length, 16);
  assert.ok(maximumPublic.length <= policy.MAX_KNOWLEDGE_CHUNKS);
  assert.ok(maximumPublic.some((chunk) => chunk.content.includes("冷门尾段校验词")));
  assert.ok(publicElapsed < 8_000, `64-term public prefilter took ${publicElapsed.toFixed(0)} ms`);

  const sharedInternalCandidates = await store.getActiveKnowledgeChunks(actor("submitter"), "普通内容");
  assert.equal(sharedInternalCandidates.length, policy.MAX_KNOWLEDGE_CHUNKS);
  assert.deepEqual(new Set(sharedInternalCandidates.map((chunk) => chunk.itemId)), new Set(fixtures.map((fixture) => fixture.itemId)));
  const sharedInternalResults = policy.rankKnowledgeChunks("普通内容", sharedInternalCandidates, 6);
  assert.equal(sharedInternalResults.length, 6);
  assert.deepEqual(new Set(sharedInternalResults.map((chunk) => chunk.itemId)), new Set(fixtures.map((fixture) => fixture.itemId)));

  const sharedPublicCandidates = await store.getPublicActiveKnowledgeChunks("普通内容");
  assert.equal(sharedPublicCandidates.length, policy.MAX_KNOWLEDGE_CHUNKS);
  assert.equal(new Set(sharedPublicCandidates.map((chunk) => chunk.itemId)).size, fixtures.length);
  const sharedPublicResults = policy.rankKnowledgeChunks("普通内容", sharedPublicCandidates, 6);
  assert.equal(sharedPublicResults.length, 6);
  assert.equal(new Set(sharedPublicResults.map((chunk) => chunk.itemId)).size, fixtures.length);

  assert.deepEqual(await store.getActiveKnowledgeChunks(actor("submitter"), "如何？"), []);
  assert.deepEqual(await store.getPublicActiveKnowledgeChunks("如何？"), []);
});
