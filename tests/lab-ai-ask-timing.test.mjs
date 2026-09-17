import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaLabAiAskTimingTestState";

function authorizedActor(overrides = {}) {
  return {
    user: { email: "member@example.test", displayName: "实验室成员", authProvider: "chatgpt" },
    role: "member",
    accountUserId: "account-member",
    memberId: "member-record",
    memberMutationRevision: "member-revision",
    isAdmin: false,
    ndaCompleted: true,
    ...overrides,
  };
}

function candidate() {
  return {
    id: "chunk-1",
    itemId: "item-1",
    revisionId: "revision-1",
    title: "机械臂急停复位",
    category: "安全规范",
    sourceLabel: "实验室手册",
    sourceUrl: "",
    sectionTitle: "复位",
    paragraphRef: "第 2 段",
    content: "确认安全区无人后解除急停，再由值班人员执行复位。",
    searchText: "机械臂急停复位 确认安全区无人",
    updatedAt: "2026-09-10T00:00:00.000Z",
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
    name: "lab-ai-ask-timing-test-dependencies",
    enforce: "pre",
    resolveId(source) {
      if (/\/_lib\/auth$/u.test(source)) return "\0lab-ai-ask-auth";
      if (/lib\/oa-chat-client$/u.test(source)) return "\0lab-ai-ask-client";
      if (/lib\/knowledge-store$/u.test(source)) return "\0lab-ai-ask-store";
      if (/lib\/write-rate-limit$/u.test(source)) return "\0lab-ai-ask-rate-limit";
      if (/^(?:\.\.\/)+db$/u.test(source)) return "\0lab-ai-ask-db";
      return null;
    },
    load(id) {
      if (id === "\0lab-ai-ask-auth") return `
        export async function getAuthorizedUser() {
          return globalThis.${stateKey}.authorized;
        }
      `;
      if (id === "\0lab-ai-ask-client") return `
        export async function answerOaChatQuestion(question, ranked) {
          const state = globalThis.${stateKey};
          state.answerCalls.push({ question, ranked });
          await new Promise((resolve) => setTimeout(resolve, state.answerDelayMs));
          if (state.answerError) throw new Error("model failure with private detail");
          return { mode: "grounded", answer: "复位前请先确认安全区无人。[1]", citations: [] };
        }
      `;
      if (id === "\0lab-ai-ask-store") return `
        export async function getActiveKnowledgeChunks(actor, question) {
          const state = globalThis.${stateKey};
          state.lookupCalls.push({ actor, question });
          await new Promise((resolve) => setTimeout(resolve, state.lookupDelayMs));
          if (state.lookupError) throw new Error("lookup failure with private detail");
          return state.candidates;
        }
      `;
      if (id === "\0lab-ai-ask-rate-limit") return `
        export async function consumeWriteRateLimit() {
          return globalThis.${stateKey}.rateAllowed;
        }
      `;
      if (id === "\0lab-ai-ask-db") return `
        export async function getDb() { return {}; }
      `;
      return null;
    },
  }],
});

const route = await vite.ssrLoadModule("/app/api/lab-ai/ask/route.ts");

function request(body = { question: "机械臂如何急停复位？" }, contentType = "application/json") {
  return new Request("https://oa.example.test/api/lab-ai/ask", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

function serverTimings(response) {
  const header = response.headers.get("server-timing");
  assert.ok(header, "response must include Server-Timing");
  const result = {};
  for (const metric of header.split(",")) {
    const match = /^\s*([a-z]+);dur=(\d+)\s*$/u.exec(metric);
    assert.ok(match, `invalid Server-Timing metric: ${metric}`);
    result[match[1]] = Number(match[2]);
  }
  return { header, result };
}

beforeEach(() => {
  globalThis[stateKey] = {
    authorized: authorizedActor(),
    candidates: [candidate()],
    rateAllowed: true,
    lookupDelayMs: 20,
    answerDelayMs: 25,
    lookupError: false,
    answerError: false,
    lookupCalls: [],
    answerCalls: [],
  };
});

after(async () => {
  delete globalThis[stateKey];
  await vite.close();
});

test("successful internal knowledge answers report real lookup, answer, and total waits", async () => {
  const response = await route.POST(request());
  assert.equal(response.status, 200);
  const { header, result } = serverTimings(response);
  assert.deepEqual(Object.keys(result), ["lookup", "answer", "total"]);
  assert.ok(result.lookup >= 15, `lookup duration was ${result.lookup} ms`);
  assert.ok(result.answer >= 20, `answer duration was ${result.answer} ms`);
  assert.ok(result.total + 2 >= result.lookup + result.answer);
  assert.equal(response.headers.get("timing-allow-origin"), null);
  assert.doesNotMatch(header, /机械臂|实验室成员|member@example/u);
  assert.match(response.headers.get("cache-control"), /private/u);
  assert.deepEqual(globalThis[stateKey].lookupCalls.map(({ question }) => question), ["机械臂如何急停复位?"]);
  assert.equal(globalThis[stateKey].answerCalls.length, 1);
  assert.equal(globalThis[stateKey].answerCalls[0].ranked[0].id, "chunk-1");
  assert.equal((await response.json()).mode, "grounded");
});

test("model failures retain completed stage timings without exposing private error details", async () => {
  globalThis[stateKey].lookupDelayMs = 1;
  globalThis[stateKey].answerDelayMs = 1;
  globalThis[stateKey].answerError = true;
  const response = await route.POST(request());
  assert.equal(response.status, 500);
  const { header, result } = serverTimings(response);
  assert.deepEqual(Object.keys(result), ["lookup", "answer", "total"]);
  assert.ok(result.total >= result.lookup);
  assert.ok(result.total >= result.answer);
  assert.doesNotMatch(header, /private|model|member@example/u);
  const body = await response.json();
  assert.equal(body.error, "实验室知识问答暂不可用，请稍后重试。");
});

test("lookup failures omit the unstarted answer stage and still report total", async () => {
  globalThis[stateKey].lookupDelayMs = 1;
  globalThis[stateKey].lookupError = true;
  const response = await route.POST(request());
  assert.equal(response.status, 500);
  const { result } = serverTimings(response);
  assert.deepEqual(Object.keys(result), ["lookup", "total"]);
  assert.equal(globalThis[stateKey].answerCalls.length, 0);
});

test("early authorization errors report only total timing", async () => {
  globalThis[stateKey].authorized = null;
  const response = await route.POST(request());
  assert.equal(response.status, 401);
  const { header, result } = serverTimings(response);
  assert.deepEqual(Object.keys(result), ["total"]);
  assert.doesNotMatch(header, /account|member|@/u);
  assert.equal(globalThis[stateKey].lookupCalls.length, 0);
  assert.equal(globalThis[stateKey].answerCalls.length, 0);
});
