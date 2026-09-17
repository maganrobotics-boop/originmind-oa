/* Generated from Chat's DOM-safe answer renderer; do not edit. */
/* eslint-disable */


function cleanPublicChatText(value) {
  const text = String(value ?? "");
  if (!/(?:脱[ \t]*敏|脱[ \t]*密|匿名化|去标识化|\b(?:saniti[sz]ed|anonymi[sz]ed|de-identified|redacted)\b)/iu.test(text.replace(/[\u200B-\u200D\uFEFF]/gu, ""))) return text.trim();
  return text
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/(?:已|经)?(?:脱[ \t]*敏|脱[ \t]*密|匿名化|去标识化)(?:处理)?(?:版本|版)?/gu, "")
    .replace(/\b(?:saniti[sz]ed|anonymi[sz]ed|de-identified|redacted)(?:[ -]+version)?\b/giu, "")
    .replace(/[（(【\[][ \t]*[）)】\]]/gu, "")
    .replace(/[ \t]+([，。！？；：）》】])/gu, "$1")
    .replace(/([《（【])[ \t]+/gu, "$1")
    .replace(/[_-]+(?=[》）】]|$)/gmu, "")
    .replace(/[ \t]+$/gmu, "")
    .trim();
}


function element(tagName, options = {}, children = []) {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.id) node.id = options.id;
  if (options.text !== undefined && options.text !== null) {
    node.textContent = String(options.text);
  }
  for (const [name, value] of Object.entries(options.attributes || {})) {
    if (value !== undefined && value !== null && value !== false) {
      node.setAttribute(name, value === true ? "" : String(value));
    }
  }
  const childList = Array.isArray(children) ? children : [children];
  for (const child of childList) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}


