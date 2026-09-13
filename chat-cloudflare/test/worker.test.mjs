import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { handleRequest } from "../src/app.mjs";
import { WORKERS_AI_MODEL } from "../src/constants.mjs";
import { encryptSecret, sha256Hex } from "../src/crypto.mjs";
import { D1DatabaseAdapter } from "./d1-adapter.mjs";

const ORIGIN = "https://chat.omindos.ai";
const SERVICE_TOKEN = "A".repeat(43);
const RELEASE_ID = `${"a".repeat(40)}-1`;

function emptyOaResponse() {
  return Response.json({ chunks: [] }, { headers: { "Content-Type": "application/json" } });
}

function oaResponse() {
  return Response.json({
    chunks: [{
      id: "1",
      title: "ARTS Robotics 公开研究方向",
      category: "research",
      sectionTitle: "研究方向",
      paragraphRef: "第 1 段",
      excerpt: "经 OA 审核公开的资料包括机器人灵巧操作与机器人系统设计。",
      sourceLabel: "OA 公开知识",
      updatedAt: "2026-09-11",
    }],
  }, { headers: { "Content-Type": "application/json" } });
}

function makeEnvironment(overrides = {}) {
  return {
    DB: new D1DatabaseAdapter(),
    AI: { run: async () => ({ choices: [{ message: { role: "assistant", content: "AI 回答" } }] }) },
    APP_ORIGIN: ORIGIN,
    ADMIN_EMAIL: "owner@example.test",
    APP_ENCRYPTION_KEY: "encryption-key-".padEnd(48, "e"),
    RATE_LIMIT_HMAC_KEY: "rate-limit-key-".padEnd(48, "r"),
    PUBLIC_LAB_AI_SERVICE_TOKEN: SERVICE_TOKEN,
    RELEASE_ID,
    ...overrides,
  };
}

function runtime(fetch = async (url) => String(url).endsWith("/api/public/lab-ai/status")
  ? Response.json({ oaReady: true, publicKnowledgeReady: true, retrievalReady: true })
  : oaResponse()) {
  return { fetch };
}

function apiRequest(path, { method = "GET", body, cookie, origin = ORIGIN, ip = "203.0.113.8" } = {}) {
  const headers = new Headers({ "CF-Connecting-IP": ip });
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    headers.set("Origin", origin);
  }
  if (cookie) headers.set("Cookie", cookie);
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function uploadRequest(name, mimeType, bytes, {
  cookie,
  origin = ORIGIN,
  ip = "203.0.113.8",
} = {}) {
  const headers = new Headers({
    "CF-Connecting-IP": ip,
    "Content-Type": mimeType,
    "Origin": origin,
    "X-File-Name": encodeURIComponent(name),
  });
  if (cookie) headers.set("Cookie", cookie);
  return new Request(`${ORIGIN}/api/admin/extract`, {
    method: "POST",
    headers,
    body: bytes,
  });
}

function pdfBytes() {
  return new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\nstartxref\n0\n%%EOF\n");
}

async function responseJson(response) {
  return { status: response.status, body: await response.json() };
}

async function storeVerifiedBailianConfig(env, credential = "test-key-not-a-real-secret") {
  const value = {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    encryptedKey: await encryptSecret(credential, env.APP_ENCRYPTION_KEY),
    verifiedAt: "2026-09-11T00:00:00.000Z",
  };
  await env.DB.prepare("INSERT INTO settings(id,value) VALUES (?,?)").bind("model", JSON.stringify(value)).run();
}

