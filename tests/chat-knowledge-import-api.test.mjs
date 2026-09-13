import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__chatKnowledgeImportApiTests";
globalThis[stateKey] = {};
const vite = await createServer({
  appType: "custom", configFile: false, root,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "chat-import-auth-and-storage", enforce: "pre",
    resolveId(source) {
      if (source.endsWith("/_lib/auth")) return "\0chat-import-auth";
      if (source.endsWith("lib/knowledge-store")) return "\0chat-import-store";
      if (source.endsWith("lib/write-rate-limit")) return "\0chat-import-rate";
      if (/^(?:\.\.\/)+db$/u.test(source)) return "\0chat-import-db";
      return null;
    },
    load(id) {
      if (id === "\0chat-import-auth") return `export async function getAuthorizedUser() { return globalThis.${stateKey}.authorized; }`;
      if (id === "\0chat-import-db") return "export async function getDb() { return {}; }";
      if (id === "\0chat-import-rate") return `export async function consumeWriteRateLimit() { globalThis.${stateKey}.events.push('rate'); globalThis.${stateKey}.rateCalls += 1; return globalThis.${stateKey}.allowed; }`;
      if (id === "\0chat-import-store") return `export async function createChatImportedKnowledgeItem(actor, submission, hash, id, parts) {
        globalThis.${stateKey}.writes.push({actor,submission,hash,id,parts});
        return {id,title:submission.title,status:'pending',visibility:'internal',contentPartCount:parts?.length || 1};
      }
      export async function findKnowledgeItem(id, actor) {
        globalThis.${stateKey}.events.push('find');
        globalThis.${stateKey}.finds.push({id,actor});
        return globalThis.${stateKey}.existing;
      }
      export async function knowledgeRevisionHashExists(id, hash) {
        globalThis.${stateKey}.events.push('hash-query');
        globalThis.${stateKey}.hashChecks.push({id,hash});
        return globalThis.${stateKey}.hashExists;
      }
      export async function resubmitKnowledgeItem(existing, actor, submission, hash, parts) {
        globalThis.${stateKey}.resubmits.push({existing,actor,submission,hash,parts});
        if (globalThis.${stateKey}.resubmitFailsAsCommitted) {
          globalThis.${stateKey}.existing = {
            ...existing,
            title: submission.title,
            category: submission.category,
            source_label: submission.sourceLabel,
            source_url: submission.sourceUrl,
            status: 'pending',
            revision_status: 'pending',
            current_revision_no: Number(existing.current_revision_no) + 1,
            current_revision_id: 'committed-revision-id',
            active_revision_id: null,
            content_hash: hash,
            content_part_count: parts?.length || 1,
          };
          return null;
        }
        if (globalThis.${stateKey}.resubmitFails) return null;
        return {id:existing.id,title:submission.title,status:'pending',visibility:existing.visibility,currentRevisionNo:Number(existing.current_revision_no) + 1,contentPartCount:parts?.length || 1};
      }`;
      return null;
    },
  }],
});
const route = await vite.ssrLoadModule("/app/api/knowledge/import-chat/route.ts");
const origin = "https://chat.omindos.ai";
const document = { id: "11111111-2222-4333-8444-555555555555", title: "机器人技术资料", body: "本资料由 Chat 管理导入，需经 OA 审核后方可进入知识库。", url: "", category: "research", updatedAt: "2026-09-12" };
function request(body = { document }, requestOrigin = origin) {
  return new Request("https://oa.omindos.ai/api/knowledge/import-chat", { method: "POST", headers: { origin: requestOrigin, "content-type": "application/json", "x-originmind-public-lab-ai-service-token": "A".repeat(43) }, body: JSON.stringify(body) });
}
function returnedItem(overrides = {}) {
  return {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    title: "原标题",
    category: "课题参与",
    summary: "旧摘要",
    source_label: "Chat 管理导入 · 2026-08-01 · 原标题",
    source_url: "https://example.com/original",
    status: "returned",
    revision_status: "returned",
    visibility: "public",
    current_revision_no: 4,
    current_revision_id: "returned-revision-id",
    active_revision_id: null,
    content_hash: "old-hash",
    content_part_count: 3,
    submitter_member_id: "member-id",
    submitter_email: "MEMBER@example.com",
    ...overrides,
  };
}
beforeEach(() => {
  globalThis[stateKey] = { allowed: true, rateCalls: 0, events: [], writes: [], finds: [], hashChecks: [], hashExists: false, resubmits: [], resubmitFails: false, resubmitFailsAsCommitted: false, existing: null, authorized: {
    user: { displayName: "OA 成员", email: "member@example.com" }, memberId: "member-id", accountUserId: "oa-account-id", memberMutationRevision: "member-revision", ndaCompleted: true, isAdmin: false,
  } };
});
after(async () => { await vite.close(); delete globalThis[stateKey]; });

