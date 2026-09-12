import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.mjs";
import { handleRequest } from "../src/app.mjs";
import {
  createPasswordRecord,
  encryptSecret,
} from "../src/crypto.mjs";
import { WORKERS_AI_MODEL } from "../src/constants.mjs";
import { MockD1, mockAssets } from "./contract-mock-d1.mjs";

const ORIGIN = "https://chat.omindos.ai";
const OA_URL = "https://oa.omindos.ai/api/public/lab-ai/retrieve";
const SERVICE_TOKEN = "A".repeat(43);
const RELEASE_ID = `${"a".repeat(40)}-1`;
const ENCRYPTION_KEY = "encryption-key-for-tests-only-0123456789abcdef";
const RATE_LIMIT_HMAC_KEY = "rate-limit-key-for-tests-only-0123456789abcdef";

const OA_CHUNKS = Object.freeze([
  {
    id: "1",
    title: "ARTS Robotics 公开研究方向",
    category: "research",
    sectionTitle: "研究方向",
    paragraphRef: "第 1 段",
    excerpt: "经 OA 审核公开的资料包括机器人灵巧操作与机器人系统设计。",
    sourceLabel: "OA 公开知识",
    updatedAt: "2026-09-11",
  },
]);

function oaRuntime(chunks = OA_CHUNKS, externalFetch = null) {
  return {
    async fetch(url, init) {
      if (String(url) === OA_URL) {
        return Response.json({ chunks }, { headers: { "Content-Type": "application/json" } });
      }
      if (externalFetch) return externalFetch(url, init);
      throw new Error(`Unexpected external fetch: ${url}`);
    },
  };
}

function environment(overrides = {}) {
  return {
    APP_ORIGIN: ORIGIN,
    ADMIN_EMAIL: "owner@example.com",
    APP_ENCRYPTION_KEY: ENCRYPTION_KEY,
    RATE_LIMIT_HMAC_KEY,
    PUBLIC_LAB_AI_SERVICE_TOKEN: SERVICE_TOKEN,
    RELEASE_ID,
    DB: new MockD1(),
    ASSETS: mockAssets(),
    ...overrides,
  };
}

function request(path, { method = "GET", body, cookie, origin = ORIGIN, ip = "203.0.113.9" } = {}) {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (origin !== null) headers.set("Origin", origin);
  if (cookie) headers.set("Cookie", cookie);
  if (ip) headers.set("CF-Connecting-IP", ip);
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function chatBody(question, messages = null) {
  return {
    topic: "research",
    messages: messages ?? [{ role: "user", content: question }],
  };
}

async function body(response) {
  return response.json();
}

async function bailianDatabase() {
  const encryptedKey = await encryptSecret("test-bailian-api-key", ENCRYPTION_KEY);
  return new MockD1({
    settings: {
      model: JSON.stringify({
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-plus",
        encryptedKey,
        verifiedAt: "2026-09-11T00:00:00.000Z",
      }),
    },
  });
}

async function login(env, password) {
  const response = await handleRequest(
    request("/api/auth/login", { method: "POST", body: { password } }),
    env,
    {},
    oaRuntime(),
  );
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  return { response, cookie };
}

test("Workers AI is the zero-secret default and status reports the active model", async () => {
  const calls = [];
  const env = environment({
    AI: {
      async run(model, input) {
        calls.push({ model, input });
        return { response: "根据公开资料，研究方向包括机器人灵巧操作。[1]" };
      },
    },
  });

  const statusResponse = await handleRequest(request("/api/status", { origin: null }), env, {});
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await body(statusResponse), {
    storageReady: true,
    modelReady: true,
    provider: "workers-ai",
    model: WORKERS_AI_MODEL,
  });

  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向有哪些？") }),
    env,
    {},
    oaRuntime(),
  );
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.equal(result.mode, "ai");
  assert.equal(result.provider, "workers-ai");
  assert.ok(result.sources.length > 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, WORKERS_AI_MODEL);
  assert.equal(calls[0].input.stream, false);
});

