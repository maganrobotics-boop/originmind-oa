import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../src/app.mjs";
import { encryptSecret } from "../src/crypto.mjs";
import { parseOaResult } from "../src/oa-public.mjs";
import { MockD1 } from "./contract-mock-d1.mjs";

const ORIGIN = "https://chat.omindos.ai";
const OA_URL = "https://oa.omindos.ai/api/public/lab-ai/retrieve";
const IMAGE_URL = "https://oa.omindos.ai/api/public/lab-ai/assets/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const KEY = "encryption-key-for-tests-only-0123456789abcdef";
const ASSET = { url: IMAGE_URL, alt: "图 1 避障过程", mimeType: "image/webp" };
const CHUNK = {
  id: "1", title: "机器人导航研究", category: "research", sectionTitle: "避障实验",
  paragraphRef: "第 1 段", excerpt: "导航系统通过传感器反馈完成避障。", sourceLabel: "OA 公开知识",
  updatedAt: "2026-09-16", assets: [ASSET],
};

async function chat({ answer, chunks = [CHUNK], provider = "workers-ai", finishReason = "stop" }) {
  let modelInput;
  const env = {
    APP_ORIGIN: ORIGIN, ADMIN_EMAIL: "owner@example.test", APP_ENCRYPTION_KEY: KEY,
    RATE_LIMIT_HMAC_KEY: "r".repeat(48), PUBLIC_LAB_AI_SERVICE_TOKEN: "A".repeat(43),
    RELEASE_ID: `${"a".repeat(40)}-1`, DB: new MockD1(),
  };
  const completion = { choices: [{ message: { role: "assistant", content: answer }, finish_reason: finishReason }] };
  if (provider === "workers-ai") {
    env.AI = { run: async (_model, input) => { modelInput = input; return completion; } };
  } else if (provider === "bailian") {
    env.DB = new MockD1({ settings: { model: JSON.stringify({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus",
      encryptedKey: await encryptSecret("test-key", KEY), verifiedAt: "2026-09-16T00:00:00.000Z",
    }) } });
  }
  const response = await handleRequest(new Request(`${ORIGIN}/api/chat`, {
    method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.90" },
    body: JSON.stringify({ topic: "research", messages: [{ role: "user", content: "请详细说明机器人的避障实验，并配图。" }] }),
  }), env, {}, { fetch: async (url, init) => {
    if (String(url) === OA_URL) return Response.json({ chunks });
    modelInput = JSON.parse(init.body);
    return Response.json(completion);
  } });
  assert.equal(response.status, 200);
  return { result: await response.json(), modelInput };
}

for (const provider of ["workers-ai", "bailian"]) {
  test(`${provider} returns a grounded answer longer than 12,000 characters intact`, async () => {
    const body = `${"详细说明机器人导航中的反馈控制。".repeat(950)}全文结束。`;
    const { result, modelInput } = await chat({ provider, answer: `${body}[1]` });
    assert.equal(result.mode, "ai");
    assert.equal(result.answer, body);
    assert.ok(result.answer.length > 12_000);
    assert.deepEqual(result.images, []);
    assert.doesNotMatch(modelInput.messages[0].content, /两到四个短段落|不超过四列|不要输出 HTML、图片/u);
    assert.match(modelInput.messages[0].content, /回答篇幅由问题和用户需求决定/u);
    assert.match(modelInput.messages[0].content, /没有读取图像像素/u);
    if (provider === "bailian") assert.equal(Object.hasOwn(modelInput, "max_tokens"), false);
    else assert.equal(modelInput.max_tokens, 16_384);
  });

  test(`${provider} preserves partial content and makes provider length stops visible`, async () => {
    const { result } = await chat({ provider, answer: "已完成的实验说明。[1]", finishReason: "length" });
    assert.equal(result.mode, "ai");
    assert.match(result.answer, /^已完成的实验说明。/u);
    assert.match(result.answer, /回答尚未结束.*继续/u);
  });

  test(`${provider} keeps the continuation notice after removing model reference sections`, async () => {
    const { result } = await chat({ provider, answer: "已完成的实验说明。[1]\n\n参考资料：\n[1] 导航研究", finishReason: "length" });
    assert.equal(result.mode, "ai");
    assert.match(result.answer, /回答尚未结束.*继续/u);
    assert.doesNotMatch(result.answer, /参考资料/u);
  });
}

