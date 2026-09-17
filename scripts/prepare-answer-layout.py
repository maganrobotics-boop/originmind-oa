from pathlib import Path

root = Path('.')
def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('unexpected source anchor: ' + old[:120])
    return text.replace(old, new, 1)

p = root / 'app/api/public/lab-ai/_lib/response-contract.ts'
s = p.read_text()
s = replace_once(s, 'import { cleanPublicChatText }', 'import { answerCodeTokenAt, answerMathTokenAt } from "../../../../../chat-cloudflare/src/answer-math.mjs";\nimport { cleanPublicChatText }')
a = s.index('function boundedExcerpt(')
b = s.index('\nfunction validDate(', a)
s = s[:a] + r'''// Labels are single-line; document bodies are not. Flattening Markdown here
// destroys headings/tables before either the model or the renderer sees them.
function normalizedContent(value: string): string {
  return makeWellFormed(value).replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ").trim();
}

function boundedExcerpt(value: string, maxLength: number): string {
  const normalized = normalizedContent(value);
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 1) return "…";
  let end = safePrefix(normalized, maxLength - 1).length;
  // Never send an unclosed formula or code token solely because the transport
  // budget ends inside it. Keep the same strict character and byte ceilings.
  let boundary = 0;
  for (let index = 0; index < end;) {
    const token = (normalized[index] === "`" || normalized[index] === "~" ? answerCodeTokenAt(normalized, index) : null)
      || (normalized[index] === "\\" || normalized[index] === "$" ? answerMathTokenAt(normalized, index) : null);
    if (token) {
      if (token.end > end) { end = index; break; }
      index = token.end;
    } else {
      if (normalized[index] === "\n") boundary = index;
      else if (/[。！？]/u.test(normalized[index])) boundary = index + 1;
      index += 1;
    }
  }
  const prefix = normalized.slice(0, boundary > end / 2 ? boundary : end);
  return `${prefix.trimEnd()}…`;
}
''' + s[b:]
s = replace_once(s, 'const content = boundedLine(chunk.content, Number.MAX_SAFE_INTEGER);', 'const content = normalizedContent(chunk.content);')
p.write_text(s)

p = root / 'chat-cloudflare/src/answer-presentation.mjs'
s = p.read_text()
helper = r'''// Recover only unambiguous, pipe-bounded rows with a real Markdown divider.
// Empty/escaped cells and malformed rows remain untouched; never guess cells.
function restoreFlattenedAnswerTables(value) {
  return value.split("\n").map((line) => {
    if (!/\|[ \t]*:?-{3,}:?[ \t]*\|/u.test(line)) return line;
    const rows = line.split(/\|[ \t]*\|/u);
    if (rows.length < 3) return line;
    for (let index = 1; index < rows.length; index += 1) {
      const divider = rows[index].split("|").map((cell) => cell.trim());
      if (divider.length < 2 || divider.length > 8 || !divider.every((cell) => /^:?-{3,}:?$/u.test(cell))) continue;
      const firstPipe = rows[index - 1].indexOf("|");
      if (firstPipe < 0) continue;
      const prefix = rows[index - 1].slice(0, firstPipe).trim();
      const header = rows[index - 1].slice(firstPipe + 1).split("|").map((cell) => cell.trim());
      if (header.length !== divider.length || header.some((cell) => !cell || /\\|\uE000/u.test(cell))) continue;
      const output = [`| ${header.join(" | ")} |`, `| ${divider.join(" | ")} |`];
      let last = index;
      for (let row = index + 1; row < rows.length; row += 1) {
        const cells = rows[row].replace(/\|[ \t]*$/u, "").split("|").map((cell) => cell.trim());
        if (cells.length !== header.length || cells.some((cell) => !cell || /\\|\uE000/u.test(cell))) break;
        output.push(`| ${cells.join(" | ")} |`); last = row;
      }
      if (last === index) continue;
      // A single table only; leave any unparsed suffix visible, not reassigned.
      const before = rows.slice(0, index - 1).join("||");
      const after = rows.slice(last + 1).join("||");
      return [before, prefix, output.join("\n"), after].filter(Boolean).join("\n\n");
    }
    return line;
  }).join("\n");
}

'''
s = replace_once(s, '// Keep this function identical in frontend/app.js.', helper + '// Keep this function identical in frontend/app.js.')
s = replace_once(s, '  if (legacy || flattenedMetadata) {', r'''  const collapsedBlocks = /[^\n][ \t]+#{2,6}[ \t]+\S/u.test(text) ||
    /\|[ \t]*\|[ \t]*:?-{3,}:?[ \t]*\|/u.test(text);
  if (legacy || flattenedMetadata || collapsedBlocks) {''')
