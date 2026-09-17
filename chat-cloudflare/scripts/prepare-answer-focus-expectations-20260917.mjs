import { readFile, writeFile } from "node:fs/promises";
function replace(text, before, after, count = 1) {
  if (text.split(before).length - 1 !== count) throw new Error(`Unexpected anchor count: ${before}`);
  return text.split(before).join(after);
}
async function edit(path, transform) {
  const before = await readFile(path, "utf8");
  await writeFile(path, transform(before));
}
await edit("chat-cloudflare/test/chat-experience-worker.test.mjs", (text) => {
  text = replace(text, "an exact recommended question receives its approved content even without a model", "an exact recommended question retains approved sources but never dumps them when the model fails");
  text = replace(text, "  assert.equal(result.answer, excerpt);", "  assert.match(result.answer, /未能生成完整答复/u);\n  assert.notEqual(result.answer, excerpt);\n  assert.equal(result.sources[0].excerpt, excerpt);");
  return replace(text,
    "  assert.match((await response.json()).answer, /设备巡检/u);",
    "  const result = await response.json();\n  assert.match(result.answer, /未能生成完整答复/u);\n  assert.doesNotMatch(result.answer, /设备巡检/u);\n  assert.match(result.sources[0].excerpt, /设备巡检/u);"
  );
});
await edit("chat-cloudflare/test/suggestions.test.mjs", (text) => {
  text = replace(text, "retrieved knowledge remains a substantive answer when the model is unavailable", "retrieved knowledge remains source evidence rather than an answer when the model is unavailable");
  text = replace(text,
    '  assert.equal((await response.json()).answer, "触觉反馈帮助机器人调整抓取物体时的力度。");',
    '  const answered = await response.json();\n  assert.match(answered.answer, /未能生成完整答复/u);\n  assert.doesNotMatch(answered.answer, /触觉反馈/u);\n  assert.equal(answered.sources[0].excerpt, "触觉反馈帮助机器人调整抓取物体时的力度。");'
  );
  return replace(text,
    "    assert.match(result.answer, /ROS2/u);",
    '    if (mode === "ai") assert.match(result.answer, /ROS2/u);\n    else {\n      assert.match(result.answer, /未能生成完整答复/u);\n      assert.doesNotMatch(result.answer, /ROS2/u);\n    }\n    assert.match(result.sources[0].excerpt, /ROS2/u);'
  );
});
await edit("chat-cloudflare/test/worker-contract.test.mjs", (text) => {
  text = replace(text, "a failed real chat call returns knowledge while replacing a cached green Qwen status", "a failed real chat reports failure without excerpts and replaces a cached green Qwen status");
  text = replace(text,
    "  assert.equal(failedResult.answer, OA_CHUNKS[0].excerpt);",
    "  assert.match(failedResult.answer, /未能生成完整答复/u);\n  assert.notEqual(failedResult.answer, OA_CHUNKS[0].excerpt);\n  assert.equal(failedResult.sources[0].excerpt, OA_CHUNKS[0].excerpt);"
  );
  text = replace(text,
    "  assert.equal(result.answer, OA_CHUNKS[0].excerpt);",
    "  assert.match(result.answer, /未能生成完整答复/u);\n  assert.notEqual(result.answer, OA_CHUNKS[0].excerpt);\n  assert.equal(result.sources[0].excerpt, OA_CHUNKS[0].excerpt);", 3
  );
  return replace(text, "fall back to retrieved knowledge", "fail safely without returning retrieved text", 3);
});
await edit("chat-cloudflare/test/worker.test.mjs", (text) => {
  text = replace(text, "an oversized Bailian response falls back to retrieved knowledge", "an oversized Bailian response fails safely without returning retrieved text");
  return replace(text,
    '  assert.equal(result.body.answer, "经 OA 审核公开的资料包括机器人灵巧操作与机器人系统设计。");',
    '  assert.match(result.body.answer, /未能生成完整答复/u);\n  assert.doesNotMatch(result.body.answer, /机器人灵巧操作/u);\n  assert.equal(result.body.sources[0].excerpt, "经 OA 审核公开的资料包括机器人灵巧操作与机器人系统设计。");'
  );
});
console.log("Updated nine legacy fallback expectations; retained source binding, token, history, transport and status assertions.");