function referenceSectionStart(value) {
  const lineMarkers = [
    value.match(
      /^[ \t]*(?:(?:[-+*•>]|[0-9０-９]+[.)、．。])[ \t]+)?(?:#{1,6}[ \t]+)?(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:(?:参考资料|参考文献|参考来源|资料来源|参考|引用|出处)(?:列表|清单)?|(?:references?|sources?|citations?|bibliography)(?:[ \t]+list)?|works[ \t]+cited|(?:来源|source)(?:列表|清单|[ \t]+list)?)(?:如下(?:所示)?)?[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:[:：]|(?=[\[［【]\s*[0-9０-９]))/imu,
    ),
    value.match(
      /^[ \t]*(?:(?:[-+*•>]|[0-9０-９]+[.)、．。])[ \t]+)?(?:#{1,6}[ \t]+)?(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:(?:参考资料|参考文献|参考来源|资料来源|参考|引用|出处)(?:列表|清单)?|(?:references?|sources?|citations?|bibliography)(?:[ \t]+list)?|works[ \t]+cited|(?:来源|source)(?:列表|清单|[ \t]+list)?)(?:如下(?:所示)?)?[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:[:：])?[ \t]*$/imu,
    ),
    value.match(
      /(?:^|\r?\n)[ \t]*(?:[-+*•>][ \t]+)?[\[［【]\s*[0-9０-９]+(?:\s*[,，、;；\-–—]\s*[0-9０-９]+)*\s*[\]］】]/u,
    ),
  ].filter(Boolean);
  const inlineMarker = value.match(
    /(^|[^\p{L}\p{N}_*`#~-])(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:参考资料|参考文献|参考来源|资料来源|参考|引用|出处)(?:列表|清单)?(?:如下(?:所示)?)?[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*[:：]/iu,
  );
  const inlineCitationMarker = value.match(
    /(^|[^\p{L}\p{N}_*`#~-])(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:(?:参考资料|参考文献|参考来源|资料来源|参考|引用|出处)(?:列表|清单)?|(?:references?|sources?|citations?|bibliography)(?:[ \t]+list)?|works[ \t]+cited)[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?=[\[［【]\s*[0-9０-９])/iu,
  );
  const indexes = lineMarkers.map((marker) => marker.index);
  if (inlineMarker) indexes.push(inlineMarker.index + inlineMarker[1].length);
  if (inlineCitationMarker) indexes.push(inlineCitationMarker.index + inlineCitationMarker[1].length);
  return indexes.length ? Math.min(...indexes) : -1;
}


// BEGIN SHARED ANSWER TOKENS
// Kept byte-for-byte in frontend/app.js between SHARED ANSWER TOKENS markers.
// A token is recognized before Markdown escapes, tables, or citation cleanup.
function answerCodeTokenAt(text, index) {
  const remaining = text.slice(index);
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const fence = /^[ \t]*$/u.test(text.slice(lineStart, index))
    ? remaining.match(/^(`{3,}|~{3,})([^\n]*)\n/u) : null;
  if (fence) {
    const close = new RegExp(`^[ \\t]*${fence[1][0]}{${fence[1].length},}[ \\t]*(?:\\n|$)`, "gmu");
    close.lastIndex = index + fence[0].length;
    const end = close.exec(text);
    const stop = end ? end.index + end[0].length - (end[0].endsWith("\n") ? 1 : 0) : text.length;
    return { kind: "code", raw: text.slice(index, stop), end: stop };
  }
  const ticks = remaining.match(/^`+/u)?.[0];
  if (!ticks) return null;
  let end = text.indexOf(ticks, index + ticks.length);
  while (end !== -1 && (text[end - 1] === "`" || text[end + ticks.length] === "`")) {
    end = text.indexOf(ticks, end + ticks.length);
  }
  return end === -1 ? null : {
    kind: "code", raw: text.slice(index, end + ticks.length),
    content: text.slice(index + ticks.length, end), end: end + ticks.length,
  };
}


function answerMathTokenAt(text, index) {
  let left = "";
  let right = "";
  let display = false;
  let environment = false;
  if (text.startsWith("\\[", index)) { left = "\\["; right = "\\]"; display = true; }
  else if (text.startsWith("\\(", index)) { left = "\\("; right = "\\)"; }
  else if (text.startsWith("$$", index)) { left = right = "$$"; display = true; }
  else if (text[index] === "$" && text[index - 1] !== "$" && text[index + 1] !== "$") { left = right = "$"; }
  else if (text.startsWith("\\begin{", index)) {
    const match = text.slice(index).match(/^\\begin\{((?:equation|align|alignat|aligned|alignedat|gather|gathered|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|cases)\*?)\}/u);
    if (match) { left = match[0]; right = `\\end{${match[1]}}`; display = environment = true; }
  }
  if (!left) return null;
  const start = index + left.length;
  let end = text.indexOf(right, start);
  while (end !== -1) {
    let slashes = 0;
    for (let cursor = end - 1; cursor >= start && text[cursor] === "\\"; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0 && (right !== "$" || text[end + 1] !== "$")) break;
    end = text.indexOf(right, end + right.length);
  }
  if (end === -1) return null;
  const content = text.slice(start, end);
  // Model answers often emit "$ L = T - V $". Permit padded math without
  // consuming currency prose such as "$5 and $10" or "$ 5 and $ 10".
  const trimmed = content.trim();
  if (left === "$") {
    if (!trimmed || /\r|\n/u.test(content) || /\d/u.test(text[end + 1] || "")) return null;
    const padded = content !== trimmed;
    const looksMathematical = /\\[a-zA-Z]|[_^=+*/<>\-≤≥≠−]/u.test(trimmed) || /^[\p{L}\p{N}.]+$/u.test(trimmed);
    if (padded && !looksMathematical) return null;
  }
  const raw = text.slice(index, end + right.length);
  return { kind: "math", raw, tex: environment ? raw : content, display, end: end + right.length };
}


function normalizeAnswerMathTex(value) {
  return String(value).replace(
    /\\begin\{(matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix)\}([\s\S]*?)\\end\{\1\}/gu,
    (original, environment, body) => {
      if (/\\(?:begin|end|text|verb|multicolumn|hline)\b/u.test(body)) return original;
      const lines = body.split("\n");
      const rows = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim());
      if (rows.length < 2 || rows.length > 50) return original;
      const columns = rows.map(({ line }) => (line.match(/(?<!\\)&/gu) || []).length);
      if (columns[0] < 1 || columns.some((count) => count !== columns[0])) return original;
      const preceding = rows.slice(0, -1);
      if (preceding.some(({ line }) => !/(?<!\\)\\{1,2}[ \t\r]*$/u.test(line))) return original;
      for (const { line, index } of preceding) {
        lines[index] = line.replace(/(?<!\\)\\([ \t\r]*)$/u, (_, spaces) => "\\\\" + spaces);
      }
      return `\\begin{${environment}}${lines.join("\n")}\\end{${environment}}`;
    },
  );
}


function protectAnswerTechnicalText(value, { code = true } = {}) {
  const input = String(value ?? "");
  let prefix = "\uE000M";
  while (input.includes(prefix)) prefix += "M";
  const originals = [];
  let text = "";
  for (let index = 0; index < input.length;) {
    const token = (input[index] === "`" || input[index] === "~" ? answerCodeTokenAt(input, index) : null) ||
      (input[index] === "\\" || input[index] === "$" ? answerMathTokenAt(input, index) : null);
    if (token?.kind === "code" && !code) {
      text += token.raw; index = token.end;
    } else if (token) {
      text += `${prefix}${originals.length}\uE001`;
      originals.push(token);
      index = token.end;
    } else if (input[index] === "\\" && index + 1 < input.length) {
      text += input.slice(index, index + 2); index += 2;
    } else { text += input[index++]; }
  }
  return {
    text, prefix, tokens: originals,
    restore: (output) => String(output).replace(new RegExp(`${prefix}(\\d+)\uE001`, "gu"),
      (match, index) => originals[Number(index)]?.raw ?? match),
  };
}


// END SHARED ANSWER TOKENS

// BEGIN SHARED ANSWER PRESENTATION
// Recover only unambiguous, pipe-bounded rows with a real Markdown divider.
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


// Keep this function identical in frontend/app.js. Clean only presentation:
// evidence, source IDs, citations, and stored OA documents remain unchanged.
function cleanAnswerPresentation(value, { title = "", document = false } = {}) {
  const protectedText = protectAnswerTechnicalText(value);
  let text = protectedText.text.replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ");
  const legacyLead = /(?:知识库中与这个问题直接相关的内容包括|(?:知识库中|检索到的)(?:与(?:该|这个)问题)?(?:直接)?相关(?:的)?内容(?:包括|如下))\s*[:：]/u;
  const legacy = legacyLead.test(text);
  text = text.replace(new RegExp(`^[ \\t]*${legacyLead.source}[ \\t]*\\n*`, "u"), "");

  // Strip real document front matter, never a normal Markdown horizontal rule.
  text = text.replace(/^\s*---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u, (whole, body) =>
    /^(?:title|version|updated(?:_at)?|date|source|author)\s*:/imu.test(body) ? "" : whole);
  const metaName = "(?:文档版本|资料版本|版本(?:号)?|更新(?:时间|日期)|适用范围|文件名|文档名称|资料名称)";
  const sourceName = "(?:资料来源|文档来源|文件来源|参考来源|出处|引自|摘自|出自|来源)";
  const linePrefix = "^[ \\t]*(?:[-+*•][ \\t]+)?(?:>[ \\t]*)?(?:#{1,6}[ \\t]+)?(?:\\*\\*)?";
  const metaLine = new RegExp(`${linePrefix}${metaName}(?:\\*\\*)?[ \\t]*[:：]`, "u");
  const sourceLine = new RegExp(`${linePrefix}${sourceName}(?:\\*\\*)?[ \\t]*[:：]`, "u");
  const flattenedMetadata = new RegExp(`>[ \\t]*(?:${metaName}|${sourceName})[ \\t]*[:：]`, "u").test(text);

  const collapsedBlocks = /[^\n][ \t]+#{2,6}[ \t]+\S/u.test(text) ||
    /\|[ \t]*\|[ \t]*:?-{3,}:?[ \t]*\|/u.test(text);
  if (legacy || flattenedMetadata || collapsedBlocks) {
    // Older retrieval replies put '- # title > version ... ## section' on one line.
    // Recreate block boundaries before discarding document headers.
    text = text.replace(/^[ \t]*[-+*•][ \t]+(?=#{1,6}[ \t])/gmu, "")
      .replace(/[ \t]+(?=#{1,6}[ \t]+\S)/gu, "\n\n")
      .replace(new RegExp(`[ \\t]*>[ \\t]*(?=(?:${metaName}|${sourceName})[ \\t]*[:：])`, "gu"), "\n")
      .replace(/(#{1,6}[ \t]+[一二三四五六七八九十百\d]+[、.．][^\s#]{1,32})[ \t]+(?=\S)/gu, "$1\n\n");
  }
  text = restoreFlattenedAnswerTables(text);
  // Slides often join a numbered page title to its body after the English
  // page label. Split at that explicit boundary rather than guessing words.
  text = text.replace(/^(#{1,6}[ \t]+第[ \t]*\d+[ \t]*页[^\n()（）]{0,70}[（(][A-Z][A-Z \d-]{2,60}[)）])[ \t]*(?=\S)/gmu, "$1\n\n");
  const lines = text.split("\n");
  const normalizeTitle = (s) => String(s).normalize("NFKC").replace(/\*\*/gu, "")
    .replace(/\s+/gu, " ").trim().toLocaleLowerCase("zh-CN");
  const knownTitle = normalizeTitle(title).split(" · ")[0];
  const metaCount = lines.filter((line) => metaLine.test(line)).length;
  const headerMode = document || legacy || flattenedMetadata || collapsedBlocks || (metaCount >= 2 && lines.some((line) => /^(?:[ \t]*>[ \t]*)?(?:更新时间|更新日期|文档版本|资料版本)[ \t]*[:：]/u.test(line)));
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (sourceLine.test(line)) continue;
    // Only whole metadata lines are suppressed. Restriction notices remain
    // in source data and must never be treated as public-sharing permission.
    if (headerMode && /^[ \t]*(?:>[ \t]*)?(?:页脚|视觉说明)[ \t]*[:：]/u.test(line)) continue;
    if (/^[ \t]*参考(?:公司|实验室)(?:主页|官网)(?:的)?(?:介绍和描述|介绍|描述)[。.]?[ \t]*$/u.test(line)) continue;
    if (headerMode && metaLine.test(line)) continue;
    if (/^[ \t]*(?:[-+*•][ \t]+)?(?:本(?:文|段|回答|内容)|以上内容|上述内容)?(?:引自|摘自|出自)[ \t]*[《“「][^\n]+[》”」][。.]?[ \t]*$/u.test(line)) continue;
    const heading = line.match(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/u);
    if (heading) {
      const matchesTitle = knownTitle && normalizeTitle(heading[1]) === knownTitle;
      const followedByMetadata = /^\s*#[ \t]+/u.test(line) && metaLine.test(lines.slice(index + 1).find((next) => next.trim()) || "");
      if ((document && matchesTitle) || (headerMode && followedByMetadata)) continue;
      // A collapsed page must not turn hundreds of body characters bold.
      if (heading[1].length > 100) line = heading[1];
    }
    // Remove an attribution lead, but keep its actual conclusion and [n] evidence.
    line = line.replace(/^(?:根据|依据|据)[ \t]*《[^》\n]+》(?:中(?:的)?(?:介绍|说明|记载|内容|描述)|(?:记载|介绍|说明|显示|指出))?[ \t]*[，,:：][ \t]*/u, "")
      .replace(/^(?:根据|依据|据)(?:现有|上述|相关|公开|所提供的|提供的)?(?:知识库|资料|文档)(?:内容)?(?:显示|可知|表明|记载|介绍|说明)?[ \t]*[，,:：][ \t]*/u, "");
    output.push(line.replace(/[ \t]+$/gu, ""));
  }
  return protectedText.restore(output.join("\n").replace(/\n{3,}/gu, "\n\n").trim());
}

// END SHARED ANSWER PRESENTATION

function userFacingAnswer(value) {
  const technical = protectAnswerTechnicalText(cleanAnswerPresentation(cleanPublicChatText(value)));
  const answer = technical.text;
  const sectionStart = referenceSectionStart(answer);
  const answerBody = sectionStart === -1 ? answer : answer.slice(0, sectionStart);
  if (/\[\s*\[\s*[0-9０-９][\s\S]*?\]\s*\]/u.test(answerBody)) return "暂时没有可显示的回答。";
  const withoutReferences = answerBody
    .replace(
      /[ \t]*[\[［【]\s*[0-9０-９]+(?:\s*[,，、;；\-–—]\s*[0-9０-９]+)*\s*[\]］】]/gu,
      "",
    )
    .replace(
      /^(?:(?:根据|据)(?:现有|上述|相关|公开|所提供的|提供的)?(?:参考)?资料(?:显示|可知|表明)|参考资料(?:显示|表明|提到)|(?:根据|据)(?:现有|上述|相关|公开|所提供的|提供的)?(?:参考)?资料)[，,:：]\s*/u,
      "",
    )
    .replace(/[ \t]+([，。！？；：])/gu, "$1")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const hasResidualMarker =
    /[\[［【][^\]］】\r\n]*[0-9０-９]+[^\]］】\r\n]*[\]］】]/u.test(withoutReferences) ||
    /(?:参考资料|参考文献|参考来源|资料来源)/u.test(withoutReferences) ||
    /(?:^|[^\p{L}\p{N}_*`#~-])(?:参考|引用|出处)(?:列表|清单)?(?:如下(?:所示)?)?[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*[:：]/iu.test(withoutReferences) ||
    /(?:^|[^\p{L}\p{N}_-])(?:references?|sources?|citations?|bibliography|works[ \t]+cited)(?:[ \t]+list)?[ \t]*[:：]/iu.test(withoutReferences) ||
    referenceSectionStart(withoutReferences) !== -1;
  return withoutReferences && !hasResidualMarker ? technical.restore(withoutReferences) : "暂时没有可显示的回答。";
}


const ANSWER_MATH_ASSET = "/assets/katex-cc567bec51ade0dc.mjs";

let answerMathEngine = null;

let answerMathLoading = null;

let answerMathRequestSequence = 0;


function loadAnswerMathEngine() {
  if (answerMathEngine) return Promise.resolve(answerMathEngine);
  if (!answerMathLoading) {
    // A transient import error must not poison later answers in this tab.
    // Distinct URLs also bypass the browser's cached failed module promises.
    answerMathLoading = (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 400));
        try {
          const sequence = answerMathRequestSequence++;
          const url = sequence ? `${ANSWER_MATH_ASSET}?retry=${sequence}` : ANSWER_MATH_ASSET;
          const mathModule = await import(/* @vite-ignore */ url);
          if (typeof mathModule.default?.render !== "function") throw new TypeError("Invalid formula engine");
          answerMathEngine = mathModule.default;
          return answerMathEngine;
        } catch { /* Keep the original formula visible until a retry succeeds. */ }
      }
      return null;
    })().finally(() => { answerMathLoading = null; });
  }
  return answerMathLoading;
}


function renderAnswerMath(token, budget = { count: 0, characters: 0 }) {
  const node = element("span", {
    className: `answer-math${token.display ? " answer-math-block" : ""}`,
    attributes: { "data-math-status": "pending" },
    text: token.raw,
  });
  const fallback = (reason) => {
    node.textContent = token.raw;
    node.setAttribute("data-math-status", "fallback");
    node.setAttribute("title", reason);
  };
  budget.count += 1; budget.characters += token.tex.length;
  if (token.tex.length > 8_000 || budget.count > 160 || budget.characters > 24_000) {
    fallback("公式较复杂，已保留原始写法。");
    return node;
  }
  const render = (engine) => {
    if (!engine?.render) { fallback("公式组件暂不可用，已保留原始写法。"); return; }
    try {
      engine.render(normalizeAnswerMathTex(token.tex), node, {
        displayMode: token.display,
        // Native MathML needs no remote stylesheets or downloaded font files.
        output: "mathml", trust: false, throwOnError: true,
        strict: "ignore", maxExpand: 1_000, maxSize: 10,
      });
      node.setAttribute("data-math-status", "rendered");
    } catch {
      fallback("此公式暂未识别，已保留原始写法。");
    }
  };
  if (answerMathEngine) render(answerMathEngine);
  else if (typeof window !== "undefined") void loadAnswerMathEngine().then(render);
  return node;
}


function answerMaskedMathAt(text, index, technical) {
  if (!technical || !text.startsWith(technical.prefix, index)) return null;
  const end = text.indexOf("\uE001", index + technical.prefix.length);
  if (end < 0) return null;
  const number = text.slice(index + technical.prefix.length, end);
  if (!/^\d+$/u.test(number)) return null;
  const token = technical.tokens[Number(number)];
  return token?.kind === "math" ? { token, end: end + 1 } : null;
}


function answerEmphasisEnd(text, start, marker) {
  for (let index = start; index < text.length;) {
    if (text[index] === "\\") { index += 2; continue; }
    if (text[index] === "`") {
      const code = answerCodeTokenAt(text, index);
      if (code) { index = code.end; continue; }
    }
    if (text.startsWith(marker, index)) return index;
    index += 1;
  }
  return -1;
}


function answerDisplayLinkAt(text, index) {
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


function appendAnswerInline(parent, text, technical = null, depth = 0, budget = { count: 0, characters: 0 }) {
  // Model HTML, links, and images remain inert text. Only our nodes and KaTeX
  // with trust:false can create markup; formulas are protected before emphasis.
  if (depth > 12) { parent.append(document.createTextNode(technical ? technical.restore(text) : text)); return; }
  if (!technical) {
    technical = protectAnswerTechnicalText(text, { code: false });
    text = technical.text;
  }
  let plain = "";
  const flush = () => { if (plain) { parent.append(document.createTextNode(plain)); plain = ""; } };
  for (let index = 0; index < text.length;) {
    const math = answerMaskedMathAt(text, index, technical);
    if (math) { flush(); parent.append(renderAnswerMath(math.token, budget)); index = math.end; continue; }
    const link = answerDisplayLinkAt(text, index);
    if (link) {
      flush();
      if (link.label) appendAnswerInline(parent, link.label, technical, depth + 1, budget);
      index = link.end; continue;
    }
    if (text[index] === "`") {
      const code = answerCodeTokenAt(text, index);
      if (code?.content !== undefined) {
        flush(); parent.append(element("code", { text: code.content })); index = code.end; continue;
      }
    }
    if (text[index] === "\\" && /[\\`*_{}\[\]()#+\-.!|$]/u.test(text[index + 1] || "")) {
      // Do not eat the opener of an incomplete formula while it is still text.
      plain += /[([]/u.test(text[index + 1]) ? text.slice(index, index + 2) : text[index + 1];
      index += 2; continue;
    }
    const marker = ["***", "___", "**", "__", "*", "_", "~~"].find((value) => text.startsWith(value, index));
    if (marker && !(marker[0] === "_" && /[\p{L}\p{N}]/u.test(text[index - 1] || ""))) {
      const end = answerEmphasisEnd(text, index + marker.length, marker);
      if (end > index + marker.length && text.slice(index + marker.length, end).trim()) {
        flush();
        const node = element(marker === "~~" ? "del" : marker.length > 1 ? "strong" : "em");
        const target = marker.length === 3 ? element("em") : node;
        appendAnswerInline(target, text.slice(index + marker.length, end), technical, depth + 1, budget);
        if (target !== node) node.append(target);
        parent.append(node); index = end + marker.length; continue;
      }
      plain += marker; index += marker.length; continue;
    }
    plain += text[index++];
  }
  flush();
}


function answerTableCells(line) {
  const text = line.trim();
  if (!text.includes("|")) return null;
  const cells = [];
  let cell = "";
  for (let index = 0; index < text.length;) {
    const token = (text[index] === "`" ? answerCodeTokenAt(text, index) : null) ||
      (text[index] === "\\" || text[index] === "$" ? answerMathTokenAt(text, index) : null);
    if (token) { cell += token.raw; index = token.end; }
    else if (text[index] === "\\" && text[index + 1] === "|") { cell += "\\|"; index += 2; }
    else if (text[index] === "|") { cells.push(cell.trim()); cell = ""; index += 1; }
    else cell += text[index++];
  }
  cells.push(cell.trim());
  if (text.startsWith("|")) cells.shift();
  if (text.endsWith("|") && !text.endsWith("\\|")) cells.pop();
  return cells.length >= 2 && cells.length <= 8 ? cells : null;
}


function answerTableAt(lines, index) {
  const header = answerTableCells(lines[index] || "");
  const divider = answerTableCells(lines[index + 1] || "");
  return header && divider && header.length === divider.length && divider.every((cell) => /^:?-{3,}:?$/u.test(cell))
    ? header : null;
}


function renderAnswerBody(answer) {
  const body = element("div", { className: "message-body answer-content" });
  const technical = protectAnswerTechnicalText(String(answer).replace(/\r\n?/gu, "\n"), { code: false });
  const lines = technical.text.split("\n");
  const budget = { count: 0, characters: 0 };
  const inline = (node, text) => appendAnswerInline(node, text, technical, 0, budget);
  const standaloneMath = (line) => {
    const trimmed = line.trim();
    const math = answerMaskedMathAt(trimmed, 0, technical);
    return math?.token.display && math.end === trimmed.length ? math.token : null;
  };
  const rule = (line) => /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u.test(line);
  const startsBlock = (index) => /^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)、]\s|>|`{3,}|~{3,})/u.test(lines[index] || "") ||
    answerTableAt(lines, index) || standaloneMath(lines[index] || "") || rule(lines[index] || "");
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const math = standaloneMath(line);
    if (math) { body.append(renderAnswerMath(math, budget)); index += 1; continue; }
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`, "u").test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      const content = technical.restore(code.join("\n"));
      if (/^(?:math|latex|tex)$/iu.test(fence[2].trim())) {
        const wrapped = answerMathTokenAt(content.trim(), 0);
        body.append(renderAnswerMath({ raw: content, tex: wrapped?.end === content.trim().length ? wrapped.tex : content, display: true }, budget));
      } else body.append(element("pre", {}, [element("code", { text: content })]));
      continue;
    }
    const headers = answerTableAt(lines, index);
    if (headers) {
      const wrap = element("div", { className: "answer-table-scroll", attributes: { role: "region", "aria-label": "回答表格，可左右滑动", tabindex: "0" } });
      const table = element("table");
      const head = element("tr");
      const dividers = answerTableCells(lines[index + 1]);
      const cellNode = (tag, value, column) => {
        const node = element(tag, { attributes: tag === "th" ? { scope: "col" } : {} });
        const marker = dividers[column];
        if (marker.endsWith(":")) node.setAttribute("data-align", marker.startsWith(":") ? "center" : "right");
        inline(node, value); return node;
      };
      headers.forEach((value, column) => head.append(cellNode("th", value, column)));
      table.append(element("thead", {}, [head]));
      const rows = element("tbody");
      index += 2;
      while (index < lines.length) {
        const values = answerTableCells(lines[index]);
        if (!values || values.length !== headers.length) break;
        const row = element("tr");
        values.forEach((value, column) => row.append(cellNode("td", value, column)));
        rows.append(row); index += 1;
      }
      table.append(rows); wrap.append(table); body.append(wrap); continue;
    }
    if (rule(line)) { body.append(element("hr")); index += 1; continue; }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*$/u);
    if (heading) { const node = element(`h${Math.min(6, heading[1].length + 2)}`); inline(node, heading[2]); body.append(node); index += 1; continue; }
    const listItem = line.match(/^\s*(?:([-+*])|(\d+)[.)、])\s+(.+)$/u);
    if (listItem) {
      const ordered = Boolean(listItem[2]);
      const list = element(ordered ? "ol" : "ul");
      if (ordered && Number(listItem[2]) > 1 && Number(listItem[2]) < 10_000) list.setAttribute("start", listItem[2]);
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:([-+*])|(\d+)[.)、])\s+(.+)$/u);
        if (!item || Boolean(item[2]) !== ordered) break;
        const node = element("li"); inline(node, item[3]); list.append(node); index += 1;
      }
      body.append(list); continue;
    }
    if (/^\s*>/u.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/u.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/u, ""));
      const node = element("blockquote"); inline(node, quote.join("\n")); body.append(node); continue;
    }
    const paragraph = [line]; index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(index)) paragraph.push(lines[index++]);
    const node = element("p"); inline(node, paragraph.join("\n")); body.append(node);
  }
  return body;
}
export { renderAnswerBody, userFacingAnswer };