test("OA Service Binding is preferred and preserves the hardened request", async () => {
  const serviceCalls = [];
  let globalFetchCalls = 0;
  const env = environment({
    OA_SERVICE: {
      async fetch(boundRequest) {
        serviceCalls.push(boundRequest.clone());
        return Response.json({ chunks: OA_CHUNKS }, { headers: { "Content-Type": "application/json" } });
      },
    },
    AI: {
      async run() {
        return { response: "根据公开资料，研究方向包括机器人灵巧操作。[1]" };
      },
    },
  });
  const runtime = {
    async fetch() {
      globalFetchCalls += 1;
      throw new Error("The global OA fetch fallback must not run when OA_SERVICE is bound");
    },
  };
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向有哪些？") }),
    env,
    {},
    runtime,
  );
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.equal(result.mode, "ai");
  assert.equal(result.oaPublicStatus, "connected");
  assert.equal(result.sources.length, 1);
  assert.equal(globalFetchCalls, 0);
  assert.equal(serviceCalls.length, 1);
  const boundRequest = serviceCalls[0];
  assert.equal(boundRequest.url, OA_URL);
  assert.equal(boundRequest.method, "POST");
  assert.equal(boundRequest.redirect, "manual");
  assert.equal(boundRequest.cache, "no-store");
  assert.equal(boundRequest.credentials, "omit");
  assert.equal(boundRequest.headers.get("content-type"), "application/json");
  assert.equal(boundRequest.headers.get("x-originmind-public-lab-ai-service-token"), SERVICE_TOKEN);
  assert.deepEqual(await boundRequest.json(), { question: "机器人研究方向有哪些?" });
});

test("OA Service Binding rejects redirects without invoking the model", async () => {
  let serviceCalls = 0;
  let globalFetchCalls = 0;
  let aiCalls = 0;
  const env = environment({
    OA_SERVICE: {
      async fetch(boundRequest) {
        serviceCalls += 1;
        assert.equal(boundRequest.redirect, "manual");
        return Response.redirect("https://invalid.example/redirected", 302);
      },
    },
    AI: {
      async run() {
        aiCalls += 1;
        return { response: "不应调用" };
      },
    },
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    {
      async fetch() {
        globalFetchCalls += 1;
        throw new Error("The redirect must not be followed through global fetch");
      },
    },
  );
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.equal(result.mode, "retrieval");
  assert.equal(result.oaPublicStatus, "unavailable");
  assert.deepEqual(result.sources, []);
  assert.equal(serviceCalls, 1);
  assert.equal(globalFetchCalls, 0);
  assert.equal(aiCalls, 0);
});

test("no matching documents means retrieval mode and no model invocation", async () => {
  let aiCalls = 0;
  const env = environment({
    AI: {
      async run() {
        aiCalls += 1;
        return { response: "不应调用" };
      },
    },
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("火星天气和土豆配方") }),
    env,
    {},
    oaRuntime([]),
  );
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.equal(result.mode, "retrieval");
  assert.equal(result.oaPublicStatus, "connected");
  assert.deepEqual(result.sources, []);
  assert.equal(aiCalls, 0);
});

test("client-supplied assistant turns never enter the model prompt", async () => {
  const calls = [];
  const env = environment({
    AI: {
      async run(model, input) {
        calls.push({ model, input });
        return { response: "回答" };
      },
    },
  });
  const sentinel = "CLIENT_ASSISTANT_SENTINEL_DO_NOT_FORWARD";
  const response = await handleRequest(
    request("/api/chat", {
      method: "POST",
      body: chatBody("机器人研究", [
        { role: "user", content: "机器人研究方向" },
        { role: "assistant", content: sentinel },
        { role: "user", content: "请继续说明机器人研究" },
      ]),
    }),
    env,
    {},
    oaRuntime(),
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0].input).includes(sentinel), false);
  assert.equal(calls[0].input.messages.some((turn) => turn.role === "assistant"), false);
});

test("OA Service Binding failure fails closed without retrying the public network", async () => {
  let serviceCalls = 0;
  let globalFetchCalls = 0;
  let aiCalls = 0;
  const env = environment({
    OA_SERVICE: {
      async fetch() {
        serviceCalls += 1;
        throw new Error("bound OA unavailable");
      },
    },
    AI: {
      async run() {
        aiCalls += 1;
        return { response: "不应调用" };
      },
    },
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    {
      async fetch() {
        globalFetchCalls += 1;
        return Response.json({ chunks: OA_CHUNKS });
      },
    },
  );
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.equal(result.mode, "retrieval");
  assert.equal(result.oaPublicStatus, "unavailable");
  assert.deepEqual(result.sources, []);
  assert.equal(serviceCalls, 1);
  assert.equal(globalFetchCalls, 0);
  assert.equal(aiCalls, 0);
});

test("OA outage fails closed without local knowledge or model invocation", async () => {
  const aiCalls = [];
  const fetchCalls = [];
  const env = environment({
    PUBLIC_LAB_AI_SERVICE_TOKEN: "A".repeat(43),
    AI: {
      async run(model, input) {
        aiCalls.push({ model, input });
        return { response: "不应调用" };
      },
    },
  });
  const runtime = {
    async fetch(url, init) {
      fetchCalls.push({ url: String(url), init });
      return new Response("unavailable", { status: 503 });
    },
  };
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    runtime,
  );
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.equal(result.mode, "retrieval");
  assert.equal(result.oaPublicStatus, "unavailable");
  assert.deepEqual(result.sources, []);
  assert.equal(aiCalls.length, 0);
  assert.equal(fetchCalls.length, 1);
});

