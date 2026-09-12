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
    visibility: "internal",
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
        export async function reviewKnowledgeItem(existing, actor, action, note, visibility, publicConfirmation) {
          globalThis.${stateKey}.reviewCalls.push({ existing, actor, action, note, visibility, publicConfirmation });
          return { id: existing.id, status: action === "approve" ? "active" : action };
        }
        export async function setKnowledgeItemVisibility(existing, actor, visibility, publicConfirmation) {
          globalThis.${stateKey}.visibilityCalls.push({ existing, actor, visibility, publicConfirmation });
          return { id: existing.id, status: "active", visibility };
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
    visibilityCalls: [],
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

  const stale = await detailRoute.PATCH(patch({ action: "approve", mutationRevision: "stale", visibility: "internal" }), params);
  assert.equal(stale.status, 409);
  assert.equal(globalThis[stateKey].reviewCalls.length, 0);

  const current = await detailRoute.PATCH(patch({ action: "approve", mutationRevision: "item-mutation-1", visibility: "internal" }), params);
  assert.equal(current.status, 200);
  assert.equal(globalThis[stateKey].reviewCalls.length, 1);
  assert.equal(globalThis[stateKey].reviewCalls[0].action, "approve");
  assert.equal(globalThis[stateKey].reviewCalls[0].visibility, "internal");
  assert.equal(globalThis[stateKey].reviewCalls[0].publicConfirmation, undefined);
});

test("批准知识必须显式选择合法可见范围且在读取数据库前拒绝错误输入", async () => {
  for (const body of [
    { action: "approve", mutationRevision: "item-mutation-1" },
    { action: "approve", mutationRevision: "item-mutation-1", visibility: "" },
    { action: "approve", mutationRevision: "item-mutation-1", visibility: "private" },
    { action: "approve", mutationRevision: "item-mutation-1", visibility: null },
  ]) {
    const response = await detailRoute.PATCH(patch(body), params);
    assert.equal(response.status, 400);
  }
  assert.equal(globalThis[stateKey].findCalls, 0);
  assert.equal(globalThis[stateKey].reviewCalls.length, 0);
});

test("公开批准要求逐字一致的二次确认并将范围传给 store", async () => {
  for (const publicConfirmation of [undefined, "", "publish_to_chat.omindos.ai ", "PUBLISH_TO_CHAT.OMINDOS.AI"]) {
    const body = { action: "approve", mutationRevision: "item-mutation-1", visibility: "public" };
    if (publicConfirmation !== undefined) body.publicConfirmation = publicConfirmation;
    const response = await detailRoute.PATCH(patch(body), params);
    assert.equal(response.status, 400);
  }
  assert.equal(globalThis[stateKey].findCalls, 0);
  assert.equal(globalThis[stateKey].reviewCalls.length, 0);

  const response = await detailRoute.PATCH(patch({
    action: "approve",
    mutationRevision: "item-mutation-1",
    visibility: "public",
    publicConfirmation: "publish_to_chat.omindos.ai",
  }), params);
  assert.equal(response.status, 200);
  assert.equal(globalThis[stateKey].reviewCalls.length, 1);
  assert.equal(globalThis[stateKey].reviewCalls[0].visibility, "public");
  assert.equal(globalThis[stateKey].reviewCalls[0].publicConfirmation, "publish_to_chat.omindos.ai");
});

test("对内批准和非批准动作拒绝不适用的公开范围字段", async () => {
  const internalWithConfirmation = await detailRoute.PATCH(patch({
    action: "approve",
    mutationRevision: "item-mutation-1",
    visibility: "internal",
    publicConfirmation: "publish_to_chat.omindos.ai",
  }), params);
  assert.equal(internalWithConfirmation.status, 400);

  for (const body of [
    { action: "return", mutationRevision: "item-mutation-1", note: "请补充", visibility: "internal" },
    { action: "reject", mutationRevision: "item-mutation-1", note: "不适用", publicConfirmation: "publish_to_chat.omindos.ai" },
    { action: "revoke", mutationRevision: "item-mutation-1", note: "已过期", visibility: "public" },
    { action: "resubmit", mutationRevision: "item-mutation-1", title: "标题", category: "分类", content: "这是足够长的知识正文。", visibility: "internal" },
  ]) {
    const response = await detailRoute.PATCH(patch(body), params);
    assert.equal(response.status, 400);
  }
  assert.equal(globalThis[stateKey].findCalls, 0);
  assert.equal(globalThis[stateKey].reviewCalls.length, 0);
});

