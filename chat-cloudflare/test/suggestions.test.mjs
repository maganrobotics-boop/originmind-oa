import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../src/app.mjs";
import { OA_PUBLIC_SUGGESTIONS_URL } from "../src/constants.mjs";
import { fallbackAnswer } from "../src/knowledge.mjs";
import {
  parseOaSuggestions,
  retrieveOaSuggestions,
  suggestionKnowledgeReference,
  suggestionMatchesKnowledge,
} from "../src/oa-public.mjs";
import { D1DatabaseAdapter } from "./d1-adapter.mjs";

const ORIGIN = "https://chat.omindos.ai";
const SERVICE_TOKEN = "A".repeat(43);
const SUGGESTIONS = Object.freeze([
  { id: "1", question: "《灵巧操作进展》有哪些值得关注的核心内容？", updatedAt: "2026-09-14" },
  { id: "2", question: "《OmindOS 巡检实践》有哪些值得关注的核心内容？", updatedAt: "2026-09-13" },
]);

function environment(overrides = {}) {
  return {
    DB: new D1DatabaseAdapter(),
    APP_ORIGIN: ORIGIN,
    ADMIN_EMAIL: "owner@example.test",
    APP_ENCRYPTION_KEY: "encryption-key-".padEnd(48, "e"),
    RATE_LIMIT_HMAC_KEY: "rate-limit-key-".padEnd(48, "r"),
    PUBLIC_LAB_AI_SERVICE_TOKEN: SERVICE_TOKEN,
    RELEASE_ID: `${"a".repeat(40)}-1`,
    ...overrides,
  };
}

function request(path, ip = "203.0.113.18") {
  return new Request(`${ORIGIN}${path}`, {
    headers: { "CF-Connecting-IP": ip },
  });
}

test("OA suggestion parser accepts only the exact bounded contract", () => {
  assert.deepEqual(parseOaSuggestions({ suggestions: SUGGESTIONS }), SUGGESTIONS);

  const invalid = [
    { suggestions: SUGGESTIONS, internal: true },
    { suggestions: [{ ...SUGGESTIONS[0], sourceUrl: "https://private.example" }] },
    { suggestions: [{ ...SUGGESTIONS[0], id: "2" }] },
    { suggestions: [{ ...SUGGESTIONS[0], updatedAt: "2026-02-30" }] },
    { suggestions: [{ ...SUGGESTIONS[0], question: "最近有哪些有趣内容？" }] },
    { suggestions: [SUGGESTIONS[0], { ...SUGGESTIONS[0], id: "2" }] },
    { suggestions: Array.from({ length: 4 }, (_, index) => ({
      id: String(index + 1),
      question: `推荐问题 ${index + 1}`,
      updatedAt: "2026-09-14",
    })) },
  ];
  for (const payload of invalid) {
    assert.throws(() => parseOaSuggestions(payload), /OA_RESPONSE_INVALID/u);
  }
});

test("suggestion references bind the generated title and optional section", () => {
  const sectionQuestion = "《灵巧操作进展》中的“触觉反馈”有哪些值得关注的内容？";
  assert.deepEqual(suggestionKnowledgeReference(sectionQuestion), {
    title: "灵巧操作进展",
    sectionTitle: "触觉反馈",
  });
  assert.equal(suggestionMatchesKnowledge(sectionQuestion, {
    title: "灵巧操作进展",
    sectionTitle: "触觉反馈",
  }), true);
  assert.equal(suggestionMatchesKnowledge(sectionQuestion, {
    title: "灵巧操作进展",
    sectionTitle: "视觉抓取",
  }), false);
  assert.equal(suggestionMatchesKnowledge(SUGGESTIONS[0].question, {
    title: "灵巧操作进展",
    sectionTitle: "任意公开章节",
  }), true);
});

test("OA suggestion adapter uses one hardened service-binding GET", async () => {
  let calls = 0;
  const result = await retrieveOaSuggestions({
    env: {
      PUBLIC_LAB_AI_SERVICE_TOKEN: SERVICE_TOKEN,
      OA_SERVICE: {
        async fetch(boundRequest) {
          calls += 1;
          assert.equal(boundRequest.url, OA_PUBLIC_SUGGESTIONS_URL);
          assert.equal(boundRequest.method, "GET");
          assert.equal(boundRequest.headers.get("x-originmind-public-lab-ai-service-token"), SERVICE_TOKEN);
          assert.equal(boundRequest.redirect, "manual");
          assert.equal(boundRequest.cache, "no-store");
          assert.equal(boundRequest.credentials, "omit");
          return Response.json({ suggestions: SUGGESTIONS });
        },
      },
    },
    runtime: { fetch: async () => { throw new Error("public fallback must not run"); } },
  });
  assert.deepEqual(result, { status: "connected", suggestions: SUGGESTIONS });
  assert.equal(calls, 1);
});

