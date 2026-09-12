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
      if (id === "\0chat-import-rate") return `export async function consumeWriteRateLimit() { return globalThis.${stateKey}.allowed; }`;
      if (id === "\0chat-import-store") return `export async function createChatImportedKnowledgeItem(actor, submission, hash, id) {
        globalThis.${stateKey}.writes.push({actor,submission,hash,id});
        return {id,title:submission.title,status:'pending',visibility:'internal'};
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
beforeEach(() => {
  globalThis[stateKey] = { allowed: true, writes: [], authorized: {
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

test("an admitted OA session submits pending internal items using the real OA identity", async () => {
  const response = await route.POST(request());
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.items[0].status, "pending");
  assert.equal(result.items[0].visibility, "internal");
  assert.equal(globalThis[stateKey].writes[0].actor.accountUserId, "oa-account-id");
  assert.equal(result.items[0].submitterEmail, undefined);
});

test("client approval and identity injection and rate-limited imports cannot create items", async () => {
  assert.equal((await route.POST(request({ document: { ...document, status: "active" } }))).status, 400);
  assert.equal((await route.POST(request({ document, accountUserId: "other" }))).status, 400);
  globalThis[stateKey].allowed = false;
  assert.equal((await route.POST(request())).status, 429);
  assert.equal(globalThis[stateKey].writes.length, 0);
});