test("退回等非批准动作不向 store 传入可见范围", async () => {
  const response = await detailRoute.PATCH(patch({
    action: "return",
    mutationRevision: "item-mutation-1",
    note: "请补充边界条件",
  }), params);
  assert.equal(response.status, 200);
  assert.equal(globalThis[stateKey].reviewCalls.length, 1);
  assert.equal(globalThis[stateKey].reviewCalls[0].action, "return");
  assert.equal(globalThis[stateKey].reviewCalls[0].visibility, undefined);
  assert.equal(globalThis[stateKey].reviewCalls[0].publicConfirmation, undefined);
});

test("普通成员和项目负责人不能自审，系统管理员可以批准自己的投稿", async () => {
  globalThis[stateKey].authorized = authorizedActor({
    user: { email: "member@example.com", displayName: "普通成员", authProvider: "chatgpt" },
    role: "member",
    memberId: "member-normal",
    accountUserId: "account-normal",
    canReviewKnowledge: false,
  });
  const memberResponse = await detailRoute.PATCH(patch({ action: "approve", mutationRevision: "item-mutation-1", visibility: "internal" }), params);
  assert.equal(memberResponse.status, 403);
  assert.equal(globalThis[stateKey].reviewCalls.length, 0);

  globalThis[stateKey].authorized = authorizedActor();
  globalThis[stateKey].existing = existingItem({ submitter_member_id: "member-review", submitter_email: "review@example.com" });
  const selfResponse = await detailRoute.PATCH(patch({ action: "approve", mutationRevision: "item-mutation-1", visibility: "internal" }), params);
  assert.equal(selfResponse.status, 403);
  assert.match((await selfResponse.json()).error, /不能审核自己/u);
  assert.equal(globalThis[stateKey].reviewCalls.length, 0);

  globalThis[stateKey].authorized = authorizedActor({ isAdmin: true });
  const adminSelfResponse = await detailRoute.PATCH(patch({ action: "approve", mutationRevision: "item-mutation-1", visibility: "internal" }), params);
  assert.equal(adminSelfResponse.status, 200);
  assert.equal(globalThis[stateKey].reviewCalls.length, 1);
  assert.equal(globalThis[stateKey].reviewCalls[0].actor.isAdmin, true);

  const adminSelfReturn = await detailRoute.PATCH(patch({ action: "return", mutationRevision: "item-mutation-1", note: "自行退回" }), params);
  assert.equal(adminSelfReturn.status, 403);
  assert.match((await adminSelfReturn.json()).error, /只能批准自己的知识或调整可见范围/u);
  assert.equal(globalThis[stateKey].reviewCalls.length, 1);
});

test("未完成 NDA 的成员在读取知识条目前即被拒绝", async () => {
  globalThis[stateKey].authorized = authorizedActor({ ndaCompleted: false });
  const response = await detailRoute.GET(new Request("https://oa.example.test/api/knowledge/11111111-2222-4333-8444-555555555555"), params);
  assert.equal(response.status, 403);
  assert.equal(globalThis[stateKey].findCalls, 0);
});