test("Worker source contains no Tencent/Node runtime shell", () => {
  const sources = readdirSync(new URL("../src/", import.meta.url))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8"))
    .join("\n");
  assert.doesNotMatch(sources, /from ["']node:/u);
  assert.doesNotMatch(sources, /\b(?:createServer|DatabaseSync|AsyncLocalStorage|systemd|nginx)\b/u);
  assert.doesNotMatch(sources, /\b(?:process|Buffer)\./u);
});

test("health reports D1 service readiness without leaking or requiring an admin row", async (t) => {
  const env = makeEnvironment();
  t.after(() => env.DB.close());
  const result = await responseJson(await handleRequest(apiRequest("/_health"), env, {}, runtime()));
  assert.deepEqual(result, {
    status: 200,
    body: { app: "arts-robotics-ai-assistant", ready: true, releaseId: RELEASE_ID },
  });
  assert.equal(Object.hasOwn(result.body, "adminReady"), false);
});

test("status marks Workers AI as the default ready provider without a Bailian key", async (t) => {
  let aiCalls = 0;
  let oaCalls = 0;
  const env = makeEnvironment({
    AI: { run: async () => {
      aiCalls += 1;
      return { choices: [{ message: { role: "assistant", content: "连接成功" } }] };
    } },
  });
  t.after(() => env.DB.close());
  const statusRuntime = runtime(async (url) => {
    if (String(url).endsWith("/api/public/lab-ai/status")) {
      oaCalls += 1;
      return Response.json({ oaReady: true, publicKnowledgeReady: true, retrievalReady: true });
    }
    return oaResponse();
  });
  const result = await responseJson(await handleRequest(apiRequest("/api/status"), env, {}, statusRuntime));
  assert.deepEqual(result, {
    status: 200,
    body: {
      storageReady: true,
      modelReady: true,
      qwenReady: true,
      modelPending: false,
      oaReady: true,
      knowledgeReady: true,
      retrievalReady: true,
      oaPending: false,
      budgetReady: true,
      systemReady: true,
      documentParsingReady: false,
      provider: "workers-ai",
      model: WORKERS_AI_MODEL,
    },
  });
  const cached = await responseJson(await handleRequest(apiRequest("/api/status"), env, {}, statusRuntime));
  assert.deepEqual(cached, result);
  assert.equal(aiCalls, 1);
  assert.equal(oaCalls, 1);
});

test("auth preserves public error status without exposing unknown failures", async (t) => {
  const env = makeEnvironment();
  t.after(() => env.DB.close());
  const crossOrigin = apiRequest("/api/auth/login", {
    method: "POST",
    origin: "https://attacker.example",
    body: { password: "incorrect-password" },
  });
  const forbidden = await responseJson(await handleRequest(crossOrigin, env, {}, runtime()));
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.body.error, /本站页面/u);

  const noAdmin = apiRequest("/api/auth/login", {
    method: "POST",
    body: { password: "incorrect-password" },
  });
  const unavailable = await responseJson(await handleRequest(noAdmin, env, {}, runtime()));
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.body.error, /尚未设置/u);
});

test("zero retrieved documents returns retrieval fallback and never invokes a model", async (t) => {
  let calls = 0;
  const env = makeEnvironment({ AI: { run: async () => { calls += 1; throw new Error("must not run"); } } });
  t.after(() => env.DB.close());
  const request = apiRequest("/api/chat", {
    method: "POST",
    body: { messages: [{ role: "user", content: "zzzz-no-match" }], topic: "research" },
  });
  const result = await responseJson(await handleRequest(request, env, {}, runtime(async () => emptyOaResponse())));
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, "retrieval");
  assert.equal(result.body.sources.length, 0);
  assert.equal(calls, 0);
});

test("Workers AI gets only two bounded user turns and never client assistant text", async (t) => {
  let captured;
  const env = makeEnvironment({
    AI: {
      run: async (model, input) => {
        captured = { model, input };
        return {
          choices: [{
            message: {
              role: "assistant",
              content: "根据公开资料显示，团队主要研究机器人灵巧操作。[1]\n\n参考资料：\n[1] 公开知识",
            },
          }],
        };
      },
    },
  });
  t.after(() => env.DB.close());
  const request = apiRequest("/api/chat", {
    method: "POST",
    body: {
      messages: [
        { role: "user", content: "研".repeat(12_000) },
        { role: "assistant", content: "CLIENT_ASSISTANT_MUST_NOT_REACH_MODEL" },
        { role: "user", content: "研究方向是什么？" },
      ],
      topic: "research",
    },
  });
  const result = await responseJson(await handleRequest(request, env, {}, runtime()));
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, "ai");
  assert.equal(result.body.provider, "workers-ai");
  assert.equal(result.body.answer, "团队主要研究机器人灵巧操作。");
  assert.equal(captured.model, WORKERS_AI_MODEL);
  assert.equal(captured.input.stream, false);
  const nonSystem = captured.input.messages.slice(1);
  assert.ok(nonSystem.length <= 2);
  assert.ok(nonSystem.every((message) => message.role === "user"));
  assert.ok(nonSystem.reduce((sum, message) => sum + message.content.length, 0) <= 3_000);
  assert.doesNotMatch(JSON.stringify(captured.input), /CLIENT_ASSISTANT_MUST_NOT_REACH_MODEL/u);
  assert.match(captured.input.messages[0].content, /先直接回答问题/u);
  assert.match(captured.input.messages[0].content, /不要单列“参考资料”/u);
  const daily = await env.DB.prepare("SELECT count FROM limits WHERE key LIKE 'model-day:%'").first();
  assert.equal(Number(daily.count), 1);
});