s = replace_once(s, '  const lines = text.split("\\n");', r'''  text = restoreFlattenedAnswerTables(text);
  // Slides often join a numbered page title to its body after the English
  // page label. Split at that explicit boundary rather than guessing words.
  text = text.replace(/^(#{1,6}[ \t]+第[ \t]*\d+[ \t]*页[^\n()（）]{0,70}[（(][A-Z][A-Z \d-]{2,60}[)）])[ \t]*(?=\S)/gmu, "$1\n\n");
  const lines = text.split("\n");''')
s = replace_once(s, '  const headerMode = document || legacy || flattenedMetadata ||', '  const headerMode = document || legacy || flattenedMetadata || collapsedBlocks ||')
s = replace_once(s, '    if (sourceLine.test(line)) continue;', r'''    if (sourceLine.test(line)) continue;
    // Only whole metadata lines are suppressed. Restriction notices remain
    // in source data and must never be treated as public-sharing permission.
    if (headerMode && /^[ \t]*(?:>[ \t]*)?(?:页脚|视觉说明)[ \t]*[:：]/u.test(line)) continue;
    if (/^[ \t]*参考(?:公司|实验室)(?:主页|官网)(?:的)?(?:介绍和描述|介绍|描述)[。.]?[ \t]*$/u.test(line)) continue;''')
s = replace_once(s, '      if ((document && matchesTitle) || (headerMode && followedByMetadata)) continue;', '''      if ((document && matchesTitle) || (headerMode && followedByMetadata)) continue;
      // A collapsed page must not turn hundreds of body characters bold.
      if (heading[1].length > 100) line = heading[1];''')
p.write_text(s)

p = root / 'chat-cloudflare/frontend/app.js'
app = p.read_text()
a = app.index('// BEGIN SHARED ANSWER PRESENTATION')
b = app.index('// END SHARED ANSWER PRESENTATION', a)
shared = s.replace('import { protectAnswerTechnicalText } from "./answer-math.mjs";\n', '').replace('export function ', 'function ').strip()
app = app[:a] + '// BEGIN SHARED ANSWER PRESENTATION\n' + shared + '\n' + app[b:]
anchor = 'function appendAnswerInline(parent, text, technical = null, depth = 0, budget = { count: 0, characters: 0 }) {'
link = r'''function answerDisplayLinkAt(text, index) {
  const image = text.startsWith("![", index);
  const start = image ? index + 1 : index;
  if (text[start] !== "[") return null;
  const labelEnd = text.indexOf("](", start + 1);
  if (labelEnd < 0 || labelEnd - start > 500 || /[\n\r]/u.test(text.slice(start, labelEnd))) return null;
  let nesting = 1;
  for (let end = labelEnd + 2; end < Math.min(text.length, labelEnd + 2050); end += 1) {
    if (text[end] === "\\") { end += 1; continue; }
    if (text[end] === "(") nesting += 1;
    if (text[end] === ")" && --nesting === 0) return { label: text.slice(start + 1, labelEnd), image, end: end + 1 };
    if (text[end] === "\n") return null;
  }
  return null;
}

'''
app = replace_once(app, anchor, link + anchor)
old = '    if (text[index] === "`") {\n      const code = answerCodeTokenAt(text, index);\n      if (code?.content !== undefined)'
new = '''    const link = answerDisplayLinkAt(text, index);
    if (link) {
      flush();
      if (link.label) appendAnswerInline(parent, link.label, technical, depth + 1, budget);
      index = link.end; continue;
    }
''' + old
app = replace_once(app, old, new)
p.write_text(app)