test("retrieved OA image metadata reaches the model and approved images remain inline", async () => {
  const { result, modelInput } = await chat({ answer: `导航系统通过反馈避障。[1]\n\n![模型随意生成的标题 99](${IMAGE_URL})\n\n实验说明结束。[1]` });
  assert.equal(result.mode, "ai");
  assert.equal(result.answer, `导航系统通过反馈避障。\n\n![图 1 避障过程](${IMAGE_URL})\n\n实验说明结束。`);
  assert.deepEqual(result.images, [{ url: IMAGE_URL, alt: ASSET.alt }]);
  assert.ok(modelInput.messages[0].content.includes(IMAGE_URL));
  assert.ok(modelInput.messages[0].content.includes(ASSET.alt));
});

test("the citation number inside a numeric image caption cannot validate unsupported text", async () => {
  const { result } = await chat({ answer: `未引用资料的说明。\n\n![1](${IMAGE_URL})` });
  assert.equal(result.mode, "retrieval");
  assert.doesNotMatch(result.answer, /未引用资料/u);
});

test("public images absent from this retrieval and arbitrary external images fail closed", async () => {
  for (const url of [
    "https://oa.omindos.ai/api/public/lab-ai/assets/11111111-2222-4333-8444-555555555555",
    "https://oa.omindos.ai/api/knowledge/private-image",
    "https://example.test/tracker.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
  ]) {
    const { result } = await chat({ answer: `模型正文。[1]\n\n![图](${url})` });
    assert.equal(result.mode, "retrieval", url);
    assert.ok(!result.answer.includes(url), url);
    assert.deepEqual(result.images, [{ url: IMAGE_URL, alt: ASSET.alt }]);
  }
});

test("images in removed reference sections are not returned as used images", async () => {
  const { result } = await chat({ answer: `模型正文。[1]\n\n参考资料：\n![图](${IMAGE_URL})` });
  assert.equal(result.mode, "ai");
  assert.equal(result.answer, "模型正文。");
  assert.deepEqual(result.images, []);
});

test("an image needs a citation to its own retrieved chunk", async () => {
  const { result } = await chat({
    chunks: [{ ...CHUNK, assets: undefined }, { ...CHUNK, id: "2" }],
    answer: `只引用第一份文字。[1]\n\n![图](${IMAGE_URL})`,
  });
  assert.equal(result.mode, "retrieval");
});

test("extractive fallback includes approved images while dropping original relative image markup", async () => {
  const { result } = await chat({ provider: "none", chunks: [{ ...CHUNK, excerpt: `导航系统避障说明。![图 1](assets/navigation.webp)` }] });
  assert.equal(result.mode, "retrieval");
  assert.ok(result.answer.includes(`![图 1 避障过程](${IMAGE_URL})`));
  assert.doesNotMatch(result.answer, /assets\/navigation/u);
  assert.deepEqual(result.images, [{ url: IMAGE_URL, alt: ASSET.alt }]);
});

test("OA assets require the exact public endpoint and strict bounded metadata", () => {
  assert.deepEqual(parseOaResult({ chunks: [CHUNK] })[0].assets, [ASSET]);
  for (const asset of [
    { ...ASSET, url: `${IMAGE_URL}?token=secret` },
    { ...ASSET, url: `${IMAGE_URL}#fragment` },
    { ...ASSET, url: IMAGE_URL.replace("https:", "http:") },
    { ...ASSET, url: IMAGE_URL.replace("oa.omindos.ai", "oa.omindos.ai.example.test") },
    { ...ASSET, url: IMAGE_URL.replace("/public/lab-ai/", "/knowledge/") },
    { ...ASSET, alt: "图".repeat(201) },
    { ...ASSET, mimeType: "image/svg+xml" },
    { ...ASSET, storageKey: "knowledge/private/key" },
  ]) assert.throws(() => parseOaResult({ chunks: [{ ...CHUNK, assets: [asset] }] }), /OA_RESPONSE_INVALID/u);
  assert.throws(() => parseOaResult({ chunks: [{ ...CHUNK, assets: [ASSET, ASSET] }] }), /OA_RESPONSE_INVALID/u);
  assert.throws(() => parseOaResult({ chunks: [{ ...CHUNK, assets: [ASSET, ASSET, ASSET] }] }), /OA_RESPONSE_INVALID/u);
  assert.throws(() => parseOaResult({ chunks: Array.from({ length: 4 }, (_, index) => ({
    ...CHUNK, id: String(index + 1), assets: [ASSET, { ...ASSET, url: IMAGE_URL.replace("aaaaaaaa", "bbbbbbbb") }],
  })) }), /OA_RESPONSE_INVALID/u);
});
