import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaPublicLabAiStatusTestState";
const validToken = "A".repeat(43);

globalThis[stateKey] = {};
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "public-lab-ai-status-test-dependencies",
    enforce: "pre",
    resolveId(source) {
      if (source === "cloudflare:workers") return "\0public-lab-ai-status-env";
      if (/lib\/knowledge-store$/u.test(source)) return "\0public-lab-ai-status-store";
      if (/_lib\/rate-limit$/u.test(source)) return "\0public-lab-ai-status-rate-limit";
      return null;
    },
    load(id) {
      if (id === "\0public-lab-ai-status-env") {
        return `export const env = new Proxy({}, { get: (_, key) => globalThis.${stateKey}.env[key] });`;
      }
      if (id === "\0public-lab-ai-status-store") {
        return `
          export async function hasPublicActiveKnowledge() {
            globalThis.${stateKey}.storeCalls += 1;
            if (globalThis.${stateKey}.storeError) throw new Error("store unavailable");
            return globalThis.${stateKey}.knowledgeReady;
          }
        `;
      }
      if (id === "\0public-lab-ai-status-rate-limit") {
        return `
          export async function isPublicLabAiRetrieveAvailable() {
            globalThis.${stateKey}.rateLimitCalls += 1;
            if (globalThis.${stateKey}.rateLimitError) throw new Error("rate limit unavailable");
            return globalThis.${stateKey}.retrievalReady;
          }
        `;
      }
      return null;
    },
  }],
});

const route = await vite.ssrLoadModule("/app/api/public/lab-ai/status/route.ts");
const rateLimit = await vite.ssrLoadModule("/app/api/public/lab-ai/_lib/rate-limit.ts");

function request(headers = {}, url = "https://oa.omindos.ai/api/public/lab-ai/status") {
  return new Request(url, {
    method: "GET",
    headers: {
      "x-originmind-public-lab-ai-service-token": validToken,
      ...headers,
    },
  });
}

beforeEach(() => {
  globalThis[stateKey] = {
    env: { PUBLIC_LAB_AI_SERVICE_TOKEN: validToken },
    knowledgeReady: true,
    retrievalReady: true,
    storeCalls: 0,
    storeError: false,
    rateLimitCalls: 0,
    rateLimitError: false,
  };
});

after(async () => {
  delete globalThis[stateKey];
  await vite.close();
});

test("status rejects invalid credentials and configuration before reading knowledge", async () => {
  for (const input of [
    request({ "x-originmind-public-lab-ai-service-token": "" }),
    request({ "x-originmind-public-lab-ai-service-token": "B".repeat(43) }),
    request({ cookie: "oa_session=secret" }),
    request({ authorization: "Bearer forbidden" }),
  ]) {
    assert.equal((await route.GET(input)).status, 401);
  }
  globalThis[stateKey].env.PUBLIC_LAB_AI_SERVICE_TOKEN = "invalid=";
  assert.equal((await route.GET(request())).status, 503);
  assert.equal(globalThis[stateKey].storeCalls, 0);
  assert.equal(globalThis[stateKey].rateLimitCalls, 0);
});

test("status is unavailable during migration freeze and rejects query parameters", async () => {
  globalThis[stateKey].env.OA_MIGRATION_WRITE_FROZEN = "true";
  const frozen = await route.GET(request());
  assert.equal(frozen.status, 503);
  assert.equal(frozen.headers.get("retry-after"), "300");
  globalThis[stateKey].env.OA_MIGRATION_WRITE_FROZEN = "false";
  assert.equal((await route.GET(request({}, "https://oa.omindos.ai/api/public/lab-ai/status?debug=1"))).status, 400);
  assert.equal(globalThis[stateKey].storeCalls, 0);
  assert.equal(globalThis[stateKey].rateLimitCalls, 0);
});

test("status returns only aggregate OA and public-knowledge readiness", async () => {
  for (const knowledgeReady of [true, false]) {
    globalThis[stateKey].knowledgeReady = knowledgeReady;
    const response = await route.GET(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.match(response.headers.get("cache-control") || "", /no-store/u);
    assert.deepEqual(await response.json(), {
      oaReady: true,
      publicKnowledgeReady: knowledgeReady,
      retrievalReady: true,
    });
  }
  assert.equal(globalThis[stateKey].storeCalls, 2);
  assert.equal(globalThis[stateKey].rateLimitCalls, 2);
});

test("status keeps OA and knowledge connected while marking retrieval capacity unavailable", async () => {
  globalThis[stateKey].retrievalReady = false;
  const response = await route.GET(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    oaReady: true,
    publicKnowledgeReady: true,
    retrievalReady: false,
  });
});

test("the retrieval-capacity check is read-only and closes at the configured limit", async () => {
  const now = new Date("2026-09-12T10:42:31.000Z");
  for (const [used, expected] of [[undefined, true], [119, true], [120, false]]) {
    let sql = "";
    let args = [];
    const database = {
      prepare(value) {
        sql = value;
        return {
          bind(...values) {
            args = values;
            return this;
          },
          async first() {
            return used === undefined ? null : { used };
          },
        };
      },
    };
    assert.equal(await rateLimit.isPublicLabAiRetrieveAvailable(database, now), expected);
    assert.match(sql, /^SELECT used FROM write_rate_buckets/u);
    assert.equal(args.length, 1);
    assert.match(args[0], /2026-09-12T10:42:00\.000Z/u);
  }
});

test("status fails closed when the aggregate knowledge check fails", async () => {
  globalThis[stateKey].storeError = true;
  const response = await route.GET(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "公共知识状态暂不可用。" });
});

test("status route performs no model call or outbound fetch", async () => {
  const source = await readFile(new URL("../app/api/public/lab-ai/status/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /lab-ai-client|answerLabQuestion|fetch\s*\(/u);
  assert.match(source, /await import\("cloudflare:workers"\)/u);
  assert.match(source, /hasPublicActiveKnowledge/u);
  assert.match(source, /isPublicLabAiRetrieveAvailable/u);
});
