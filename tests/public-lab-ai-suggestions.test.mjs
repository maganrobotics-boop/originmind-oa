import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaPublicLabAiSuggestionsTestState";
const validToken = "A".repeat(43);

class RateLimitDatabase {
  prepare(sql) {
    globalThis[stateKey].d1Calls += 1;
    return {
      bind: (...bindings) => ({
        first: async () => {
          if (!sql.includes("INSERT INTO write_rate_buckets")) throw new Error("unexpected first statement");
          const key = bindings[0];
          const cap = bindings.at(-1);
          const used = Math.min((globalThis[stateKey].buckets.get(key) ?? 0) + 1, cap);
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
    name: "public-lab-ai-suggestions-test-dependencies",
    enforce: "pre",
    resolveId(source) {
      if (source === "cloudflare:workers") return "\0public-lab-ai-suggestions-env";
      if (/lib\/knowledge-store$/u.test(source)) return "\0public-lab-ai-suggestions-store";
      return null;
    },
    load(id) {
      if (id === "\0public-lab-ai-suggestions-env") {
        return `export const env = new Proxy({}, { get: (_, key) => globalThis.${stateKey}.env[key] });`;
      }
      if (id === "\0public-lab-ai-suggestions-store") {
        return `
          export async function getLatestPublicKnowledgeSuggestionCandidates(limit) {
            globalThis.${stateKey}.storeCalls += 1;
            globalThis.${stateKey}.candidateLimits.push(limit);
            if (globalThis.${stateKey}.storeError) throw new Error("store unavailable");
            return globalThis.${stateKey}.candidates;
          }
        `;
      }
      return null;
    },
  }],
});

const route = await vite.ssrLoadModule("/app/api/public/lab-ai/suggestions/route.ts");
const rateLimit = await vite.ssrLoadModule("/app/api/public/lab-ai/_lib/rate-limit.ts");
const policy = await vite.ssrLoadModule("/lib/knowledge-policy.ts");

function request(headers = {}, url = "https://oa.omindos.ai/api/public/lab-ai/suggestions") {
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
    env: { DB: new RateLimitDatabase(), PUBLIC_LAB_AI_SERVICE_TOKEN: validToken },
    buckets: new Map(),
    d1Calls: 0,
    storeCalls: 0,
    storeError: false,
    candidateLimits: [],
    candidates: [
      {
        title: "如何",
        sectionTitle: "",
        updatedAt: "2026-09-14T13:34:56.000Z",
      },
      {
        title: "具身智能周报",
        sectionTitle: "视觉抓取",
        updatedAt: "2026-09-14T12:34:56.000Z",
        internalItemId: "must-not-leak",
        content: "must-not-leak",
        sourceUrl: "https://internal.example.test/secret",
      },
      {
        title: "具身智能周报",
        sectionTitle: "重复标题",
        updatedAt: "2026-09-13T12:34:56.000Z",
      },
      {
        title: "协作机器人安全指南",
        sectionTitle: "协作机器人安全指南",
        updatedAt: "2026-09-12T12:34:56.000Z",
      },
      {
        title: "机器人开源项目观察",
        sectionTitle: "本周新项目",
        updatedAt: "2026-09-11T12:34:56.000Z",
      },
    ],
  };
});

after(async () => {
  delete globalThis[stateKey];
  await vite.close();
});

test("suggestions reject invalid credentials, configuration, freeze, and query parameters before D1", async () => {
  for (const input of [
    request({ "x-originmind-public-lab-ai-service-token": "" }),
    request({ "x-originmind-public-lab-ai-service-token": "B".repeat(43) }),
    request({ cookie: "oa_session=secret" }),
    request({ authorization: "Bearer forbidden" }),
  ]) assert.equal((await route.GET(input)).status, 401);

  globalThis[stateKey].env.PUBLIC_LAB_AI_SERVICE_TOKEN = "invalid=";
  assert.equal((await route.GET(request())).status, 503);
  globalThis[stateKey].env.PUBLIC_LAB_AI_SERVICE_TOKEN = validToken;
  globalThis[stateKey].env.OA_MIGRATION_WRITE_FROZEN = "true";
  const frozen = await route.GET(request());
  assert.equal(frozen.status, 503);
  assert.equal(frozen.headers.get("retry-after"), "300");
  globalThis[stateKey].env.OA_MIGRATION_WRITE_FROZEN = "false";
  assert.equal((await route.GET(request({}, "https://oa.omindos.ai/api/public/lab-ai/suggestions?debug=1"))).status, 400);
  assert.equal(globalThis[stateKey].d1Calls, 0);
  assert.equal(globalThis[stateKey].storeCalls, 0);
});

