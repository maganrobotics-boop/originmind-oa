import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaPublicLabAiRetrieveTestState";
const validToken = "A".repeat(43);

class RateLimitDatabase {
  prepare(sql) {
    globalThis[stateKey].d1Calls += 1;
    return {
      bind: (...bindings) => ({
        first: async () => {
          if (!sql.includes("INSERT INTO write_rate_buckets")) throw new Error("unexpected first statement");
          const key = bindings[0];
          const used = Math.min((globalThis[stateKey].buckets.get(key) ?? 0) + 1, 121);
          globalThis[stateKey].buckets.set(key, used);
          return { used };
        },
        run: async () => ({ success: true }),
      }),
    };
  }
}

globalThis[stateKey] = {};
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "public-lab-ai-retrieve-test-dependencies",
    enforce: "pre",
    resolveId(source) {
      if (source === "cloudflare:workers") return "\0public-lab-ai-env";
      if (/lib\/knowledge-store$/u.test(source)) return "\0public-lab-ai-store";
      return null;
    },
    load(id) {
      if (id === "\0public-lab-ai-env") return `export const env = new Proxy({}, { get: (_, key) => globalThis.${stateKey}.env[key] });`;
      if (id === "\0public-lab-ai-store") return `
        export async function getPublicActiveKnowledgeChunks(question) {
          globalThis.${stateKey}.storeCalls += 1;
          globalThis.${stateKey}.storeQuestions.push(question);
          return globalThis.${stateKey}.candidates;
        }
      `;
      return null;
    },
  }],
});

const route = await vite.ssrLoadModule("/app/api/public/lab-ai/retrieve/route.ts");
const rateLimit = await vite.ssrLoadModule("/app/api/public/lab-ai/_lib/rate-limit.ts");

function candidate(index) {
  return {
    id: `internal-chunk-${index}`,
    itemId: `internal-item-${index}`,
    revisionId: `internal-revision-${index}`,
    title: `机械臂公开规范 ${index}`,
    category: "安全规范",
    sourceLabel: "公开审核资料",
    sourceUrl: `https://internal.example.test/secret/${index}`,
    sectionTitle: "急停与复位",
    paragraphRef: `第 ${index} 段`,
    content: `机械臂急停复位公开步骤 ${index}。`.repeat(100),
    searchText: "机械臂 急停 复位 公开步骤",
    updatedAt: "2026-09-10T12:34:56.000Z",
    reviewedByEmail: "reviewer@internal.example.test",
  };
}

function request(body = { question: "机械臂如何急停复位？" }, headers = {}, url = "https://oa.omindos.ai/api/public/lab-ai/retrieve") {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-originmind-public-lab-ai-service-token": validToken,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  globalThis[stateKey] = {
    env: { DB: new RateLimitDatabase(), PUBLIC_LAB_AI_SERVICE_TOKEN: validToken },
    buckets: new Map(),
    d1Calls: 0,
    storeCalls: 0,
    storeQuestions: [],
    candidates: Array.from({ length: 6 }, (_, index) => candidate(index + 1)),
  };
});

after(async () => {
  delete globalThis[stateKey];
  await vite.close();
});

test("missing, malformed, wrong, browser, and OA-session credentials are rejected before D1", async () => {
  const cases = [
    request(undefined, { "x-originmind-public-lab-ai-service-token": "" }),
    request(undefined, { "x-originmind-public-lab-ai-service-token": `${"A".repeat(42)}=` }),
    request(undefined, { "x-originmind-public-lab-ai-service-token": "B".repeat(43) }),
    request(undefined, { cookie: "oa_session=secret" }),
    request(undefined, { authorization: "Bearer forbidden" }),
  ];
  for (const input of cases) assert.equal((await route.POST(input)).status, 401);
  assert.equal(globalThis[stateKey].d1Calls, 0);
  assert.equal(globalThis[stateKey].storeCalls, 0);
});

test("invalid server configuration and migration freeze fail closed without D1", async () => {
  globalThis[stateKey].env.PUBLIC_LAB_AI_SERVICE_TOKEN = "invalid=";
  assert.equal((await route.POST(request())).status, 503);
  globalThis[stateKey].env.PUBLIC_LAB_AI_SERVICE_TOKEN = validToken;
  globalThis[stateKey].env.OA_MIGRATION_WRITE_FROZEN = "true";
  const frozen = await route.POST(request());
  assert.equal(frozen.status, 503);
  assert.equal(frozen.headers.get("retry-after"), "300");
  const wrong = await route.POST(request(undefined, { "x-originmind-public-lab-ai-service-token": "B".repeat(43) }));
  assert.equal(wrong.status, 401);
  assert.equal(globalThis[stateKey].d1Calls, 0);
  assert.equal(globalThis[stateKey].storeCalls, 0);
});