p = root / 'chat-cloudflare/src/knowledge.mjs'
s = p.read_text()
s = replace_once(s, 'import { PublicError }', 'import { protectAnswerTechnicalText } from "./answer-math.mjs";\nimport { PublicError }')
s = replace_once(s, '  for (const document of documents) {\n    const clean', r'''  for (const document of documents) {
    const raw = protectAnswerTechnicalText(document?.body ?? "").text;
    // A failed synthesis is not permission to dump a slide deck (or its
    // distribution notices) as an answer. Keep clean, useful excerpts only.
    if (/(?:^|[ \t\n])#{1,6}[ \t]+第[ \t]*\d+[ \t]*页|(?:^|[\n 。])(?:页脚|视觉说明)[ \t]*[:：]|仅供[^\n]{0,60}(?:交流|内部使用)|未经许可请勿转发/u.test(raw)) continue;
    const clean''')
s = replace_once(s, '  if (!excerpts.length) {\n    return', '''  if (!excerpts.length && documents.length) {
    return "这次未能生成完整答复，请重试。为避免把未经整理的文档片段当作回答，暂不直接展示这些片段。";
  }
  if (!excerpts.length) {
    return''')
p.write_text(s)
p = root / 'chat-cloudflare/src/app.mjs'
s = p.read_text()
needle = 'mode: "retrieval",\n          oaPublicStatus:'
assert s.count(needle) == 3
for reason in ['documents.length ? "model_unavailable" : "no_documents"', '"generation_failed"', '"answer_validation_failed"']:
    s = s.replace(needle, f'mode: "retrieval",\n          fallbackReason: {reason},\n          oaPublicStatus:', 1)
s = replace_once(s, '不照抄文件封面的标题、版本、更新时间、适用范围。', '不照抄文件封面的标题、版本、更新时间、适用范围、幻灯片页码、页脚和视觉说明。不输出网址、邮箱、电话号码或 Markdown 链接，直接用自然语言回答问题。')
p.write_text(s)

p = root / '.github/workflows/check-chat-cloudflare.yml'
s = p.read_text()
s = replace_once(s, '          node chat-cloudflare/scripts/check-formula-runtime-browser.mjs', '          node chat-cloudflare/scripts/check-formula-runtime-browser.mjs\n          node chat-cloudflare/scripts/check-answer-layout-browser.mjs')
p.write_text(s)

p = root / 'chat-cloudflare/test/answer-presentation-integration.test.mjs'
s = p.read_text()
s += r'''

test("restores collapsed table and headings without the old metadata trigger", () => {
  const old = "公司从事机器人研发。 ## 功能介绍\n\n| 场景 | 功能 | |---|---| | 金属矿 | 巡检 | | 工厂 | 运输 |";
  const clean = api.userFacingAnswer(old);
  const rendered = api.renderAnswerBody(clean);
  assert.equal(nodes(rendered, "table").length, 1);
  assert.equal(nodes(rendered, "td").length, 4);
  assert.doesNotMatch(rendered.textContent, /##|\|/u);
  assert.match(rendered.textContent, /公司从事机器人研发/u);
  assert.equal(api.userFacingAnswer(clean), clean);
});

test("a flattened slide body does not become a giant bold heading", () => {
  const old = "## 第 12 页商业化(COMMERCIALIZATION 12) " + "先完成样机测试，再验证现场可靠性。".repeat(20);
  const rendered = api.renderAnswerBody(api.userFacingAnswer(old));
  assert.ok(nodes(rendered, "h4").every((node) => node.textContent.length < 100));
  assert.ok(nodes(rendered, "p").some((node) => node.textContent.length > 100));
});

test("Markdown links display readable labels but never activate model URLs", () => {
  const rendered = api.renderAnswerBody("[官网](https://example.test/path_(a))、[联系](mailto:a@example.test)、[错误](javascript:alert(1))。\\n\\n`[原文](https://example.test)`");
  assert.equal(nodes(rendered, "a").length, 0);
  assert.equal(nodes(rendered, "img").length, 0);
  assert.match(rendered.textContent, /官网、联系、错误。/u);
  assert.doesNotMatch(rendered.textContent, /mailto:|javascript:/u);
  assert.match(nodes(rendered, "code")[0].textContent, /https:\/\/example/u);
});

test("raw investor-slide fallback is not passed off as a company introduction", () => {
  const answer = fallbackAnswer([{title:"示例公司", body:"## 第 1 页封面(INVESTOR BRIEF) 示例企业。 仅供投资人交流未经许可请勿转发。"}]);
  assert.match(answer, /未能生成完整答复/u);
  assert.doesNotMatch(answer, /INVESTOR|第 1 页|示例企业|投资人/u);
});
'''
p.write_text(s)