test("success returns at most four exact, deterministic, answerable questions without internal data", async () => {
  const response = await route.GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.match(response.headers.get("cache-control") || "", /no-store/u);
  const raw = await response.text();
  const body = JSON.parse(raw);
  assert.deepEqual(Object.keys(body), ["suggestions"]);
  assert.deepEqual(body, {
    suggestions: [
      { id: "1", question: "《具身智能周报》中的“视觉抓取”有哪些值得关注的内容？", updatedAt: "2026-09-14" },
      { id: "2", question: "《协作机器人安全指南》有哪些值得关注的核心内容？", updatedAt: "2026-09-12" },
      { id: "3", question: "《机器人开源项目观察》中的“本周新项目”有哪些值得关注的内容？", updatedAt: "2026-09-11" },
    ],
  });
  assert.deepEqual(globalThis[stateKey].candidateLimits, [12]);
  assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(body).includes("https://"), false);
  for (const suggestion of body.suggestions) {
    assert.deepEqual(Object.keys(suggestion), ["id", "question", "updatedAt"]);
    assert.ok(suggestion.question.length >= 2 && suggestion.question.length <= 300);
    const title = suggestion.question.match(/^《([^》]+)》/u)?.[1] || "";
    const source = globalThis[stateKey].candidates.find((candidate) => candidate.title === title);
    assert.ok(source);
    assert.ok(policy.knowledgeSearchTerms(title).length > 0);
    assert.ok(policy.knowledgeSearchTerms(suggestion.question).length > 0);
    assert.equal(policy.rankKnowledgeChunks(suggestion.question, [{
      id: suggestion.id,
      itemId: suggestion.id,
      revisionId: suggestion.id,
      title: source.title,
      category: "测试",
      sourceLabel: "公开知识库",
      sourceUrl: "",
      sectionTitle: source.sectionTitle,
      paragraphRef: "第 1 段",
      content: "这是已审核公开知识的代表内容。",
      searchText: `${source.title}\n${source.sectionTitle}\n这是已审核公开知识的代表内容。`,
      updatedAt: source.updatedAt,
    }], 1).length, 1);
  }
});

test("sections without searchable terms fall back to a title-bound question", async () => {
  globalThis[stateKey].candidates = [{
    title: "星云夹爪维护周报",
    sectionTitle: "如何",
    updatedAt: "2026-09-14T12:34:56.000Z",
  }];
  const response = await route.GET(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    suggestions: [{
      id: "1",
      question: "《星云夹爪维护周报》有哪些值得关注的核心内容？",
      updatedAt: "2026-09-14",
    }],
  });
  const ranked = policy.rankKnowledgeChunks(body.suggestions[0].question, [
    {
      id: "1",
      itemId: "maintenance",
      revisionId: "active-revision",
      title: "星云夹爪维护周报",
      category: "测试",
      sourceLabel: "公开知识库",
      sourceUrl: "",
      sectionTitle: "更换密封圈",
      paragraphRef: "第 1 段",
      content: "更换密封圈前需要断开设备电源。",
      searchText: "星云夹爪维护周报 更换密封圈 更换密封圈前需要断开设备电源",
      updatedAt: "2026-09-14T12:34:56.000Z",
    },
    {
      id: "2",
      itemId: "maintenance",
      revisionId: "active-revision",
      title: "星云夹爪维护周报",
      category: "测试",
      sourceLabel: "公开知识库",
      sourceUrl: "",
      sectionTitle: "扭矩复核",
      paragraphRef: "第 2 段",
      content: "维护完成后需要复核紧固件扭矩。",
      searchText: "星云夹爪维护周报 扭矩复核 维护完成后需要复核紧固件扭矩",
      updatedAt: "2026-09-14T12:34:56.000Z",
    },
  ], 6);
  assert.equal(ranked.length, 2, "title-only fallback must still retrieve the item's active chunks");
});

