/* Generated from Chat's DOM-safe answer renderer; do not edit. */
/* eslint-disable */

let answerMathEngine = null;


function cleanPublicChatText(value) {
  return String(value || "").trim();
}


function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}


function renderMarkdown(markdown) {
  const normalized = String(markdown || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/([。！？；])\s+(?=#{1,6}\s)/gu, "$1\n\n")
    .replace(/\|[ \t]+\|/gu, "|\n|")
    .replace(/\[([^\]\n]{1,200})\]\(https?:\/\/[^)\s]+\)/giu, "$1");
  const lines = normalized.split("\n");
  const output = [];
  let paragraph = [];
  let list = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    output.push(`<ol>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ol>`);
    list = [];
  };
  const tableRows = (start) => {
    const rows = [];
    let index = start;
    while (index < lines.length && /^\s*\|.*\|\s*$/u.test(lines[index])) {
      rows.push(lines[index].trim());
      index += 1;
    }
    return { rows, next: index };
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    if (/^\s*(?:\$\$|\\\[)/u.test(line)) {
      const isDollar = /^\s*\$\$/u.test(line);
      const close = isDollar ? "$$" : "\\]";
      const start = isDollar ? line.indexOf("$") + 2 : line.indexOf("\\[") + 2;
      let tex = line.slice(start);
      let found = tex.includes(close);
      while (!found && index + 1 < lines.length) {
        index += 1;
        tex += "\n" + lines[index];
        found = lines[index].includes(close);
      }
      if (found) {
        const end = tex.lastIndexOf(close);
        const raw = `${isDollar ? "$$" : "\\["}${tex.slice(0, end)}${close}`;
        flushParagraph(); flushList();
        output.push(renderAnswerMath(tex.slice(0, end), true, raw));
        continue;
      }
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/u);
    if (heading) { flushParagraph(); flushList(); output.push(`<h3>${inline(heading[2])}</h3>`); continue; }
    const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/u);
    if (bullet) { flushParagraph(); list.push(bullet[1]); continue; }
    if (/^\s*\|.*\|\s*$/u.test(line) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(lines[index + 1] || "")) {
      flushParagraph(); flushList();
      const table = tableRows(index);
      const rows = table.rows.filter((_, rowIndex) => rowIndex !== 1).map((row) => row.replace(/^\||\|$/gu, "").split("|").map((cell) => inline(cell.trim())));
      const [head = [], ...body] = rows;
      output.push(`<table><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      index = table.next - 1;
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph(); flushList();
  return output.join("") || "<p>暂无内容。</p>";
}


function renderAnswerBody(answer) {
  const container = document.createElement("div");
  container.className = "answer-content";
  const html = renderMarkdown(answer);
  if ("innerHTML" in container) {
    container.innerHTML = html;
    return container;
  }
  appendControlledHtml(container, html);
  return container;
}


function userFacingAnswer(value) {
  return cleanPublicChatText(value);
}


function appendControlledHtml(root, html) {
  const decode = (value) => value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&");
  const stack = [root];
  const pattern = /<\/?([a-z0-9]+)(?:\s[^>]*)?>|([^<]+)/giu;
  let match;
  while ((match = pattern.exec(html))) {
    if (match[2]) {
      stack.at(-1).append(document.createTextNode(decode(match[2])));
      continue;
    }
    const tag = match[1].toLowerCase();
    if (match[0][1] === "/") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = document.createElement(tag);
    stack.at(-1).append(node);
    stack.push(node);
  }
}


function answerMathTokenAt(text, index) {
  let left = "";
  let right = "";
  let display = false;
  if (text.startsWith("\\[", index)) { left = "\\["; right = "\\]"; display = true; }
  else if (text.startsWith("\\(", index)) { left = "\\("; right = "\\)"; }
  else if (text.startsWith("$$", index)) { left = right = "$$"; display = true; }
  else if (text[index] === "$" && text[index - 1] !== "$" && text[index + 1] !== "$") { left = right = "$"; }
  else return null;
  const start = index + left.length;
  const end = text.indexOf(right, start);
  if (end === -1) return null;
  const content = text.slice(start, end);
  const trimmed = content.trim();
  if (left === "$") {
    if (!trimmed || /\r|\n/u.test(content) || /\d/u.test(text[end + 1] || "")) return null;
    const padded = content !== trimmed;
    const looksMathematical = /\\[a-zA-Z]|[_^=+*/<>\-≤≥≠−]/u.test(trimmed) || /^[\p{L}\p{N}.]+$/u.test(trimmed);
    if (padded && !looksMathematical) return null;
  }
  return { raw: text.slice(index, end + right.length), tex: content, display, end: end + right.length };
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


function renderAnswerMath(tex, display, raw) {
  const normalizedTex = normalizeAnswerMathTex(tex);
  const mathClass = display ? "math-display answer-math-block" : "math-inline";
  const fallback = `<span class="${mathClass}" data-math-status="fallback" data-tex="${escapeHtml(normalizedTex)}" data-display="${display ? "true" : "false"}" data-raw="${escapeHtml(raw)}">${escapeHtml(raw)}</span>`;
  if (!answerMathEngine?.renderToString || normalizedTex.length > 8000) return fallback;
  try {
    const html = answerMathEngine.renderToString(normalizedTex.trim(), {
      displayMode: display,
      output: "mathml",
      trust: false,
      throwOnError: true,
      strict: "ignore",
      maxExpand: 1000,
      maxSize: 10,
    });
    return `<span class="${mathClass}" data-math-status="rendered">${html}</span>`;
  } catch {
    return fallback;
  }
}


function inline(text) {
  const tokens = [];
  let protectedText = "";
  for (let index = 0; index < String(text).length;) {
    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end !== -1) {
        const token = `\uE000C${tokens.length}\uE001`;
        tokens.push(`<code>${escapeHtml(text.slice(index + 1, end))}</code>`);
        protectedText += token;
        index = end + 1;
        continue;
      }
    }
    const math = (text[index] === "$" || text[index] === "\\") ? answerMathTokenAt(text, index) : null;
    if (math) {
      const token = `\uE000C${tokens.length}\uE001`;
      tokens.push(renderAnswerMath(math.tex, math.display, math.raw));
      protectedText += token;
      index = math.end;
      continue;
    }
    protectedText += text[index++];
  }
  return escapeHtml(protectedText)
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/\uE000C(\d+)\uE001/gu, (_, index) => tokens[Number(index)] || "");
}
export { renderAnswerBody, userFacingAnswer };
