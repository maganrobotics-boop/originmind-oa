import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaKnowledgeListQueryApiTestState";

function authorizedActor(overrides = {}) {
  return {
    user: { email: "review@example.com", displayName: "项目管理员", authProvider: "chatgpt" },
    role: "project_owner",
    accountUserId: "account-review",
    memberId: "member-review",
    memberMutationRevision: "member-revision-review",
    isAdmin: false,
    ndaCompleted: true,
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
    name: "knowledge-list-query-api-test-dependencies",
    enforce: "pre",
    resolveId(source) {
      if (/(^|\/)api\/_lib\/auth$/u.test(source) || /^(?:\.\.\/)+_lib\/auth$/u.test(source)) return "\0knowledge-list-query-auth";
      if (/lib\/knowledge-store$/u.test(source)) return "\0knowledge-list-query-store";
      if (/lib\/write-rate-limit$/u.test(source)) return "\0knowledge-list-query-rate-limit";
      if (/^(?:\.\.\/)+db$/u.test(source)) return "\0knowledge-list-query-db";
      return null;
    },
    load(id) {
      if (id === "\0knowledge-list-query-auth") return `
        export async function getAuthorizedUser() { return globalThis.${stateKey}.authorized; }
        export function isProjectOwner() { return false; }
      `;
      if (id === "\0knowledge-list-query-store") return `
        export async function listKnowledgeItems(scope, actor, canReview, options) {
          globalThis.${stateKey}.listCalls.push({ scope, actor, canReview, options });
          return [];
        }
        export async function countPendingKnowledgeItems() { return 0; }
        export async function createKnowledgeItem() { throw new Error("not used"); }
      `;
      if (id === "\0knowledge-list-query-rate-limit") return `
        export async function consumeWriteRateLimit() { return true; }
      `;
      if (id === "\0knowledge-list-query-db") return `
        export async function getDb() { return {}; }
      `;
      return null;
    },
  }],
});

const route = await vite.ssrLoadModule("/app/api/knowledge/route.ts");

function get(path) {
  return route.GET(new Request(`https://oa.example.test${path}`));
}

beforeEach(() => {
  globalThis[stateKey] = {
    authorized: authorizedActor(),
    listCalls: [],
  };
});

after(async () => {
  delete globalThis[stateKey];
  await vite.close();
});

test("审核者的管理查询会规范化 q 并把白名单排序传入 store", async () => {
  const response = await get("/api/knowledge?scope=all&q=%20%E6%80%A5%E5%81%9C%20&sort=title_asc");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(globalThis[stateKey].listCalls.length, 1);
  assert.deepEqual(globalThis[stateKey].listCalls[0].options, { query: "急停", sort: "title_asc" });
  assert.equal(globalThis[stateKey].listCalls[0].scope, "all");
  assert.equal(globalThis[stateKey].listCalls[0].canReview, true);
});

test("无查询参数调用保持兼容，不向 store 注入默认排序", async () => {
  const response = await get("/api/knowledge?scope=all");
  assert.equal(response.status, 200);
  assert.equal(globalThis[stateKey].listCalls.length, 1);
  assert.equal(globalThis[stateKey].listCalls[0].options, undefined);
});

test("API 拒绝超长关键词和非白名单排序", async () => {
  const tooLong = encodeURIComponent("知".repeat(101));
  assert.equal((await get(`/api/knowledge?scope=all&q=${tooLong}`)).status, 400);
  assert.equal((await get("/api/knowledge?scope=all&sort=updated_desc%20DROP%20TABLE")).status, 400);
  assert.equal(globalThis[stateKey].listCalls.length, 0);

  const exactlyOneHundredEmoji = encodeURIComponent("🤖".repeat(100));
  assert.equal((await get(`/api/knowledge?scope=all&q=${exactlyOneHundredEmoji}`)).status, 200);
  assert.equal(globalThis[stateKey].listCalls.length, 1, "limit must count Unicode code points rather than UTF-16 units");
});

test("搜索排序参数只对审核者的 scope=all 开放", async () => {
  assert.equal((await get("/api/knowledge?scope=mine&sort=updated_desc")).status, 400);
  assert.equal(globalThis[stateKey].listCalls.length, 0);

  globalThis[stateKey].authorized = authorizedActor({ role: "member" });
  assert.equal((await get("/api/knowledge?scope=all&q=%E6%80%A5%E5%81%9C")).status, 403);
  assert.equal(globalThis[stateKey].listCalls.length, 0);
});