test("empty knowledge returns an exact empty list and store failures fail closed", async () => {
  globalThis[stateKey].candidates = [];
  const empty = await route.GET(request());
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { suggestions: [] });

  globalThis[stateKey].storeError = true;
  const failed = await route.GET(request());
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "知识推荐话题暂不可用。" });
});

test("suggestions use an independent service-wide 600-per-minute window", async () => {
  const database = new RateLimitDatabase();
  const now = new Date("2026-09-14T12:01:30.000Z");
  for (let index = 1; index <= 600; index += 1) {
    assert.equal(await rateLimit.consumePublicLabAiSuggestionsRateLimit(database, now), true);
  }
  assert.equal(await rateLimit.consumePublicLabAiSuggestionsRateLimit(database, now), false);
  assert.equal(
    globalThis[stateKey].buckets.has(JSON.stringify(["public_lab_ai_retrieve", "chat.omindos.ai", "2026-09-14T12:01:00.000Z"])),
    false,
  );

  const current = new Date();
  const windowStartedAt = new Date(Math.floor(current.getTime() / 60_000) * 60_000).toISOString();
  globalThis[stateKey].buckets.set(JSON.stringify(["public_lab_ai_suggestions", "chat.omindos.ai", windowStartedAt]), 600);
  const response = await route.GET(request());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(globalThis[stateKey].storeCalls, 0);
});

test("storage query is latest-first, one-chunk-per-item, and restricted to approved public active revisions", async () => {
  const storeSource = await readFile(new URL("../lib/knowledge-store.ts", import.meta.url), "utf8");
  const routeSource = await readFile(new URL("../app/api/public/lab-ai/suggestions/route.ts", import.meta.url), "utf8");
  const start = storeSource.indexOf("export async function getLatestPublicKnowledgeSuggestionCandidates");
  const end = storeSource.indexOf("export async function hasPublicActiveKnowledge", start);
  const source = storeSource.slice(start, end);
  assert.match(source, /i\.status = 'active'/u);
  assert.match(source, /i\.visibility = 'public'/u);
  assert.match(source, /r\.id = i\.active_revision_id/u);
  assert.match(source, /r\.status = 'active'/u);
  assert.match(source, /representative\.is_active = 1/u);
  assert.match(source, /ORDER BY i\.updated_at DESC, i\.id ASC/u);
  assert.match(source, /SELECT c\.id[\s\S]+LIMIT 1/u);
  assert.doesNotMatch(routeSource, /lab-ai-client|answerLabQuestion|fetch\s*\(/u);
});

test("OA generates up to four clean title-bound questions and deduplicates version labels", async () => {
  globalThis[stateKey].candidates = [
    { title: "矿井巡检（脱敏版）", sectionTitle: "导航（脱密版）", updatedAt: "2026-09-14" },
    { title: "矿井巡检", sectionTitle: "重复章节", updatedAt: "2026-09-13" },
    ...["机械臂控制", "视觉定位", "运动规划", "多机协作"].map((title) => ({ title, sectionTitle: "方法", updatedAt: "2026-09-12" })),
  ];
  const response = await route.GET(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.suggestions.length, 4);
  assert.deepEqual(body.suggestions.map((item) => item.id), ["1", "2", "3", "4"]);
  assert.match(body.suggestions[0].question, /《矿井巡检》中的“导航”/u);
  assert.doesNotMatch(JSON.stringify(body), /脱敏|脱密|多机协作|重复章节/u);
});