test("request schema and stream bytes are bounded before D1", async () => {
  const cases = [
    [request({ question: "机械臂复位", extra: true }), 400],
    [request({ question: "机械臂复位" }, { "content-type": "text/plain" }), 415],
    [request({ question: "机" }), 400],
    [request({ question: "A".repeat(501) }), 400],
    [request({ question: "\uD800机械臂" }), 400],
    [request({ question: "机械臂", padding: "中".repeat(2_000) }), 413],
    [request({ question: "机械臂" }, {}, "https://oa.omindos.ai/api/public/lab-ai/retrieve?debug=1"), 400],
  ];
  for (const [input, status] of cases) assert.equal((await route.POST(input)).status, status);
  assert.equal(globalThis[stateKey].d1Calls, 0);
  assert.equal(globalThis[stateKey].storeCalls, 0);
});

test("success returns only strict sequential bounded excerpts with no internal metadata or CORS", async () => {
  const response = await route.POST(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const raw = await response.text();
  assert.ok(new TextEncoder().encode(raw).byteLength <= 16 * 1_024);
  const body = JSON.parse(raw);
  assert.deepEqual(Object.keys(body), ["chunks"]);
  assert.equal(body.chunks.length, 6);
  assert.deepEqual(globalThis[stateKey].storeQuestions, ["机械臂如何急停复位?"]);
  assert.deepEqual(body.chunks.map((chunk) => chunk.id), ["1", "2", "3", "4", "5", "6"]);
  const allowed = ["id", "title", "category", "sectionTitle", "paragraphRef", "excerpt", "sourceLabel", "updatedAt"].sort();
  for (const chunk of body.chunks) {
    assert.deepEqual(Object.keys(chunk).sort(), allowed);
    assert.ok(chunk.excerpt.length >= 1 && chunk.excerpt.length <= 600);
    assert.equal(JSON.stringify(chunk).includes("internal-"), false);
    assert.equal(JSON.stringify(chunk).includes("reviewer@"), false);
    assert.equal(JSON.stringify(chunk).includes("https://"), false);
  }
  assert.ok(body.chunks.reduce((sum, chunk) => sum + chunk.excerpt.length, 0) <= 3_000);
  assert.ok(body.chunks.reduce((sum, chunk) => sum + Object.values(chunk).reduce((part, value) => part + value.length, 0), 0) <= 4_096);
});

test("D1 service-wide window allows 120 claims and rejects claim 121 before store retrieval", async () => {
  const database = new RateLimitDatabase();
  const now = new Date("2026-09-11T12:01:30.000Z");
  for (let index = 1; index <= 120; index += 1) assert.equal(await rateLimit.consumePublicLabAiRetrieveRateLimit(database, now), true);
  assert.equal(await rateLimit.consumePublicLabAiRetrieveRateLimit(database, now), false);

  const current = new Date();
  const windowStartedAt = new Date(Math.floor(current.getTime() / 60_000) * 60_000).toISOString();
  globalThis[stateKey].buckets.set(JSON.stringify(["public_lab_ai_retrieve", "chat.omindos.ai", windowStartedAt]), 120);
  const response = await route.POST(request());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(globalThis[stateKey].storeCalls, 0);
});

test("route has no model or outbound fetch and Worker freeze exception is exact", async () => {
  const routeSource = await readFile(new URL("../app/api/public/lab-ai/retrieve/route.ts", import.meta.url), "utf8");
  const workerSource = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(routeSource, /lab-ai-client|answerLabQuestion|fetch\s*\(/u);
  assert.match(routeSource, /await import\("cloudflare:workers"\)/u);
  assert.match(workerSource, /request\.method === "POST" && url\.pathname === "\/api\/public\/lab-ai\/retrieve"/u);
  assert.match(workerSource, /if \(!isPublicLabAiRetrieve && isMigrationWriteFrozen/u);
  assert.match(workerSource, /if \(!isPublicLabAiRetrieve && shouldBlockForMigrationFreeze/u);
});