test("a verified Bailian configuration overrides Workers AI and forbids redirects", async () => {
  const database = await bailianDatabase();
  let workersAiCalls = 0;
  const fetchCalls = [];
  const env = environment({
    DB: database,
    AI: {
      async run() {
        workersAiCalls += 1;
        return { response: "不应调用" };
      },
    },
  });
  const runtime = oaRuntime(OA_CHUNKS, async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return Response.json({ choices: [{ message: { role: "assistant", content: "百炼回答。[1]" } }] });
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    runtime,
  );
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.equal(result.mode, "ai");
  assert.equal(result.provider, "bailian");
  assert.equal(result.answer, "百炼回答。[1]");
  assert.equal(workersAiCalls, 0);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].init.redirect, "manual");
  assert.equal(JSON.parse(fetchCalls[0].init.body).stream, false);
});

test("Bailian rejects redirect responses without following them", async () => {
  const env = environment({ DB: await bailianDatabase() });
  let externalCalls = 0;
  const runtime = oaRuntime(OA_CHUNKS, async (_url, init) => {
    externalCalls += 1;
    assert.equal(init.redirect, "manual");
    return Response.redirect("https://invalid.example/redirected", 302);
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    runtime,
  );
  assert.equal(response.status, 502);
  assert.equal(externalCalls, 1);
});

test("Bailian rejects non-JSON responses", async () => {
  const env = environment({ DB: await bailianDatabase() });
  const runtime = oaRuntime(OA_CHUNKS, async () => {
      return new Response("<html>not JSON</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    runtime,
  );
  assert.equal(response.status, 502);
});

test("Bailian rejects chunked JSON bodies larger than 256 KiB", async () => {
  const env = environment({ DB: await bailianDatabase() });
  const hugeJson = JSON.stringify({ choices: [{ message: { content: "大".repeat(270 * 1024) } }] });
  const encoded = new TextEncoder().encode(hugeJson);
  const stream = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < encoded.length; offset += 32 * 1024) {
        controller.enqueue(encoded.slice(offset, offset + 32 * 1024));
      }
      controller.close();
    },
  });
  const runtime = oaRuntime(OA_CHUNKS, async () => {
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    runtime,
  );
  assert.equal(response.status, 502);
});

test("rate-limit identifiers depend on RATE_LIMIT_HMAC_KEY, not the encryption key", async () => {
  const firstDb = new MockD1();
  const secondDb = new MockD1();
  const first = environment({ DB: firstDb, APP_ENCRYPTION_KEY: "A".repeat(48) });
  const second = environment({ DB: secondDb, APP_ENCRYPTION_KEY: "B".repeat(48) });
  const input = { method: "POST", body: chatBody("火星天气和土豆配方"), ip: "2001:db8::7" };
  const firstResponse = await handleRequest(request("/api/chat", input), first, {}, oaRuntime([]));
  const secondResponse = await handleRequest(request("/api/chat", input), second, {}, oaRuntime([]));
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  const firstKey = firstDb.limitKey("chat:");
  const secondKey = secondDb.limitKey("chat:");
  assert.ok(firstKey);
  assert.equal(firstKey, secondKey);
});