test("user-visible answers remove citation markers and formatted reference sections", async () => {
  const examples = [
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n**参考资料**\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1] 参考资料：[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n### 参考来源\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\nReferences:\n[1] OA public knowledge",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "第一项是机器人灵巧操作[1]。第二项是系统设计。[1]",
      expected: "第一项是机器人灵巧操作。第二项是系统设计。",
    },
    {
      output: "机器人灵巧操作。[1，1] 系统设计。【１—１】",
      expected: "机器人灵巧操作。 系统设计。",
    },
    {
      output: "根据资料不足，我们建议先补充问题背景。[1]",
      expected: "根据资料不足，我们建议先补充问题背景。",
    },
    {
      output: "据资料库记录，团队研究机器人灵巧操作。[1]",
      expected: "据资料库记录，团队研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n- **参考资料**\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n1. 参考资料：\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n参考资料列表：\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n参考资料如下所示：\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n> 参考资料\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "Team focuses on robotic manipulation.[1]\n\nBibliography:\n[1] OA public knowledge",
      expected: "Team focuses on robotic manipulation.",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n参考：\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n出处：\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "Team focuses on robotic manipulation.[1]\n\nCitation:\n[1] OA public knowledge",
      expected: "Team focuses on robotic manipulation.",
    },
    {
      output: "Team focuses on robotic manipulation.[1]\n\nSources [1] OA public knowledge",
      expected: "Team focuses on robotic manipulation.",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n[1] OA 公开知识\n[1] 第二条公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n• [1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "Available Resources: robotics lab and test platform.[1]",
      expected: "Available Resources: robotics lab and test platform.",
    },
    {
      output: "Preference: concise answers.[1]",
      expected: "Preference: concise answers.",
    },
    {
      output: "The project is open-source: selected components are public.[1]",
      expected: "The project is open-source: selected components are public.",
    },
  ];

  for (const example of examples) {
    const env = makeEnvironment({
      AI: { run: async () => ({ choices: [{ message: { role: "assistant", content: example.output } }] }) },
    });
    try {
      const request = apiRequest("/api/chat", {
        method: "POST",
        body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
      });
      const result = await responseJson(await handleRequest(request, env, {}, runtime()));
      assert.equal(result.status, 200);
      assert.equal(result.body.mode, "ai");
      assert.equal(result.body.answer, example.expected);
    } finally {
      env.DB.close();
    }
  }
});

test("uncited or residual citation-shaped model output fails closed", async () => {
  for (const output of [
    "团队主要研究机器人灵巧操作。",
    "团队主要研究机器人灵巧操作。[1] 同时保留嵌套编号[[1]]",
    "团队主要研究机器人灵巧操作。[1] 同时保留异常编号[1/2]",
    "团队主要研究机器人灵巧操作。[1] 可参考资料：[1] OA 公开知识",
    "团队主要研究机器人灵巧操作。[1] 可查看**参考资料**：[1] OA 公开知识",
  ]) {
    const env = makeEnvironment({
      AI: { run: async () => ({ choices: [{ message: { role: "assistant", content: output } }] }) },
    });
    try {
      const request = apiRequest("/api/chat", {
        method: "POST",
        body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
      });
      const result = await responseJson(await handleRequest(request, env, {}, runtime()));
      assert.equal(result.status, 200);
      assert.equal(result.body.mode, "retrieval");
      assert.doesNotMatch(result.body.answer, /\[\[\s*\d+\s*\]\]|[［【]\s*\d+\s*[］】]|参考(?:资料|文献|来源)/u);
    } finally {
      env.DB.close();
    }
  }
});