test("only the exact Chat origin gets a credentialed preflight", async () => {
  for (const requestOrigin of [origin, "https://evil.example", "null", "https://chat.omindos.ai.evil.example"]) {
    const response = await route.OPTIONS(new Request("https://oa.omindos.ai/api/knowledge/import-chat", { method: "OPTIONS", headers: { origin: requestOrigin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } }));
    assert.equal(response.status, requestOrigin === origin ? 204 : 403);
    assert.equal(response.headers.get("access-control-allow-origin"), requestOrigin === origin ? origin : null);
  }
});

test("a retrieval token cannot import anonymously, and NDA and cross-origin checks precede writes", async () => {
  globalThis[stateKey].authorized = null;
  const anonymous = await route.POST(request());
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("access-control-allow-credentials"), "true");
  globalThis[stateKey].authorized = { ndaCompleted: false };
  assert.equal((await route.POST(request())).status, 403);
  assert.equal((await route.POST(request({ document }, "https://evil.example"))).status, 403);
  assert.equal(globalThis[stateKey].writes.length, 0);
});

test("an admitted OA session submits one pending internal item using the real OA identity", async () => {
  const response = await route.POST(request());
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.item.status, "pending");
  assert.equal(result.item.visibility, "internal");
  assert.equal(result.partCount, 1);
  assert.equal(globalThis[stateKey].writes.length, 1);
  assert.equal(globalThis[stateKey].rateCalls, 1);
  assert.equal(globalThis[stateKey].writes[0].actor.accountUserId, "oa-account-id");
  assert.equal(result.item.submitterEmail, undefined);
});

test("a large Chat document becomes one OA item with multipart content and one rate-limit use", async () => {
  const body = Array.from({ length: 24_000 }, (_, index) => `## 章节 ${index + 1}\n\n这是需要统一审核的正文段落 ${index + 1}。\n\n`).join("");
  assert.ok(new TextEncoder().encode(JSON.stringify({ document: { ...document, body } })).byteLength > 1.6 * 1024 * 1024);

  const response = await route.POST(request({ document: { ...document, body } }));
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.ok(result.partCount > 1);
  assert.equal(result.item.status, "pending");
  assert.equal(globalThis[stateKey].writes.length, 1);
  assert.equal(globalThis[stateKey].rateCalls, 1);
  assert.equal(globalThis[stateKey].writes[0].parts.length, result.partCount);
  assert.equal(globalThis[stateKey].writes[0].parts.join(""), globalThis[stateKey].writes[0].submission.content);
});

test("rejects JSON envelopes larger than 12 MiB before rate limiting or storage", async () => {
  const response = await route.POST(request({ document: { ...document, body: "x".repeat(12 * 1024 * 1024) } }));
  assert.equal(response.status, 413);
  assert.equal(globalThis[stateKey].rateCalls, 0);
  assert.equal(globalThis[stateKey].writes.length, 0);
});

test("client approval and identity injection and rate-limited imports cannot create items", async () => {
  assert.equal((await route.POST(request({ document: { ...document, status: "active" } }))).status, 400);
  assert.equal((await route.POST(request({ document, accountUserId: "other" }))).status, 400);
  globalThis[stateKey].allowed = false;
  assert.equal((await route.POST(request())).status, 429);
  assert.equal(globalThis[stateKey].writes.length, 0);
});

test("a returned multipart import updates the same item to revision +1 with one rate-limit use", async () => {
  const returnedKnowledgeItemId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  globalThis[stateKey].existing = returnedItem();
  const changedDocument = {
    ...document,
    title: "新文件名",
    category: "business",
    updatedAt: "2026-09-13",
    url: "",
    body: `${document.body}\n${"补充了审核要求的验证结果。".repeat(2_000)}`,
  };
  const response = await route.POST(request({ document: changedDocument, returnedKnowledgeItemId }));
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.item.id, returnedKnowledgeItemId);
  assert.equal(result.item.status, "pending");
  assert.equal(result.item.visibility, "public");
  assert.equal(result.item.currentRevisionNo, 5);
  assert.equal(globalThis[stateKey].resubmits.length, 1);
  assert.equal(globalThis[stateKey].resubmits[0].existing, globalThis[stateKey].existing);
  assert.equal(globalThis[stateKey].resubmits[0].parts.join(""), globalThis[stateKey].resubmits[0].submission.content);
  assert.deepEqual({
    title: globalThis[stateKey].resubmits[0].submission.title,
    category: globalThis[stateKey].resubmits[0].submission.category,
    sourceLabel: globalThis[stateKey].resubmits[0].submission.sourceLabel,
    sourceUrl: globalThis[stateKey].resubmits[0].submission.sourceUrl,
  }, {
    title: "原标题",
    category: "课题参与",
    sourceLabel: "Chat 管理导入 · 2026-08-01 · 原标题",
    sourceUrl: "https://example.com/original",
  });
  assert.match(globalThis[stateKey].resubmits[0].submission.summary, /本资料由 Chat 管理导入/u);
  assert.equal(globalThis[stateKey].writes.length, 0);
  assert.equal(globalThis[stateKey].rateCalls, 1);
  assert.deepEqual(globalThis[stateKey].events.slice(0, 3), ["rate", "find", "hash-query"]);
});

