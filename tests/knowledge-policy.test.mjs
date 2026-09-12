import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});

const originalLabEnvironment = Object.fromEntries([
  "OA_LAB_AI_ENABLED",
  "OA_LAB_AI_ENDPOINT",
  "OA_LAB_AI_API_KEY",
  "OA_LAB_AI_MODEL",
  "OA_LAB_AI_FORMAT",
  "OA_LAB_AI_TIMEOUT_MS",
].map((key) => [key, process.env[key]]));

after(async () => {
  for (const [key, value] of Object.entries(originalLabEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await vite.close();
});

beforeEach(() => {
  delete process.env.OA_LAB_AI_ENDPOINT;
  delete process.env.OA_LAB_AI_API_KEY;
  delete process.env.OA_LAB_AI_ENABLED;
});

const policy = await vite.ssrLoadModule("/lib/knowledge-policy.ts");
const labAi = await vite.ssrLoadModule("/lib/lab-ai-client.ts");

function submission(overrides = {}) {
  return {
    title: "机器人急停复位流程",
    category: "安全规范",
    summary: "急停复位前必须确认安全区无人。",
    sourceLabel: "实验室安全手册",
    sourceUrl: "https://example.com/safety",
    content: "按下急停后，先确认安全区无人。\n\n解除机械臂故障，再由值班人员执行复位。",
    ...overrides,
  };
}

test("知识投稿规范化来源字段并拒绝危险 URL", () => {
  const parsed = policy.parseKnowledgeSubmission(submission({ sourceUrl: "https://example.com/guide#chapter" }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.sourceUrl, "https://example.com/guide");

  for (const sourceUrl of ["javascript:alert(1)", "file:///etc/passwd", "https://user:secret@example.com/"]) {
    const rejected = policy.parseKnowledgeSubmission(submission({ sourceUrl }));
    assert.equal(rejected.ok, false, sourceUrl);
    assert.match(rejected.error, /HTTP|HTTPS|链接/u);
  }

  const generatedSummary = policy.parseKnowledgeSubmission(submission({
    summary: "",
    content: `${"a".repeat(179)}😀${"b".repeat(20)}`,
  }));
  assert.equal(generatedSummary.ok, true);
  assert.equal(generatedSummary.value.summary, "a".repeat(179));
  assert.doesNotMatch(generatedSummary.value.summary, /[\uD800-\uDFFF]/u);

  for (const malformedContent of [`有效正文内容${"\uD800"}`, `有效正文内容${"\uDC00"}`]) {
    const malformedUnicode = policy.parseKnowledgeSubmission(submission({ content: malformedContent }));
    assert.equal(malformedUnicode.ok, false);
    assert.match(malformedUnicode.error, /Unicode/u);
  }
  assert.equal(policy.parseReviewNote(`审核通过${"\uD800"}`).ok, false);
});

test("知识切分产生稳定、有限且可引用的段落", () => {
  const content = ["# 标定流程", "第一段说明。".repeat(80), "第二段说明。", "第三段说明。"].join("\n\n");
  const chunks = policy.chunkKnowledgeSubmission(submission({ content }), 300);
  assert.ok(chunks.length >= 3);
  assert.deepEqual(chunks.map((chunk) => chunk.chunkNo), chunks.map((_, index) => index + 1));
  assert.ok(chunks.every((chunk) => chunk.content.length <= 300));
  assert.ok(chunks.every((chunk) => /^第 \d+(?:–\d+)? 段$/u.test(chunk.paragraphRef)));
  assert.equal(chunks[0].sectionTitle, "标定流程");

  const fragmentedContent = "# 小节\n\n".repeat(2_500).trim().slice(0, policy.MAX_KNOWLEDGE_CONTENT_LENGTH);
  const fragmented = policy.chunkKnowledgeSubmission(submission({ content: fragmentedContent }));
  assert.ok(fragmented.length <= policy.MAX_KNOWLEDGE_CHUNKS);
  assert.ok(fragmented.every((chunk, index) => chunk.chunkNo === index + 1));
  assert.ok(fragmented.every((chunk) => chunk.content.length <= 900));
  assert.equal(fragmented.map((chunk) => chunk.content).join(""), fragmentedContent);

  const unevenSections = Array.from({ length: 33 }, (_, index) => `# 小节 ${index + 1}\n\n${"校验内容".repeat(118)}`).join("\n\n");
  const uneven = policy.chunkKnowledgeSubmission(submission({ content: unevenSections }));
  assert.ok(uneven.length <= policy.MAX_KNOWLEDGE_CHUNKS);
  assert.ok(uneven.every((chunk) => chunk.content.length <= 900));
  assert.equal(uneven.map((chunk) => chunk.content).join(""), unevenSections);

  const emojiContent = `${"a".repeat(899)}😀${"b".repeat(50)}`;
  const emojiChunks = policy.chunkKnowledgeSubmission(submission({ content: emojiContent }));
  assert.equal(emojiChunks.map((chunk) => chunk.content).join(""), emojiContent);
  assert.ok(emojiChunks.every((chunk) => !/^[\uDC00-\uDFFF]/u.test(chunk.content)));
  assert.ok(emojiChunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk.content)));
});

test("应用层检索同时支持中文短语和英文 token，并过滤无关内容", () => {
  const base = {
    itemId: "item-1",
    revisionId: "revision-1",
    category: "安全规范",
    sourceLabel: "实验室手册",
    sourceUrl: "",
    sectionTitle: "急停",
    paragraphRef: "第 1 段",
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
  const candidates = [
    { ...base, id: "chunk-cn", title: "机械臂急停复位", content: "确认安全区无人后解除急停，再执行复位。", searchText: "机械臂急停复位 确认安全区无人" },
    { ...base, id: "chunk-en", itemId: "item-2", title: "CAN bus troubleshooting", content: "Check the CAN bus termination resistor before restart.", searchText: "can bus troubleshooting termination resistor" },
    { ...base, id: "chunk-other", itemId: "item-3", title: "会议室预订", content: "每周五更新会议室日历。", searchText: "会议室预订 日历" },
  ];

  assert.equal(policy.rankKnowledgeChunks("机械臂急停后如何复位？", candidates, 6)[0].id, "chunk-cn");
  assert.equal(policy.rankKnowledgeChunks("How do I inspect the CAN bus resistor?", candidates, 6)[0].id, "chunk-en");
  assert.deepEqual(policy.rankKnowledgeChunks("食堂今天吃什么？", candidates, 6), []);

  const summaryOnly = { ...base, id: "chunk-summary", itemId: "item-4", title: "试验记录", content: "正文只记录常规步骤。", searchText: "试验记录 安全规范 稀有摘要关键词 正文只记录常规步骤" };
  assert.equal(policy.rankKnowledgeChunks("稀有摘要关键词", [summaryOnly], 6)[0].id, "chunk-summary");

  const longQuestion = Array.from({ length: 500 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join("");
  const boundedTerms = policy.__knowledgeTesting.searchTerms(longQuestion);
  assert.equal(boundedTerms.length, 64);
  assert.ok(boundedTerms.some((term) => longQuestion.slice(-3).includes(term)), "term cap should sample the end of a long question");
});

test("知识状态机只开放审核矩阵中的流转", () => {
  assert.equal(policy.knowledgeActionAllowed("pending", "approve"), true);
  assert.equal(policy.knowledgeActionAllowed("pending", "return"), true);
  assert.equal(policy.knowledgeActionAllowed("returned", "approve"), false);
  assert.equal(policy.knowledgeActionAllowed("active", "revoke"), true);
  assert.equal(policy.knowledgeActionAllowed("revoked", "revoke"), false);
});

test("知识公开范围与公开确认必须精确匹配", () => {
  assert.equal(policy.parseKnowledgeVisibility("internal"), "internal");
  assert.equal(policy.parseKnowledgeVisibility("public"), "public");
  for (const value of [undefined, null, "", " internal", "Public", "external"]) {
    assert.equal(policy.parseKnowledgeVisibility(value), null);
  }
  assert.equal(policy.isPublicKnowledgeConfirmation(policy.PUBLIC_KNOWLEDGE_CONFIRMATION), true);
  for (const value of [undefined, null, "", "publish_to_chat.omindos.ai ", "PUBLISH_TO_CHAT.OMINDOS.AI"]) {
    assert.equal(policy.isPublicKnowledgeConfirmation(value), false);
  }
});

test("系统管理员自操作审计标记不会截断原始审核意见", () => {
  const note = "审".repeat(policy.MAX_KNOWLEDGE_REVIEW_NOTE_LENGTH);
  const audited = policy.knowledgeAdminSelfAuditNote(note);
  assert.equal(audited.endsWith(note), true);
  assert.equal(audited.length, policy.KNOWLEDGE_ADMIN_SELF_AUDIT_MARKER.length + 1 + note.length);
  assert.equal(policy.isKnowledgeAdminSelfAuditNote(audited), true);
  assert.equal(policy.knowledgeAdminSelfAuditNote(""), policy.KNOWLEDGE_ADMIN_SELF_AUDIT_MARKER);
});

test("投稿内容哈希覆盖来源和正文且稳定", async () => {
  const first = await policy.hashKnowledgeSubmission(submission());
  const repeated = await policy.hashKnowledgeSubmission(submission());
  const changedSource = await policy.hashKnowledgeSubmission(submission({ sourceUrl: "https://example.com/new" }));
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.equal(first, repeated);
  assert.notEqual(first, changedSource);
});

test("未配置模型时返回有引用的摘录式答案", async () => {
  const ranked = policy.rankKnowledgeChunks("急停如何复位？", [{
    id: "chunk-1",
    itemId: "item-1",
    revisionId: "revision-1",
    title: "机械臂急停复位",
    category: "安全规范",
    sourceLabel: "实验室手册",
    sourceUrl: "https://example.com/safety",
    sectionTitle: "复位",
    paragraphRef: "第 2 段",
    content: "确认安全区无人后解除急停，再由值班人员执行复位。",
    searchText: "机械臂急停复位 确认安全区无人",
    updatedAt: "2026-09-10T00:00:00.000Z",
  }], 6);
  const result = await labAi.answerLabQuestion("急停如何复位？", ranked);
  assert.equal(result.mode, "extractive");
  assert.match(result.answer, /\[1\]/u);
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].itemId, "item-1");
  assert.equal(result.citations[0].sourceLabel, "实验室手册");

  const english = await labAi.answerLabQuestion("How should I reset the emergency stop?", ranked);
  assert.equal(english.mode, "extractive");
  assert.match(english.answer, /^Based on the reviewed laboratory knowledge base/u);
  const noEvidence = await labAi.answerLabQuestion("What evidence is available?", []);
  assert.equal(noEvidence.mode, "no_evidence");
  assert.match(noEvidence.answer, /^The knowledge base/u);
});

test("受保护模型端点返回 grounded 模式且请求只在服务端携带密钥", async () => {
  process.env.OA_LAB_AI_ENABLED = "true";
  process.env.OA_LAB_AI_ENDPOINT = "https://model.example.com/v1/chat/completions";
  const testApiKey = ["server", "only", "test", "value"].join("-");
  process.env.OA_LAB_AI_API_KEY = testApiKey;
  let captured;
  let upstreamAnswer = "复位前先确认安全区无人。[1]";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return Response.json({ choices: [{ message: { content: upstreamAnswer } }] });
  };
  try {
    const chunks = [{
      id: "chunk-1", itemId: "item-1", revisionId: "revision-1", title: "急停复位", category: "安全规范",
      sourceLabel: "安全手册", sourceUrl: "", sectionTitle: "复位", paragraphRef: "第 1 段",
      content: "确认安全区无人后解除急停。", searchText: "确认安全区无人后解除急停",
      updatedAt: "2026-09-10T00:00:00.000Z", score: 10,
    }, {
      id: "chunk-2", itemId: "item-2", revisionId: "revision-2", title: "复位责任人", category: "安全规范",
      sourceLabel: "值班规范", sourceUrl: "", sectionTitle: "责任", paragraphRef: "第 2 段",
      content: "复位操作必须由当日值班人员执行。", searchText: "复位操作 当日值班人员",
      updatedAt: "2026-09-09T00:00:00.000Z", score: 8,
    }];
    const result = await labAi.answerLabQuestion("急停如何复位？", chunks);
    assert.equal(result.mode, "grounded");
    assert.match(result.answer, /\[1\]/u);
    assert.equal(result.citations.length, 1, "只返回答案实际引用的知识片段");
    assert.equal(result.citations[0].itemId, "item-1");
    assert.equal(captured.url, process.env.OA_LAB_AI_ENDPOINT);
    assert.equal(captured.init.headers.authorization, `Bearer ${testApiKey}`);
    assert.equal(captured.init.redirect, "error");
    assert.equal(captured.body.store, false);
    assert.match(captured.body.messages[0].content, /不可信的参考数据/u);

    upstreamAnswer = "这是没有可靠依据的答案。[9]";
    const fallback = await labAi.answerLabQuestion("急停如何复位？", chunks);
    assert.equal(fallback.mode, "extractive");
    assert.doesNotMatch(fallback.answer, /没有可靠依据/u);
    assert.equal(fallback.citations.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("外部模型只有显式启用后才会接收内部知识", async () => {
  process.env.OA_LAB_AI_ENDPOINT = "https://model.example.com/v1/chat/completions";
  process.env.OA_LAB_AI_API_KEY = ["server", "only", "test", "value"].join("-");
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    return Response.json({ choices: [{ message: { content: "不应被调用。[1]" } }] });
  };
  try {
    const chunks = [{
      id: "chunk-1", itemId: "item-1", revisionId: "revision-1", title: "内部知识", category: "安全规范",
      sourceLabel: "安全手册", sourceUrl: "", sectionTitle: "说明", paragraphRef: "第 1 段",
      content: "这段内部知识不得在未显式启用模型时发送。", searchText: "内部知识 不得发送",
      updatedAt: "2026-09-10T00:00:00.000Z", score: 10,
    }];
    const result = await labAi.answerLabQuestion("内部知识是什么？", chunks);
    assert.equal(result.mode, "extractive");
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("外部模型端点校验阻止不安全地址并清理伪造引用", () => {
  const insecureRemote = ["http:", "//model.example.com/v1/chat"].join("");
  const localEndpoint = ["http:", "//127.0.0.1:8766/internal"].join("");
  assert.equal(labAi.__labAiTesting.safeEndpoint(insecureRemote), null);
  assert.equal(labAi.__labAiTesting.safeEndpoint("https://user:secret@model.example.com/v1/chat"), null);
  assert.equal(labAi.__labAiTesting.safeEndpoint(localEndpoint), localEndpoint);
  assert.equal(labAi.__labAiTesting.normalizeAnswer("答案 [9]", 2), "");
  assert.equal(labAi.__labAiTesting.normalizeAnswer("有依据 [1]，伪造依据 [9]", 2), "");
  assert.equal(labAi.__labAiTesting.normalizeAnswer("有依据 [1]，超长伪造依据 [1000]", 2), "");
});