test("unsafe or uncited model output is discarded before it reaches the browser", async (t) => {
  const unsafe = "请访问 https://example.test 或联系 test@example.test [1]";
  const env = makeEnvironment({
    AI: { run: async () => ({ choices: [{ message: { role: "assistant", content: unsafe } }] }) },
  });
  t.after(() => env.DB.close());
  const request = apiRequest("/api/chat", {
    method: "POST",
    body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
  });
  const result = await responseJson(await handleRequest(request, env, {}, runtime()));
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, "retrieval");
  assert.doesNotMatch(result.body.answer, /example\.test/u);
  assert.doesNotMatch(result.body.answer, /\[\d+\]|参考(?:资料|文献)|资料来源/u);
  assert.ok(result.body.sources.length > 0);
});

test("verified Bailian config overrides Workers AI and uses hardened fetch options", async (t) => {
  let workersCalls = 0;
  let modelFetch;
  const env = makeEnvironment({ AI: { run: async () => { workersCalls += 1; } } });
  t.after(() => env.DB.close());
  await storeVerifiedBailianConfig(env);
  const externalFetch = async (url, init) => {
    if (url === "https://oa.omindos.ai/api/public/lab-ai/retrieve") return oaResponse();
    modelFetch = { url, init };
    return Response.json({ choices: [{ message: { role: "assistant", content: "百炼回答 [1]" } }] });
  };
  const request = apiRequest("/api/chat", {
    method: "POST",
    body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
  });
  const result = await responseJson(await handleRequest(request, env, {}, runtime(externalFetch)));
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, "ai");
  assert.equal(result.body.provider, "bailian");
  assert.equal(result.body.answer, "百炼回答");
  assert.equal(workersCalls, 0);
  assert.equal(modelFetch.init.redirect, "manual");
  assert.equal(modelFetch.init.cache, "no-store");
  assert.equal(modelFetch.init.credentials, "omit");
  assert.equal(JSON.parse(modelFetch.init.body).stream, false);
});

test("Bailian rejects a chunked JSON response larger than 256 KiB", async (t) => {
  const env = makeEnvironment({ AI: undefined });
  t.after(() => env.DB.close());
  await storeVerifiedBailianConfig(env);
  const externalFetch = async (url) => {
    if (url === "https://oa.omindos.ai/api/public/lab-ai/retrieve") return oaResponse();
    const first = new Uint8Array(200 * 1024).fill(0x20);
    const second = new Uint8Array(60 * 1024).fill(0x20);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  };
  const request = apiRequest("/api/chat", {
    method: "POST",
    body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
  });
  const result = await responseJson(await handleRequest(request, env, {}, runtime(externalFetch)));
  assert.equal(result.status, 502);
  assert.match(result.body.error, /模型服务暂时不可用/u);
});

test("Chat admin cannot publish documents directly", async (t) => {
  const env = makeEnvironment();
  t.after(() => env.DB.close());
  const token = "f".repeat(64);
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();
  const request = apiRequest("/api/admin/documents", {
    method: "POST",
    cookie: `__Host-ma-session=${token}`,
    body: {
      title: "待审核资料",
      body: "这是一段仍需通过 OA 审核的资料正文。",
      url: "",
      category: "research",
      updatedAt: "2026-09-11",
      published: 1,
    },
  });
  const result = await responseJson(await handleRequest(request, env, {}, runtime()));
  assert.equal(result.status, 400);
  assert.match(result.body.error, /OA 审核/u);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM documents").first();
  assert.equal(Number(count.n), 0);
});