test("global daily budget blocks the 301st model call with its dedicated response", async () => {
  const day = new Date().toISOString().slice(0, 10);
  const database = new MockD1({ limits: { [`model-day:${day}`]: 300 } });
  let aiCalls = 0;
  const env = environment({
    DB: database,
    AI: {
      async run() {
        aiCalls += 1;
        return { response: "不应调用" };
      },
    },
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    oaRuntime(),
  );
  const result = await body(response);
  assert.equal(response.status, 429);
  assert.equal(result.error, "今日 AI 咨询额度已用完，请稍后再试。");
  assert.equal(aiCalls, 0);
});

test("admin authentication is same-origin, cookie-based, and required for admin APIs", async () => {
  const password = "correct horse battery staple";
  const database = new MockD1({ adminAccount: await createPasswordRecord(password) });
  const env = environment({ DB: database });

  const anonymous = await handleRequest(request("/api/admin/config", { origin: null }), env, {});
  assert.equal(anonymous.status, 403);

  const crossOrigin = await handleRequest(
    request("/api/auth/login", { method: "POST", body: { password }, origin: "https://evil.example" }),
    env,
    {},
    oaRuntime([]),
  );
  assert.equal(crossOrigin.status, 403);

  const { response: loginResponse, cookie } = await login(env, password);
  assert.equal(loginResponse.status, 200);
  assert.ok(cookie?.startsWith("__Host-ma-session="));
  assert.match(loginResponse.headers.get("set-cookie"), /Secure; HttpOnly; SameSite=Strict/u);

  const status = await handleRequest(request("/api/auth/status", { cookie, origin: null }), env, {});
  assert.deepEqual(await body(status), { signedIn: true });
  const admin = await handleRequest(request("/api/admin/config", { cookie, origin: null }), env, {});
  assert.equal(admin.status, 200);
});

test("Chat admin documents cannot become public knowledge without OA review", async () => {
  const password = "correct horse battery staple";
  const database = new MockD1({
    adminAccount: await createPasswordRecord(password),
    documents: [{
      id: "historic-published-row",
      title: "历史错误公开行",
      body: "这条历史 published=1 的 Chat D1 资料绝不能进入公网回答。",
      url: "",
      category: "research",
      updatedAt: "2026-09-11",
      published: 1,
    }],
  });
  let aiCalls = 0;
  const env = environment({
    DB: database,
    AI: {
      async run() {
        aiCalls += 1;
        return { response: "不应调用" };
      },
    },
  });
  const { response: loginResponse, cookie } = await login(env, password);
  assert.equal(loginResponse.status, 200);

  const documentResponse = await handleRequest(
    request("/api/admin/documents", {
      method: "POST",
      cookie,
      body: {
        id: "private-only-review",
        title: "锆蓝实验 4829",
        body: "锆蓝实验 4829 是仅供内部审核的占位资料，不得直接公开。",
        url: "",
        category: "research",
        updatedAt: "2026-09-11",
        published: 1,
      },
    }),
    env,
    {},
  );
  assert.ok([200, 400, 403].includes(documentResponse.status));
  const stored = database.documents.get("private-only-review");
  assert.notEqual(stored?.published, 1);

  const publicResponse = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("锆蓝实验 4829") }),
    env,
    {},
    oaRuntime([]),
  );
  const publicResult = await body(publicResponse);
  assert.equal(publicResult.mode, "retrieval");
  assert.equal(publicResult.sources.some((source) => source.id === "private-only-review"), false);
  assert.equal(publicResult.sources.some((source) => source.id === "historic-published-row"), false);
  assert.equal(aiCalls, 0);
});

test("public health stays ready before an admin account is initialized", async () => {
  const env = environment({ DB: new MockD1({ adminAccount: null }) });
  const response = await handleRequest(request("/_health", { origin: null }), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), {
    app: "arts-robotics-ai-assistant",
    ready: true,
    releaseId: RELEASE_ID,
  });
});

test("static root, manager route and generated hashed assets are served by the ASSETS binding", async () => {
  const assets = mockAssets();
  const env = environment({ ASSETS: assets });
  for (const path of ["/", "/manage", "/assets/app-0123456789abcdef.js"]) {
    const response = await worker.fetch(request(path, { origin: null }), env, {});
    assert.equal(response.status, 200, path);
  }
  assert.deepEqual(assets.calls, ["/index.html", "/index.html", "/assets/app-0123456789abcdef.js"]);
});

test("wrong canonical host is rejected before API or static handling", async () => {
  const database = new MockD1();
  const assets = mockAssets();
  const env = environment({ DB: database, ASSETS: assets });
  for (const path of ["/", "/api/status"]) {
    const response = await worker.fetch(new Request(`https://evil.example${path}`), env, {});
    assert.equal(response.status, 421, path);
  }
  assert.deepEqual(assets.calls, []);
  assert.equal(database.statements.length, 0);
});