test("suggestion endpoint revalidates every connected set and exposes no static fallback", async (t) => {
  let calls = 0;
  const env = environment();
  t.after(() => env.DB.close());
  const runtime = {
    async fetch(url, init) {
      calls += 1;
      assert.equal(String(url), OA_PUBLIC_SUGGESTIONS_URL);
      assert.equal(init.method, "GET");
      return Response.json({ suggestions: SUGGESTIONS });
    },
  };

  const first = await handleRequest(request("/api/suggestions"), env, {}, runtime);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { suggestions: SUGGESTIONS, oaPublicStatus: "connected" });

  const revalidated = await handleRequest(request("/api/suggestions", "203.0.113.19"), env, {}, runtime);
  assert.equal(revalidated.status, 200);
  assert.deepEqual(await revalidated.json(), { suggestions: SUGGESTIONS, oaPublicStatus: "connected" });
  assert.equal(calls, 2);
});

test("source-bound chat ignores unrelated retrieval hits", async (t) => {
  const env = environment({ AI: { run: async () => { throw new Error("model must not run"); } } });
  t.after(() => env.DB.close());
  const response = await handleRequest(
    new Request(`${ORIGIN}/api/chat`, {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.31",
        "Content-Type": "application/json",
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        topic: "research",
        messages: [{ role: "user", content: SUGGESTIONS[0].question }],
      }),
    }),
    env,
    {},
    {
      fetch: async () => Response.json({
        chunks: [{
          id: "1",
          title: "另一条公开知识",
          category: "research",
          sectionTitle: "灵巧操作进展",
          paragraphRef: "第 1 段",
          excerpt: "这段内容虽然被全文检索命中，但不属于推荐题目绑定的知识。",
          sourceLabel: "OA 公开知识",
          updatedAt: "2026-09-14",
        }],
      }),
    },
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.mode, "retrieval");
  assert.deepEqual(result.sources, []);
  assert.match(result.answer, /没有足够信息/u);
});

test("concurrent suggestion requests each revalidate with OA and create no replay cache", async (t) => {
  const env = environment({ RELEASE_ID: `${"c".repeat(40)}-1` });
  t.after(() => env.DB.close());
  let calls = 0;
  const runtime = {
    async fetch() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ suggestions: SUGGESTIONS });
    },
  };
  const responses = await Promise.all([
    handleRequest(request("/api/suggestions"), env, {}, runtime),
    handleRequest(request("/api/suggestions", "203.0.113.44"), env, {}, runtime),
  ]);
  assert.equal(calls, 2);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { suggestions: SUGGESTIONS, oaPublicStatus: "connected" });
  }
  const cache = env.DB.sqlite.prepare(
    "SELECT id FROM settings WHERE id LIKE 'system-suggestions-oa-v1:%'",
  ).get();
  assert.equal(cache, undefined);
});

test("suggestion endpoint returns an empty list for invalid or unavailable OA output", async (t) => {
  const cases = [
    Response.json({ suggestions: [{ ...SUGGESTIONS[0], secret: "must not pass" }] }),
    new Response("unavailable", { status: 503 }),
  ];
  for (const [index, upstream] of cases.entries()) {
    const env = environment({ RELEASE_ID: `${"b".repeat(40)}-${index + 1}` });
    t.after(() => env.DB.close());
    const response = await handleRequest(
      request("/api/suggestions", `203.0.113.${20 + index}`),
      env,
      {},
      { fetch: async () => upstream.clone() },
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.suggestions, []);
    assert.notEqual(result.oaPublicStatus, "connected");
  }
});

test("suggestion endpoint rejects query parameters", async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  const response = await handleRequest(
    request("/api/suggestions?topic=research"),
    env,
    {},
    { fetch: async () => { throw new Error("must not fetch"); } },
  );
  assert.equal(response.status, 400);
});

test("retrieved knowledge remains a substantive answer when the model is unavailable", async (t) => {
  const env = environment({
    AI: { run: async () => { throw new Error("model unavailable"); } },
  });
  t.after(() => env.DB.close());
  const response = await handleRequest(
    new Request(`${ORIGIN}/api/chat`, {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.30",
        "Content-Type": "application/json",
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        topic: "research",
        messages: [{ role: "user", content: "灵巧操作研究有什么进展？" }],
      }),
    }),
    env,
    {},
    {
      fetch: async () => Response.json({
        chunks: [{
          id: "1",
          title: "灵巧操作研究",
          category: "research",
          sectionTitle: "研究进展",
          paragraphRef: "第 1 段",
          excerpt: "团队已公开机器人灵巧操作与系统设计方面的研究内容。",
          sourceLabel: "OA 公开知识",
          updatedAt: "2026-09-14",
        }],
      }),
    },
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.mode, "retrieval");
  assert.equal(result.answer, "团队已公开机器人灵巧操作与系统设计方面的研究内容。");
  assert.doesNotMatch(result.answer, /无法整理|换个.*问法/u);
});

test("extractive fallback deduplicates and bounds approved knowledge excerpts", () => {
  const repeated = `公开内容${"甲".repeat(600)}`;
  const answer = fallbackAnswer([
    { body: repeated },
    { body: repeated },
    { body: "另一条公开内容。" },
  ]);
  assert.match(answer, /^知识库中与这个问题直接相关的内容包括：/u);
  assert.equal((answer.match(/^- /gmu) || []).length, 2);
  assert.match(answer, /…/u);
  assert.match(answer, /另一条公开内容/u);
});
