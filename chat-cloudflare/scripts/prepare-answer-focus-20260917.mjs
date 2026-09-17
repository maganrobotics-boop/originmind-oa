import { readFile, writeFile } from "node:fs/promises";

async function edit(path, transform) {
  const before = await readFile(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`No change: ${path}`);
  await writeFile(path, after);
}
function once(text, before, after) {
  if (text.split(before).length !== 2) throw new Error(`Expected one anchor: ${before.slice(0, 100)}`);
  return text.replace(before, after);
}

await edit("chat-cloudflare/src/knowledge.mjs", (text) => {
  text = once(text, 'import { protectAnswerTechnicalText } from "./answer-math.mjs";\n', "");
  text = once(text, 'import { cleanAnswerPresentation, boundedKnowledgeExcerpt } from "./answer-presentation.mjs";\n', "");
  const start = text.indexOf("export function fallbackAnswer(documents) {");
  const end = text.indexOf("\nexport function safeSourceUrl", start);
  if (start < 0 || end < 0) throw new Error("Fallback boundaries missing");
  return text.slice(0, start) + `export function fallbackAnswer(documents = []) {
  // Retrieval establishes available evidence, not whether an excerpt answers
  // the user's question. Never present unsynthesized bodies as the answer,
  // including ordinary prose (not only slides), duplicates, tables or formulas.
  // Keep documents and source bindings untouched for diagnostics and grounding.
  if (documents.length) {
    return "这次未能生成完整答复，请重试。为避免答非所问，暂不直接展示检索到的文档片段。";
  }
  return "目前没有足够信息回答这个问题。你可以补充具体方向、对象或时间范围。";
}
` + text.slice(end);
});

await edit("chat-cloudflare/src/app.mjs", (text) => once(text,
  '            "历史对话仅用于理解追问，旧回答不能替代本次检索资料；具体事实仍须由本次参考资料支持。" +',
  '            "按问题范围回答：只问谁负责、在哪里、何时或某个参数时，第一句先回答对应的人物、地点、时间或参数，只补充与该问题直接相关的必要信息。问负责人时，不用实验室定位、培养特点、研究方向或整篇介绍替代负责人信息。资料没有明确写出所问事实时直接说明不能确认，不从作者、顾问或项目成员身份推断负责人。不要为了凑篇幅添加无关章节；不沿用摘录中从第七节等位置开始的原始章节编号，不拼接多个版本的整篇简介。用户要求详细介绍、解释技术或提出多个问题时，仍应充分、完整回答，不设固定短篇幅。" +\n' +
  '            "历史对话仅用于理解追问，旧回答不能替代本次检索资料；具体事实仍须由本次参考资料支持。" +'
));

await edit("chat-cloudflare/test/answer-presentation-integration.test.mjs", (text) => {
  const start = text.indexOf('test("cleaned fallback retains paragraphs, subheadings and substantive content",');
  const end = text.indexOf('\nfor (const mode of ["ai", "retrieval"])', start);
  if (start < 0 || end < 0) throw new Error("Old fallback test boundaries missing");
  text = text.slice(0, start) + `test("failed synthesis never passes normal Markdown excerpts off as an answer", () => {
  const answer = fallbackAnswer([{ title: "科研方向介绍", body: raw }, { title: "同一资料", body: raw }]);
  assert.match(answer, /未能生成完整答复/u);
  assert.doesNotMatch(answer, /定位与导航|智能操作|自主移动|版本|更新时间|适用范围|知识库中|#/u);
  assert.doesNotMatch(fallbackAnswer([]), /提交咨询/u);
});

` + text.slice(end);
  return once(text,
    '    assert.match(result.answer, /定位与导航/u);',
    '    if (mode === "ai") assert.match(result.answer, /定位与导航/u);\n    else {\n      assert.match(result.answer, /未能生成完整答复/u);\n      assert.doesNotMatch(result.answer, /定位与导航|自主移动|智能操作/u);\n    }'
  );
});

await edit("chat-cloudflare/test/suggestions.test.mjs", (text) => {
  text = once(text,
    '  assert.equal(result.answer, "团队已公开机器人灵巧操作与系统设计方面的研究内容。");',
    '  assert.match(result.answer, /未能生成完整答复/u);\n  assert.doesNotMatch(result.answer, /团队已公开机器人灵巧操作/u);'
  );
  const start = text.indexOf('test("extractive fallback deduplicates and bounds approved knowledge excerpts",');
  const end = text.indexOf('\ntest("questions come from excerpt topics,', start);
  if (start < 0 || end < 0) throw new Error("Excerpt test boundaries missing");
  return text.slice(0, start) + `test("fallback never concatenates duplicate or long approved excerpts", () => {
  const repeated = \`公开内容\${"甲".repeat(2200)}\`;
  const answer = fallbackAnswer([{ body: repeated }, { body: repeated }, { body: "另一条公开内容。" }]);
  assert.match(answer, /未能生成完整答复/u);
  assert.doesNotMatch(answer, /公开内容|甲|另一条|知识库中与这个问题直接相关的内容包括/u);
});
` + text.slice(end);
});

await edit("chat-cloudflare/scripts/check-answer-layout-browser.mjs", (text) => {
  text = once(text,
    '  ["structured-fallback", fallbackAnswer([{title:"示例机器人公司",body:markdown}])],',
    '  ["structured-answer", markdown],\n  ["failed-prose-synthesis", fallbackAnswer([{title:"示例机器人公司",body:markdown}])],'
  );
  return once(text,
    '        if(scenario!=="failed-slide-synthesis") {',
    '        if(!scenario.startsWith("failed-")) {'
  );
});
console.log("Applied question-focus policy and fail-closed answer fallback; retained technical rendering checks.");