test("Chat admin can transiently extract a PDF without storing the original file", async (t) => {
  let captured;
  const env = makeEnvironment({
    AI: {
      async run() {
        throw new Error("text generation must not run");
      },
      async toMarkdown(document, options) {
        captured = { document, options };
        return {
          id: "conversion-1",
          name: document.name,
          mimeType: document.blob.type,
          format: "markdown",
          tokens: 32,
          data: "# 自动识别结果\n\nPDF 中的中文正文已经成功提取。",
        };
      },
    },
  });
  t.after(() => env.DB.close());
  const token = "e".repeat(64);
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();

  const result = await responseJson(await handleRequest(
    uploadRequest("研究报告.pdf", "application/pdf", pdfBytes(), {
      cookie: `__Host-ma-session=${token}`,
    }),
    env,
    {},
    runtime(),
  ));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    text: "# 自动识别结果\n\nPDF 中的中文正文已经成功提取。",
    fileName: "研究报告.pdf",
    mimeType: "application/pdf",
    characters: 27,
    tokens: 32,
    originalStored: false,
  });
  assert.equal(captured.document.name, "研究报告.pdf");
  assert.equal(captured.document.blob.type, "application/pdf");
  assert.equal(captured.options.conversionOptions.output.format, "markdown");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM documents").first()).n, 0);
});

test("file extraction accepts a valid long Chinese filename after header decoding", async (t) => {
  const env = makeEnvironment({
    AI: {
      async toMarkdown() {
        return { format: "markdown", tokens: 3, data: "这是一段由长文件名资料自动识别出的正文。" };
      },
    },
  });
  t.after(() => env.DB.close());
  const token = "b".repeat(64);
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();

  const fileName = `${"研".repeat(67)}.pdf`;
  assert.ok(encodeURIComponent(fileName).length > 600);
  const result = await responseJson(await handleRequest(
    uploadRequest(fileName, "application/pdf", pdfBytes(), { cookie: `__Host-ma-session=${token}` }),
    env,
    {},
    runtime(),
  ));
  assert.equal(result.status, 200);
  assert.equal(result.body.fileName, fileName);
});