test("已入库知识可由审核人调整范围且公开方向要求精确二次确认", async () => {
  globalThis[stateKey].existing = existingItem({
    status: "active",
    visibility: "internal",
    active_revision_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  for (const publicConfirmation of [undefined, "", "publish_to_chat.omindos.ai ", "PUBLISH_TO_CHAT.OMINDOS.AI"]) {
    const body = { action: "set_visibility", mutationRevision: "item-mutation-1", visibility: "public" };
    if (publicConfirmation !== undefined) body.publicConfirmation = publicConfirmation;
    const response = await detailRoute.PATCH(patch(body), params);
    assert.equal(response.status, 400);
  }
  assert.equal(globalThis[stateKey].findCalls, 0);
  assert.equal(globalThis[stateKey].visibilityCalls.length, 0);

  const response = await detailRoute.PATCH(patch({
    action: "set_visibility",
    mutationRevision: "item-mutation-1",
    visibility: "public",
    publicConfirmation: "publish_to_chat.omindos.ai",
  }), params);
  assert.equal(response.status, 200);
  assert.equal(globalThis[stateKey].visibilityCalls.length, 1);
  assert.equal(globalThis[stateKey].visibilityCalls[0].visibility, "public");
  assert.equal(globalThis[stateKey].visibilityCalls[0].publicConfirmation, "publish_to_chat.omindos.ai");
});

test("范围调整仅接受 active 条目的不同目标范围且不修改审核正文", async () => {
  for (const body of [
    { action: "set_visibility", mutationRevision: "item-mutation-1" },
    { action: "set_visibility", mutationRevision: "item-mutation-1", visibility: "private" },
    { action: "set_visibility", mutationRevision: "item-mutation-1", visibility: "internal", note: "不允许" },
    { action: "set_visibility", mutationRevision: "item-mutation-1", visibility: "internal", publicConfirmation: "publish_to_chat.omindos.ai" },
  ]) {
    assert.equal((await detailRoute.PATCH(patch(body), params)).status, 400);
  }
  assert.equal(globalThis[stateKey].findCalls, 0);

  globalThis[stateKey].existing = existingItem({ status: "pending", visibility: "internal" });
  assert.equal((await detailRoute.PATCH(patch({
    action: "set_visibility",
    mutationRevision: "item-mutation-1",
    visibility: "public",
    publicConfirmation: "publish_to_chat.omindos.ai",
  }), params)).status, 409);

  globalThis[stateKey].existing = existingItem({
    status: "active",
    visibility: "internal",
    active_revision_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  assert.equal((await detailRoute.PATCH(patch({
    action: "set_visibility",
    mutationRevision: "item-mutation-1",
    visibility: "internal",
  }), params)).status, 409);
  assert.equal(globalThis[stateKey].visibilityCalls.length, 0);
});

test("范围调整保留并发、审核权限和禁止自我管理保护", async () => {
  globalThis[stateKey].existing = existingItem({
    status: "active",
    visibility: "public",
    active_revision_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  assert.equal((await detailRoute.PATCH(patch({
    action: "set_visibility",
    mutationRevision: "stale",
    visibility: "internal",
  }), params)).status, 409);

  globalThis[stateKey].authorized = authorizedActor({ role: "member", canReviewKnowledge: false });
  assert.equal((await detailRoute.PATCH(patch({
    action: "set_visibility",
    mutationRevision: "item-mutation-1",
    visibility: "internal",
  }), params)).status, 403);

  globalThis[stateKey].authorized = authorizedActor();
  globalThis[stateKey].existing = existingItem({
    status: "active",
    visibility: "public",
    active_revision_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    submitter_member_id: "member-review",
    submitter_email: "review@example.com",
  });
  assert.equal((await detailRoute.PATCH(patch({
    action: "set_visibility",
    mutationRevision: "item-mutation-1",
    visibility: "internal",
  }), params)).status, 403);
  assert.equal(globalThis[stateKey].visibilityCalls.length, 0);

  globalThis[stateKey].authorized = authorizedActor({ isAdmin: true });
  assert.equal((await detailRoute.PATCH(patch({
    action: "set_visibility",
    mutationRevision: "item-mutation-1",
    visibility: "internal",
  }), params)).status, 200);
  assert.equal(globalThis[stateKey].visibilityCalls.length, 1);
  assert.equal(globalThis[stateKey].visibilityCalls[0].actor.isAdmin, true);
});
