import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaKnowledgeApiAccessTestState";

function authorizedActor(overrides = {}) {
  return {
    user: { email: "review@example.com", displayName: "项目管理员", authProvider: "chatgpt" },
    role: "project_owner",
    accountUserId: "account-review",
    memberId: "member-review",
    memberMutationRevision: "member-revision-review",
    canReviewMembers: false,
    canReviewKnowledge: true,
    canGrantMemberPermissions: false,
    isAdmin: false,
    isFinanceOwner: false,
    ndaCompleted: true,
    ...overrides,
  };
}

function existingItem(overrides = {}) {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    project: "OriginMind × ARTS Robotics 联合研发项目",
    title: "机械臂急停复位",
    category: "安全规范",
    submitter_member_id: "member-submit",
    submitter_name: "投稿成员",
    submitter_email: "submit@example.com",
    status: "pending",
    current_revision_no: 1,
    current_revision_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    active_revision_id: null,
    mutation_revision: "item-mutation-1",
    created_at: "2026-09-10T00:00:00.000Z",
    updated_at: "2026-09-10T00:00:00.000Z",
    revoked_at: null,
    summary: "急停复位流程",
    source_label: "安全手册",
    source_url: "",
    content: "确认安全区无人后再执行复位。",
    content_hash: "a".repeat(64),
    revision_status: "pending",
    reviewed_by_member_id: null,
    reviewed_by_name: null,
    reviewed_by_email: null,
    review_note: "",
    reviewed_at: null,
    activated_at: null,
    retired_at: null,
    ...overrides,
  };
}

globalThis[stateKey] = {};

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "knowledge-api-access-test-dependencies",
    enforce: "pre",
    resolveId(source) {
      if (/(^|\/)api\/_lib\/auth$/u.test(source) || /(^|\/)\.\.\/\.\.\/_lib\/auth$/u.test(source)) return "\0knowledge-api-auth";
      if (/lib\/knowledge-store$/u.test(source)) return "\0knowledge-api-store";
      if (/lib\/write-rate-limit$/u.test(source)) return "\0knowledge-api-rate-limit";
      if (/^(?:\.\.\/)+db$/u.test(source)) return "\0knowledge-api-db";
      return null;
    },
    load(id) {
      if (id === "\0knowledge-api-auth") return `
        export async function getAuthorizedUser() { return globalThis.${stateKey}.authorized; }
        export function isProjectOwner() { return false; }
      `;
      if (id === "\0knowledge-api-store") return `
        export async function findKnowledgeItem() {
          globalThis.${stateKey}.findCalls += 1;
          return globalThis.${stateKey}.existing;
        }
        export async function reviewKnowledgeItem(existing, actor, action, note) {
          globalThis.${stateKey}.reviewCalls.push({ existing, actor, action, note });
          return { id: existing.id, status: action === "approve" ? "active" : action };
        }
        export async function knowledgeRevisionHashExists() { return false; }
        export async function resubmitKnowledgeItem() { throw new Error("not used"); }
        export async function getKnowledgeItemDetail() { return null; }
      `;
      if (id === "\0knowledge-api-rate-limit") return `
        export async function consumeWriteRateLimit() { return true; }
      `;
      if (id === "\0knowledge-api-db") return `
        export async function getDb() { return {}; }
      `;
      return null;
    },
  }],
});

const detailRoute = await vite.ssrLoadModule("/app/api/knowledge/[id]/route.ts");
const params = { params: Promise.resolve({ id: "11111111-2222-4333-8444-555555555555" }) };

function patch(body) {
  return new Request("https://oa.example.test/api/knowledge/11111111-2222-4333-8444-555555555555", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  globalThis[stateKey] = {
    authorized: authorizedActor(),
    existing: existingItem(),
    findCalls: 0,
    reviewCalls: [],
  };
});

after(async () => {
  delete globalThis[stateKey];
  await vite.close();
});

test("所有知识 PATCH 动作强制要求精确 mutationRevision", async () => {
  const missing = await detailRoute.PATCH(patch({ action: "approve" }), params);
  assert.equal(missing.status, 409);
  assert.equal(globalThis[stateKey].findCalls, 0, "缺少版本标识时不应读取或修改知识条目");

  const stale = await detailRoute.PATCH(patch({ action: "approve", mutationRevision: "stale" }), params);
  assert.equal(stale.status, 409);
  assert.equal(globalThis[stateKey].reviewCalls.length, 0);

  const current = await detailRoute.PATCH(patch({ action: "approve", mutationRevision: "item-mutation-1" }), params);
  assert.equal(current.status, 200);
  assert.equal(globalThis[stateKey].reviewCalls.length, 1);
  assert.equal(globalThis[stateKey].reviewCalls[0].action, "approve");
});

test("普通成员不能审核，项目管理员也不能审核自己的投稿", async () => {
  globalThis[stateKey].authorized = authorizedActor({
    user: { email: "member@example.com", displayName: "普通成员", authProvider: "chatgpt" },
    role: "member",
    memberId: "member-normal",
    accountUserId: "account-normal",
    canReviewKnowledge: false,
  });
  const memberResponse = await detailRoute.PATCH(patch({ action: "approve", mutationRevision: "item-mutation-1" }), params);
  assert.equal(memberResponse.status, 403);
  assert.equal(globalThis[stateKey].reviewCalls.length, 0);

  globalThis[stateKey].authorized = authorizedActor();
  globalThis[stateKey].existing = existingItem({ submitter_member_id: "member-review", submitter_email: "review@example.com" });
  const selfResponse = await detailRoute.PATCH(patch({ action: "approve", mutationRevision: "item-mutation-1" }), params);
  assert.equal(selfResponse.status, 403);
  assert.match((await selfResponse.json()).error, /不能审核自己/u);
  assert.equal(globalThis[stateKey].reviewCalls.length, 0);
});

test("未完成 NDA 的成员在读取知识条目前即被拒绝", async () => {
  globalThis[stateKey].authorized = authorizedActor({ ndaCompleted: false });
  const response = await detailRoute.GET(new Request("https://oa.example.test/api/knowledge/11111111-2222-4333-8444-555555555555"), params);
  assert.equal(response.status, 403);
  assert.equal(globalThis[stateKey].findCalls, 0);
});