test("file extraction requires an authenticated same-origin administrator", async (t) => {
  let calls = 0;
  const env = makeEnvironment({
    AI: {
      async toMarkdown() {
        calls += 1;
        return { format: "markdown", tokens: 1, data: "不应执行的自动识别正文" };
      },
    },
  });
  t.after(() => env.DB.close());
  const bytes = pdfBytes();
  const anonymous = await handleRequest(uploadRequest("report.pdf", "application/pdf", bytes), env, {}, runtime());
  assert.equal(anonymous.status, 403);

  const token = "d".repeat(64);
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();
  const crossOrigin = await handleRequest(
    uploadRequest("report.pdf", "application/pdf", bytes, {
      cookie: `__Host-ma-session=${token}`,
      origin: "https://evil.example",
    }),
    env,
    {},
    runtime(),
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(calls, 0);
});

test("file extraction rejects a mismatched JPEG signature before invoking Cloudflare AI", async (t) => {
  let calls = 0;
  const env = makeEnvironment({
    AI: {
      async toMarkdown() {
        calls += 1;
        return { format: "markdown", tokens: 1, data: "不应执行的自动识别正文" };
      },
    },
  });
  t.after(() => env.DB.close());
  const token = "c".repeat(64);
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();
  const result = await responseJson(await handleRequest(
    uploadRequest("malware.jpg", "image/jpeg", new TextEncoder().encode("not a jpeg"), {
      cookie: `__Host-ma-session=${token}`,
    }),
    env,
    {},
    runtime(),
  ));
  assert.equal(result.status, 415);
  assert.match(result.body.error, /格式/u);
  assert.equal(calls, 0);
});

test("file extraction keeps its independent 20 requests per IP hourly limit", async (t) => {
  let calls = 0;
  const env = makeEnvironment({
    AI: {
      async toMarkdown() {
        calls += 1;
        return { format: "markdown", tokens: 2, data: "这是用于验证文件解析频率限制的正文内容。" };
      },
    },
  });
  t.after(() => env.DB.close());
  const token = "a".repeat(64);
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();

  for (let index = 0; index < 20; index += 1) {
    const response = await handleRequest(
      uploadRequest("report.pdf", "application/pdf", pdfBytes(), {
        cookie: `__Host-ma-session=${token}`,
        ip: "203.0.113.21",
      }),
      env,
      {},
      runtime(),
    );
    assert.equal(response.status, 200);
  }
  const limited = await responseJson(await handleRequest(
    uploadRequest("report.pdf", "application/pdf", pdfBytes(), {
      cookie: `__Host-ma-session=${token}`,
      ip: "203.0.113.21",
    }),
    env,
    {},
    runtime(),
  ));
  assert.equal(limited.status, 429);
  assert.match(limited.body.error, /频繁/u);
  assert.equal(calls, 20);
});

test("file extraction keeps its independent 100 conversions per UTC day budget", async (t) => {
  let calls = 0;
  const env = makeEnvironment({
    AI: {
      async toMarkdown() {
        calls += 1;
        return { format: "markdown", tokens: 2, data: "这是用于验证文件解析每日额度的正文内容。" };
      },
    },
  });
  t.after(() => env.DB.close());
  const token = "9".repeat(64);
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();

  for (let index = 0; index < 100; index += 1) {
    const response = await handleRequest(
      uploadRequest("report.pdf", "application/pdf", pdfBytes(), {
        cookie: `__Host-ma-session=${token}`,
        ip: `203.0.113.${30 + Math.floor(index / 20)}`,
      }),
      env,
      {},
      runtime(),
    );
    assert.equal(response.status, 200);
  }
  const limited = await responseJson(await handleRequest(
    uploadRequest("report.pdf", "application/pdf", pdfBytes(), {
      cookie: `__Host-ma-session=${token}`,
      ip: "203.0.113.99",
    }),
    env,
    {},
    runtime(),
  ));
  assert.equal(limited.status, 429);
  assert.match(limited.body.error, /今日文件解析额度/u);
  assert.equal(calls, 100);
});

test("rate-limit identity uses the dedicated HMAC secret", () => {
  const source = readFileSync(new URL("../src/app.mjs", import.meta.url), "utf8");
  assert.match(source, /hmacHex\(\s*context\.env\.RATE_LIMIT_HMAC_KEY/u);
  assert.doesNotMatch(source, /hmacHex\(\s*context\.env\.APP_ENCRYPTION_KEY/u);
});

test("chat keeps the 25 requests per IP per hour limit", async (t) => {
  let modelCalls = 0;
  const env = makeEnvironment({
    AI: {
      run: async () => {
        modelCalls += 1;
        return { choices: [{ message: { role: "assistant", content: "研究方向见资料 [1]" } }] };
      },
    },
  });
  t.after(() => env.DB.close());
  for (let index = 0; index < 25; index += 1) {
    const response = await handleRequest(
      apiRequest("/api/chat", {
        method: "POST",
        body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
      }),
      env,
      {},
      runtime(),
    );
    assert.equal(response.status, 200);
  }
  const blocked = await responseJson(
    await handleRequest(
      apiRequest("/api/chat", {
        method: "POST",
        body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
      }),
      env,
      {},
      runtime(),
    ),
  );
  assert.equal(blocked.status, 429);
  assert.equal(modelCalls, 25);
});

test("global model budget remains 300 calls per UTC day with its dedicated message", async (t) => {
  let modelCalls = 0;
  const env = makeEnvironment({
    AI: {
      run: async () => {
        modelCalls += 1;
        return { choices: [{ message: { role: "assistant", content: "研究方向见资料 [1]" } }] };
      },
    },
  });
  t.after(() => env.DB.close());
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare("INSERT INTO limits(key,count,expires) VALUES (?,?,?)")
    .bind(`model-day:${day}`, 300, Math.floor(Date.now() / 1_000) + 172_800)
    .run();
  const result = await responseJson(
    await handleRequest(
      apiRequest("/api/chat", {
        method: "POST",
        ip: "198.51.100.19",
        body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
      }),
      env,
      {},
      runtime(),
    ),
  );
  assert.equal(result.status, 429);
  assert.equal(result.body.error, "今日 AI 咨询额度已用完，请稍后再试。");
  assert.equal(modelCalls, 0);
});