test("returned imports reject unknown fields and IDs before storage, then rate-limit each authorized lookup once", async () => {
  const returnedKnowledgeItemId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  assert.equal((await route.POST(request({ document, returnedKnowledgeItemId, action: "approve" }))).status, 400);
  assert.equal((await route.POST(request({ document, returnedKnowledgeItemId: "not-an-id" }))).status, 400);

  const base = returnedItem({ current_revision_no: 1, content_part_count: 2, submitter_member_id: "another-member", submitter_email: "other@example.com" });
  globalThis[stateKey].existing = base;
  assert.equal((await route.POST(request({ document, returnedKnowledgeItemId }))).status, 404);
  globalThis[stateKey].existing = { ...base, submitter_member_id: "member-id", submitter_email: "member@example.com", status: "pending" };
  assert.equal((await route.POST(request({ document, returnedKnowledgeItemId }))).status, 409);
  globalThis[stateKey].existing = { ...base, submitter_member_id: "member-id", submitter_email: "member@example.com", content_part_count: 1 };
  assert.equal((await route.POST(request({ document, returnedKnowledgeItemId }))).status, 409);
  assert.equal(globalThis[stateKey].rateCalls, 3);
  assert.equal(globalThis[stateKey].writes.length, 0);
  assert.equal(globalThis[stateKey].resubmits.length, 0);
});

test("a returned import with an unchanged historical hash gets an explicit conflict", async () => {
  const returnedKnowledgeItemId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  globalThis[stateKey].existing = returnedItem({ current_revision_no: 2, content_part_count: 2, submitter_email: "member@example.com" });
  globalThis[stateKey].hashExists = true;
  const response = await route.POST(request({ document, returnedKnowledgeItemId }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /不能提交与旧版本相同/u);
  assert.equal(globalThis[stateKey].hashChecks.length, 1);
  assert.equal(globalThis[stateKey].rateCalls, 1);
  assert.equal(globalThis[stateKey].resubmits.length, 0);
});

test("returned-import retries acknowledge the committed pending revision without duplicating audit work", async () => {
  const returnedKnowledgeItemId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  globalThis[stateKey].existing = returnedItem();
  globalThis[stateKey].resubmitFailsAsCommitted = true;
  const changedDocument = { ...document, body: `${document.body}\n${"完整修订正文。".repeat(4_000)}` };

  const raced = await route.POST(request({ document: changedDocument, returnedKnowledgeItemId }));
  assert.equal(raced.status, 200);
  assert.equal((await raced.json()).item.currentRevisionNo, 5);
  assert.equal(globalThis[stateKey].resubmits.length, 1);
  assert.equal(globalThis[stateKey].finds.length, 2, "CAS loss must re-read the committed revision exactly once");

  globalThis[stateKey].resubmitFailsAsCommitted = false;
  const retried = await route.POST(request({ document: changedDocument, returnedKnowledgeItemId }));
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).item.currentRevisionNo, 5);
  assert.equal(globalThis[stateKey].resubmits.length, 1, "an acknowledged retry must not create another revision");
  assert.equal(globalThis[stateKey].hashChecks.length, 1, "the current-hash acknowledgement must precede historical-hash rejection");
});

test("returned imports cannot manufacture a new revision by changing only Chat metadata", async () => {
  const returnedKnowledgeItemId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  globalThis[stateKey].existing = returnedItem();
  globalThis[stateKey].hashExists = true;
  const first = await route.POST(request({
    document: { ...document, title: "伪造标题一", category: "business", updatedAt: "2026-09-13", url: "" },
    returnedKnowledgeItemId,
  }));
  assert.equal(first.status, 409);
  const firstHash = globalThis[stateKey].hashChecks.at(-1).hash;

  const second = await route.POST(request({
    document: { ...document, title: "伪造标题二", category: "student", updatedAt: "2026-09-14", url: "https://evil.example/replacement" },
    returnedKnowledgeItemId,
  }));
  assert.equal(second.status, 409);
  assert.equal(globalThis[stateKey].hashChecks.at(-1).hash, firstHash);
  assert.equal(globalThis[stateKey].resubmits.length, 0);
});

test("a rate-limited returned import never reaches item or revision lookups", async () => {
  globalThis[stateKey].allowed = false;
  const response = await route.POST(request({
    document,
    returnedKnowledgeItemId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  }));
  assert.equal(response.status, 429);
  assert.deepEqual(globalThis[stateKey].events, ["rate"]);
  assert.equal(globalThis[stateKey].finds.length, 0);
  assert.equal(globalThis[stateKey].hashChecks.length, 0);
  assert.equal(globalThis[stateKey].resubmits.length, 0);
});
