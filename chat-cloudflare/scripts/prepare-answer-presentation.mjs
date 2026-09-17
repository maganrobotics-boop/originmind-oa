import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const get = (path) => readFile(resolve(root, path), "utf8");
const put = (path, content) => writeFile(resolve(root, path), content);
function once(value, before, after) {
  if (!value.includes(before) && value.includes(after)) return value;
  if (value.split(before).length !== 2) throw new Error(`Unexpected source anchor: ${before.slice(0, 100)}`);
  return value.replace(before, () => after);
}
const shared = (await get("src/answer-presentation.mjs"))
  .replace('import { protectAnswerTechnicalText } from "./answer-math.mjs";\n', "")
  .replaceAll("export function ", "function ").trim();
let frontend = await get("frontend/app.js");
const sharedBlock = `// BEGIN SHARED ANSWER PRESENTATION\n${shared}\n// END SHARED ANSWER PRESENTATION\n\n`;
if (frontend.includes("// BEGIN SHARED ANSWER PRESENTATION")) {
  frontend = frontend.replace(/\/\/ BEGIN SHARED ANSWER PRESENTATION[\s\S]*?\/\/ END SHARED ANSWER PRESENTATION\n\n/u, () => sharedBlock);
} else {
  frontend = once(frontend, "function userFacingAnswer(value) {", `${sharedBlock}function userFacingAnswer(value) {`);
}
frontend = once(frontend,
  "const technical = protectAnswerTechnicalText(cleanPublicChatText(value));",
  "const technical = protectAnswerTechnicalText(cleanAnswerPresentation(cleanPublicChatText(value)));");
await put("frontend/app.js", frontend);

let app = await get("src/app.mjs");
app = once(app, 'import { protectAnswerTechnicalText } from "./answer-math.mjs";',
  'import { protectAnswerTechnicalText } from "./answer-math.mjs";\nimport { cleanAnswerPresentation } from "./answer-presentation.mjs";');
app = once(app, 'answer: cleanPublicChatText(result.answer) || fallbackAnswer([]),',
  'answer: cleanAnswerPresentation(cleanPublicChatText(result.answer)) || fallbackAnswer([]),');
app = once(app, 'function visibleAiAnswer(answer, sourceCount) {\n  const technical = protectAnswerTechnicalText(answer);',
  'function visibleAiAnswer(answer, sourceCount) {\n  const technical = protectAnswerTechnicalText(cleanAnswerPresentation(answer));');
app = once(app, 'content: document.body.slice(0, 3_500),',
  'content: cleanAnswerPresentation(document.body, { title: document.title, document: true }).slice(0, 3_500),');
app = once(app,
  '省略文件名的版本后缀和处理说明，不改变技术事实。',
  '省略文件名的版本后缀和处理说明，不改变技术事实。直接回答访客的问题，不输出“知识库中与这个问题直接相关的内容包括”“引自某文件”“出自某资料”等引导语，不照抄文件封面的标题、版本、更新时间、适用范围。将相关内容组织为结论、解释和必要细节；保留真正与问题相关的技术版本、日期和参数。');
await put("src/app.mjs", app);

let knowledge = await get("src/knowledge.mjs");
knowledge = once(knowledge, 'import { PublicError } from "./errors.mjs";',
  'import { PublicError } from "./errors.mjs";\nimport { cleanAnswerPresentation, boundedKnowledgeExcerpt } from "./answer-presentation.mjs";');
const start = knowledge.indexOf("export function fallbackAnswer(documents) {");
const end = knowledge.indexOf("export function safeSourceUrl(value) {");
if (start < 0 || end <= start) throw new Error("Missing fallback function boundaries");
knowledge = knowledge.slice(0, start) + `export function fallbackAnswer(documents) {
  const excerpts = [];
  const seen = new Set();
  for (const document of documents) {
    const clean = typeof document?.body === "string"
      ? cleanAnswerPresentation(document.body, { title: document.title, document: true })
      : "";
    const key = clean.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\\s+/gu, " ");
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    excerpts.push(boundedKnowledgeExcerpt(clean));
    if (excerpts.length === 3) break;
  }
  if (!excerpts.length) {
    return "目前没有足够信息回答这个问题。你可以补充具体方向、对象或时间范围。";
  }
  // Keep actual paragraph/list boundaries: never wrap a whole Markdown document in one bullet.
  return excerpts.join("\\n\\n");
}

` + knowledge.slice(end);
await put("src/knowledge.mjs", knowledge);

let suggestions = await get("test/suggestions.test.mjs");
suggestions = once(suggestions, 'const repeated = `公开内容${"甲".repeat(600)}`;', 'const repeated = `公开内容${"甲".repeat(2200)}`;');
suggestions = once(suggestions,
  'assert.match(answer, /^知识库中与这个问题直接相关的内容包括：/u);',
  'assert.doesNotMatch(answer, /知识库中与这个问题直接相关的内容包括/u);');
suggestions = once(suggestions,
  'assert.equal((answer.match(/^- /gmu) || []).length, 2);',
  'assert.equal((answer.match(/公开内容/gu) || []).length, 1);');
await put("test/suggestions.test.mjs", suggestions);
console.log("Prepared Worker, frontend, model prompt and regression tests without modifying OA data.");
