"use strict";

const KATEX_ASSET = "__KATEX_ASSET__";
let answerMathEngine = null;
if (KATEX_ASSET) {
  import(KATEX_ASSET)
    .then((module) => { answerMathEngine = module.default || module; rerenderFallbackMath(); })
    .catch(() => { answerMathEngine = null; });
}

const STORAGE_KEY = "originmind-public-preview-conversations-v1";
const DEFAULT_PUBLIC_API_BASE = "";
const PUBLIC_API_BASE = typeof window.PUBLIC_API_BASE === "string" && window.PUBLIC_API_BASE.trim()
  ? window.PUBLIC_API_BASE.replace(/\/+$/u, "")
  : DEFAULT_PUBLIC_API_BASE;
const DEFAULT_SUGGESTIONS = [
  "实验室现有的机器人平台包括哪些？",
  "介绍实验室当前的主要研究方向",
  "实验室有哪些代表性成果与应用？",
  "如何与实验室开展科研合作？",
];
const HISTORY_ITEMS = [
  ["overview", "实验室主要研究什么？"],
  ["robots", "现有机器人平台"],
  ["cooperation", "科研合作方式"],
];
const MODE_COPY = {
  text: ["想了解实验室的什么？", "从已审核的实验室公开知识中检索并回答", "输入想了解的实验室问题", "文本模型"],
  voice: ["想了解实验室的什么？", "从已审核的实验室公开知识中检索并回答", "说出想了解的实验室问题", "语音模型"],
  vision: ["想了解实验室的什么？", "从已审核的实验室公开知识中检索并回答", "上传图片或描述需要识别的内容", "视觉模型"],
};

function apiUrl(path) {
  return `${PUBLIC_API_BASE}${path}`;
}

const icons = {
  chat: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 5h14v11H9l-4 3V5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 5h14v11H9l-4 3V5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 9h6M9 12h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  voice: '<svg viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="1.7"/><path d="M6.5 11.5a5.5 5.5 0 0011 0M12 17v4M9 21h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  vision: '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="m7 16 3.5-4 2.6 3 1.7-2 2.2 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="9" r="1" fill="currentColor"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none"><path d="M6 3h9l4 4v14H6a2 2 0 01-2-2V5a2 2 0 012-2z" stroke="currentColor" stroke-width="1.5"/><path d="M15 3v5h5M8 12h8M8 16h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 19V9m5 10V5m5 14v-7m5 7V3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none"><path d="m4 17 10-10 3 3L7 20H4v-3zM13 8l3 3m2-7 2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  paperclip: '<svg viewBox="0 0 24 24" fill="none"><path d="M8.5 12.5l5.8-5.8a3 3 0 114.2 4.2l-7.9 7.9a5 5 0 11-7.1-7.1l8.2-8.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 18V6m0 0-4 4m4-4 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cube: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l7 4v10l-7 4-7-4V7l7-4z" stroke="currentColor" stroke-width="1.5"/><path d="m9 12 2 2 4-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l7.5 4.5v9L12 21l-7.5-4.5v-9L12 3z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none"><path d="m14 8-4 4 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  login: '<svg viewBox="0 0 24 24" fill="none"><path d="M10 7V5a2 2 0 012-2h6v18h-6a2 2 0 01-2-2v-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12h11m0 0-3-3m3 3-3 3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 16V4m0 0-4 4m4-4 4 4M5 14v5h14v-5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function cleanPublicChatText(value) {
  return String(value || "").trim();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attributes || {})) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function textButton(text, className) {
  const button = element("button", { className, text });
  button.type = "button";
  return button;
}

function icon(name) {
  const wrapper = document.createElement("span");
  wrapper.innerHTML = icons[name] || "";
  return wrapper.firstElementChild || document.createElement("span");
}

function renderMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/gu, "\n").split("\n");
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
      const close = isDollar ? "$" : "\\]";
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
        const raw = `${isDollar ? "$" : "\\["}${tex.slice(0, end)}${close}`;
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

function renderAnswerMath(tex, display, raw) {
  const fallback = `<span class="${display ? "math-display" : "math-inline"}" data-math-status="fallback" data-tex="${escapeHtml(tex)}" data-display="${display ? "true" : "false"}" data-raw="${escapeHtml(raw)}">${escapeHtml(raw)}</span>`;
  if (!answerMathEngine?.renderToString || String(tex).length > 8000) return fallback;
  try {
    const html = answerMathEngine.renderToString(tex.trim(), {
      displayMode: display,
      output: "mathml",
      trust: false,
      throwOnError: true,
      strict: "ignore",
      maxExpand: 1000,
      maxSize: 10,
    });
    return `<span class="${display ? "math-display" : "math-inline"}" data-math-status="rendered">${html}</span>`;
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

function knowledgeSuggestionsFromPayload(payload) {
  return (Array.isArray(payload?.suggestions) ? payload.suggestions : [])
    .map((item) => typeof item === "string" ? item : item?.question)
    .filter(Boolean);
}

function rerenderFallbackMath(root = document) {
  if (!answerMathEngine?.renderToString) return;
  root.querySelectorAll('[data-math-status="fallback"][data-tex]').forEach((node) => {
    const tex = node.getAttribute("data-tex") || "";
    const raw = node.getAttribute("data-raw") || node.textContent || "";
    const display = node.getAttribute("data-display") === "true";
    const wrapper = document.createElement("template");
    wrapper.innerHTML = renderAnswerMath(tex, display, raw);
    const rendered = wrapper.content.firstElementChild;
    if (rendered && rendered.getAttribute("data-math-status") === "rendered") node.replaceWith(rendered);
  });
}

function knowledgeImageUrl(value) {
  const url = String(value || "");
  if (!/^\/api\/knowledge\/assets\/[A-Za-z0-9_-]+$/u.test(url)) return "";
  return apiUrl(url);
}

function renderKnowledgeImages(images) {
  const safeImages = (Array.isArray(images) ? images : [])
    .map((image) => ({
      url: knowledgeImageUrl(image?.url),
      alt: String(image?.alt || "资料图片").slice(0, 120),
    }))
    .filter((image) => image.url)
    .slice(0, 4);
  if (!safeImages.length) return "";
  return `<div class="knowledge-gallery">${safeImages.map((image) => `<figure class="knowledge-image"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}" loading="lazy" decoding="async"><figcaption>${escapeHtml(image.alt)}</figcaption></figure>`).join("")}</div>`;
}

function appShell() {
  return `
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span><div class="brand-copy"><strong class="brand-title">机器人自主移动与操作实验室</strong><span class="brand-subtitle">OriginMind x ARTS Robotics</span></div></div>
      <div class="sidebar-label">功能</div>
      <div class="nav-list">
        <a class="nav-item village-nav-item" href="/newbie-village">${icons.chart}<span>新手村</span></a>
        <button class="nav-item model-nav-item active" type="button" data-mode="text">${icons.text}<span>文本模型</span></button>
        <button class="nav-item model-nav-item" type="button" data-mode="voice">${icons.voice}<span>语音模型</span></button>
        <button class="nav-item model-nav-item" type="button" data-mode="vision">${icons.vision}<span>视觉模型</span></button>
      </div>
      <div class="sidebar-label history-label">历史</div>
      <div class="history-list">${HISTORY_ITEMS.map(([key, label]) => `<button class="history-item" type="button" data-history="${key}">${icons.chat}<span>${label}</span></button>`).join("")}</div>
      <button class="collapse-handle" type="button" aria-label="收起侧边栏">${icons.chevron}</button>
      <div class="side-footer"><div class="bottom-actions"><button class="new-chat-bottom" type="button">${icons.plus}<span>聊天</span></button><button class="settings-trigger mobile-settings-trigger" type="button" aria-label="登录与设置">${icons.gear}</button></div></div>
    </aside>
    <main class="workspace"><header class="topbar"><div class="topbar-title"><span class="lab-name">机器人自主移动与操作实验室</span><span class="desktop-lab-brand">OriginMind x ARTS Robotics</span></div><div class="topbar-actions"><span class="guest-badge">游客模式</span><button class="settings-trigger desktop-settings-trigger" type="button" aria-label="登录与设置">${icons.gear}</button></div></header>
      <section class="chat-surface"><button class="student-login-trigger login-guide" type="button" hidden><span class="login-guide-icon">${icons.login}</span><span class="login-guide-copy"><strong>深技大师生登录</strong></span></button><div class="empty-state"><div class="entry-card"><h1 class="hero-title">想了解实验室的什么？</h1><p class="hero-subtitle">从已审核的实验室公开知识中检索并回答。</p></div></div>
        <div class="conversation" aria-live="polite"><div class="message-list"></div></div>
        <div class="composer-wrap"><div class="composer-glow"></div><form class="composer" aria-label="发送消息"><div class="composer-inner"><div class="input-panel"><textarea class="prompt-input" rows="2" maxlength="4000" aria-label="你的问题" placeholder="输入想了解的实验室问题"></textarea><div class="attachment-chip">${icons.paperclip}<span></span></div></div><div class="composer-footer"><div class="input-tools"><input class="file-input" type="file" hidden><button class="icon-button attach-button" type="button" aria-label="添加附件">${icons.paperclip}</button><button class="icon-button voice-button" type="button" aria-label="语音输入">${icons.voice}</button></div><div class="footer-actions"><button class="model-pill" type="button">${icons.cube}<span>文本模型</span></button><button class="send-button" type="submit" aria-label="发送" disabled>${icons.send}</button></div></div></div></form></div>
        <div class="suggestions">${DEFAULT_SUGGESTIONS.map((question, index) => `<button class="suggestion" type="button" data-prompt="${escapeHtml(question)}">${[icons.file, icons.text, icons.chart, icons.pen][index] || icons.chat}<span>${escapeHtml(question.replace(/[？?]$/u, ""))}</span></button>`).join("")}</div>
      </section></main>
  </div>
  <div class="auth-backdrop" aria-hidden="true">
    <div class="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <button class="auth-close" type="button" aria-label="关闭">${icons.x}</button>
      <div class="auth-brand">${icons.login}</div>
      <h2 id="auth-title">校内邮箱登录</h2>
      <p>仅用于 chat 身份验证，不进入其他系统。学生请使用学号@stumail.sztu.edu.cn，教师请使用 @sztu.edu.cn 邮箱。</p>
      <form class="campus-login-form">
        <label class="auth-field"><span>邮箱</span><input class="campus-email-input" type="email" autocomplete="email" placeholder="学号@stumail.sztu.edu.cn"></label>
        <button class="campus-code-button" type="button">发送验证码</button>
        <label class="auth-field code-field"><span>验证码</span><input class="campus-code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位数字"></label>
        <button class="campus-login-button" type="submit">验证并登录</button>
        <div class="auth-status" aria-live="polite"></div>
      </form>
      <div class="guest-limits"><strong>游客可用</strong><span>公开知识问答、公开研究方向、合作方式咨询。</span><strong>登录后</strong><span>识别学生或校内教师身份，用于后续新手引导和个性化设置。</span></div>
      <button class="guest-continue" type="button">继续游客试看</button>
      <p class="auth-caption">chat 登录只做身份验证，不关联内部审批流程。</p>
    </div>
  </div>
  <div class="toast" role="status" aria-live="polite"></div>`;
}

document.getElementById("app").innerHTML = appShell();

const body = document.body;
const form = document.querySelector(".composer");
const promptInput = document.querySelector(".prompt-input");
const sendButton = document.querySelector(".send-button");
const messageList = document.querySelector(".message-list");
const fileInput = document.querySelector(".file-input");
const attachmentChip = document.querySelector(".attachment-chip");
const attachmentName = attachmentChip.querySelector("span");
const voiceButton = document.querySelector(".voice-button");
const modelPillLabel = document.querySelector(".model-pill span");
const heroTitle = document.querySelector(".hero-title");
const heroSubtitle = document.querySelector(".hero-subtitle");
const toast = document.querySelector(".toast");
const authBackdrop = document.querySelector(".auth-backdrop");
const guestBadge = document.querySelector(".guest-badge");
const loginGuide = document.querySelector(".login-guide");
const campusLoginForm = document.querySelector(".campus-login-form");
const campusEmailInput = document.querySelector(".campus-email-input");
const campusCodeInput = document.querySelector(".campus-code-input");
const campusCodeButton = document.querySelector(".campus-code-button");
const authStatus = document.querySelector(".auth-status");
let toastTimer;
let currentMode = "text";
let visitorUser = null;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function openAuthDialog() {
  authBackdrop.classList.add("open");
  authBackdrop.setAttribute("aria-hidden", "false");
  campusEmailInput.focus();
}

function closeAuthDialog() {
  authBackdrop.classList.remove("open");
  authBackdrop.setAttribute("aria-hidden", "true");
}

function setAuthStatus(message, tone = "") {
  authStatus.textContent = message || "";
  authStatus.className = `auth-status${tone ? ` ${tone}` : ""}`;
}

function updateVisitorUi(user) {
  visitorUser = user || null;
  if (visitorUser) {
    guestBadge.textContent = visitorUser.roleLabel || "已登录";
    guestBadge.classList.add("signed-in");
  } else {
    guestBadge.textContent = "游客模式";
    guestBadge.classList.remove("signed-in");
  }
  updateLoginGuide();
}

function updateLoginGuide() {
  if (!loginGuide) return;
  loginGuide.hidden = Boolean(visitorUser);
}

async function refreshVisitorStatus() {
  try {
    const response = await fetch(apiUrl("/api/visitor/status"), { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
    const data = await response.json();
    updateVisitorUi(response.ok && data.signedIn ? data.user : null);
  } catch {
    updateVisitorUi(null);
  }
}

async function requestCampusCode() {
  const email = campusEmailInput.value.trim();
  campusCodeButton.disabled = true;
  setAuthStatus("正在发送验证码…");
  try {
    const response = await fetch(apiUrl("/api/visitor/request-code"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "验证码发送失败");
    setAuthStatus(data.devCode ? `预览验证码：${data.devCode}` : "验证码已发送，请查看邮箱。", "success");
    campusCodeInput.focus();
  } catch (error) {
    setAuthStatus(error?.message || "验证码发送失败", "error");
  } finally {
    campusCodeButton.disabled = false;
  }
}

async function verifyCampusCode(event) {
  event.preventDefault();
  const button = campusLoginForm.querySelector(".campus-login-button");
  button.disabled = true;
  setAuthStatus("正在验证…");
  try {
    const response = await fetch(apiUrl("/api/visitor/verify-code"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email: campusEmailInput.value.trim(), code: campusCodeInput.value.trim() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.signedIn) throw new Error(data.error || "登录失败");
    updateVisitorUi(data.user);
    setAuthStatus("登录成功。", "success");
    closeAuthDialog();
    showToast(`已登录：${data.user?.roleLabel || "校内身份"}`);
  } catch (error) {
    setAuthStatus(error?.message || "登录失败", "error");
  } finally {
    button.disabled = false;
  }
}

function updateSendState() {
  const ready = promptInput.value.trim().length > 0 || attachmentChip.classList.contains("show");
  sendButton.disabled = !ready;
  sendButton.classList.toggle("ready", ready);
}

function autoResize() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 126)}px`;
}

function messageActions() {
  return `<div class="message-actions">
    <button class="message-action-button copy-answer" type="button" aria-label="复制回答" title="复制回答">${icons.file}</button>
    <button class="message-action-button copy-answer-link" type="button" aria-label="复制链接" title="复制链接">${icons.link || icons.chat}</button>
    <button class="message-action-button share-answer" type="button" aria-label="分享链接" title="分享链接">${icons.share || icons.chat}</button>
    <span class="message-source-note">参考内部公开资料</span>
  </div>`;
}

function setAssistantContent(item, text, { html = false, images = [] } = {}) {
  const content = item.querySelector(".answer-content");
  if (!content) return;
  content.innerHTML = `${html ? text : renderMarkdown(text)}${renderKnowledgeImages(images)}`;
  rerenderFallbackMath(content);
}

function addMessage(role, text, { html = false, typing = false, images = [] } = {}) {
  const item = document.createElement("article");
  item.className = `message ${role}${typing ? " typing-message" : ""}`;
  if (typing) item.innerHTML = '<div class="message-content"><div class="typing"><i></i><i></i><i></i></div></div>';
  else if (role === "assistant") item.innerHTML = `<div class="message-content"><div class="answer-content"></div>${messageActions()}</div>`;
  else item.innerHTML = '<div class="message-content"><p></p></div>';
  if (!typing) {
    if (role === "assistant") setAssistantContent(item, text, { html, images });
    else item.querySelector("p").textContent = text;
  }
  messageList.appendChild(item);
  bindMessageActions(item);
  messageList.scrollTo({ top: messageList.scrollHeight, behavior: "smooth" });
  return item;
}

function answerRevealDelay(chunk) {
  return Math.min(80, Math.max(18, Math.round(String(chunk || "").length * 1.1)));
}

function answerRevealChunks(text) {
  const chunks = String(text || "").match(/[^。！？；\n]+[。！？；\n]+|[^。！？；\n]+$/gu) || [String(text || "")];
  const merged = [];
  for (const chunk of chunks) {
    if (merged.length && (merged.at(-1).length < 28 || chunk.length < 10)) merged[merged.length - 1] += chunk;
    else merged.push(chunk);
  }
  return merged.filter(Boolean);
}

async function revealAssistantAnswer(item, answer, { images = [] } = {}) {
  const chunks = answerRevealChunks(answer);
  let visible = "";
  for (const chunk of chunks) {
    visible += chunk;
    setAssistantContent(item, visible, { images: [] });
    messageList.scrollTo({ top: messageList.scrollHeight, behavior: "smooth" });
    await new Promise((resolve) => setTimeout(resolve, answerRevealDelay(chunk)));
  }
  setAssistantContent(item, answer || "暂时没有生成回答。", { images });
}

function bindMessageActions(scope) {
  const answerText = (button) => button.closest(".message-content")?.querySelector(".answer-content")?.innerText.trim() || "";
  const questionText = (button) => {
    const article = button.closest(".message");
    let previous = article?.previousElementSibling;
    while (previous && !previous.classList.contains("user")) previous = previous.previousElementSibling;
    return previous?.querySelector(".message-body, p")?.innerText.trim() || "";
  };
  scope.querySelectorAll(".copy-answer").forEach((button) => button.addEventListener("click", async () => {
    try { await writeMessageClipboard(answerText(button)); showToast("已复制"); }
    catch { showToast("复制失败，请手动选择文本"); }
  }));
  scope.querySelectorAll(".copy-answer-link").forEach((button) => button.addEventListener("click", () => {
    openAnswerLinkDialog({ v: 1, question: questionText(button), answer: answerText(button) }, button, "copy");
  }));
  scope.querySelectorAll(".share-answer").forEach((button) => button.addEventListener("click", () => {
    openAnswerLinkDialog({ v: 1, question: questionText(button), answer: answerText(button) }, button, "share");
  }));
}

function openAnswerLinkDialog(snapshot, opener, intent) {
  const dialog = messageActionDialog("分享这条问答", opener);
  dialog.append(element("p", { className: "message-dialog-note", text: "仅分享预览中的这一问一答，不包含其他聊天或登录信息。任何获得链接的人都能查看；链接不能撤回，请先确认没有个人或非公开信息。" }));
  answerSharePreview(dialog, snapshot);
  const status = element("p", { className: "message-share-status", attributes: { role: "status", "aria-live": "polite" }, text: "确认后生成链接。" });
  const actions = element("div", { className: "message-dialog-actions" });
  const copy = textButton("确认并复制链接", "primary-button");
  const share = textButton("确认并分享", "secondary-button");
  const run = async (mode) => {
    try {
      status.textContent = "正在生成链接…";
      const url = await createAnswerShareUrl(snapshot, window.location.origin);
      if (mode === "share" && typeof navigator.share === "function") {
        await navigator.share({ title: "ARTS Robotics 问答分享", url });
        status.textContent = "已调用系统分享";
      } else {
        await writeMessageClipboard(url);
        status.textContent = mode === "share" ? "当前浏览器未提供系统分享，链接已复制" : "分享链接已复制";
      }
    } catch (error) {
      status.textContent = error?.name === "AbortError" ? "已取消分享" : error?.message || "分享未完成。";
    }
  };
  copy.addEventListener("click", () => void run("copy"));
  share.addEventListener("click", () => void run("share"));
  actions.append(copy, share);
  dialog.append(status, actions);
  dialog.showModal();
  (intent === "share" ? share : copy).focus({ preventScroll: true });
}

function saveConversation() {
  const turns = [...messageList.querySelectorAll(".message:not(.typing-message)")].map((node) => ({
    role: node.classList.contains("user") ? "user" : "assistant",
    text: node.innerText.trim(),
  })).slice(-20);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(turns)); } catch { /* ignore */ }
}

function restoreConversation() {
  let turns = [];
  try { turns = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { turns = []; }
  if (!Array.isArray(turns) || !turns.length) return;
  body.classList.add("chat-active");
  for (const turn of turns) addMessage(turn.role === "user" ? "user" : "assistant", turn.text || "");
}

async function submitMessage(rawText) {
  const text = String(rawText || "").trim();
  const fileText = attachmentChip.classList.contains("show") ? `附件：${attachmentName.textContent}` : "";
  if (!text && !fileText) return;
  body.classList.add("chat-active");
  addMessage("user", [text, fileText].filter(Boolean).join("\n"));
  promptInput.value = "";
  promptInput.style.height = "auto";
  fileInput.value = "";
  attachmentChip.classList.remove("show");
  updateSendState();
  const typing = addMessage("assistant", "正在检索公开资料，并组织回答…");
  const payload = { answer: text || fileText };
  try {
    const response = await fetch(apiUrl("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: "research",
        messages: [{ role: "user", content: userFacingAnswer(payload.answer) }],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "服务暂不可用，请稍后重试。");
    await revealAssistantAnswer(typing, data.answer || "暂时没有生成回答。", { images: data.images });
  } catch (error) {
    setAssistantContent(typing, error?.message || "服务暂不可用，请稍后重试。");
  }
  saveConversation();
}

function resetChat() {
  messageList.innerHTML = "";
  promptInput.value = "";
  promptInput.style.height = "auto";
  fileInput.value = "";
  attachmentChip.classList.remove("show");
  body.classList.remove("chat-active");
  document.querySelectorAll(".history-item").forEach((item) => item.classList.remove("current"));
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  updateSendState();
  setTimeout(() => promptInput.focus(), 220);
}

function loadHistory(key) {
  const examples = {
    overview: [["user", "实验室主要研究什么？"], ["assistant", "我会从已审核的实验室公开知识中检索研究方向、项目与成果，并给出结构化回答。"]],
    robots: [["user", "实验室现有的机器人平台包括哪些？"], ["assistant", "接入公开知识库后，我会按机器人平台、核心能力、应用场景和资料来源整理回答。"]],
    cooperation: [["user", "如何与实验室开展科研合作？"], ["assistant", "我会根据实验室公开信息说明合作方向、联系渠道和申请要求。"]],
  };
  messageList.innerHTML = "";
  body.classList.add("chat-active");
  for (const [role, text] of examples[key] || examples.overview) addMessage(role, text);
  document.querySelectorAll(".history-item").forEach((item) => item.classList.toggle("current", item.dataset.history === key));
}

async function refreshSuggestions() {
  try {
    const response = await fetch(apiUrl("/api/suggestions"));
    const data = await response.json();
    const suggestions = (Array.isArray(data.suggestions) ? data.suggestions : []).map((item) => typeof item === "string" ? item : item.question).filter(Boolean).slice(0, 4);
    if (!suggestions.length) return;
    document.querySelector(".suggestions").innerHTML = suggestions.map((question, index) => `<button class="suggestion" type="button" data-prompt="${escapeHtml(question)}">${[icons.file, icons.text, icons.chart, icons.pen][index] || icons.chat}<span>${escapeHtml(question.replace(/[？?]$/u, ""))}</span></button>`).join("");
    bindSuggestions();
  } catch { /* keep defaults */ }
}

async function refreshStatus() {
  try {
    const response = await fetch(apiUrl("/api/status"));
    const status = await response.json();
    if (status && status.storageReady === false) showToast("资料服务暂不可用");
  } catch { /* visual preview can be static */ }
}

function bindSuggestions() {
  document.querySelectorAll(".suggestion").forEach((item) => item.addEventListener("click", () => submitMessage(item.dataset.prompt)));
}

form.addEventListener("submit", (event) => { event.preventDefault(); submitMessage(promptInput.value); });
promptInput.addEventListener("input", () => { autoResize(); updateSendState(); });
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
});

document.querySelector(".attach-button").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  attachmentName.textContent = file.name;
  attachmentChip.classList.add("show");
  updateSendState();
});
voiceButton.addEventListener("click", () => showToast("语音输入将在正式服务中启用"));

document.querySelectorAll(".model-nav-item").forEach((item) => item.addEventListener("click", () => {
  document.querySelectorAll(".model-nav-item").forEach((button) => button.classList.remove("active"));
  item.classList.add("active");
  currentMode = item.dataset.mode;
  const copy = MODE_COPY[currentMode];
  heroTitle.textContent = copy[0];
  heroSubtitle.textContent = copy[1];
  promptInput.placeholder = copy[2];
  modelPillLabel.textContent = copy[3];
}));

document.querySelector(".new-chat-bottom").addEventListener("click", resetChat);
document.querySelectorAll(".history-item").forEach((item) => item.addEventListener("click", () => loadHistory(item.dataset.history)));
document.querySelector(".collapse-handle").addEventListener("click", () => body.classList.toggle("sidebar-collapsed"));
document.querySelector(".model-pill").addEventListener("click", () => showToast(`当前使用${MODE_COPY[currentMode][3]}`));
document.querySelectorAll(".settings-trigger").forEach((button) => button.addEventListener("click", openAuthDialog));
document.querySelectorAll(".student-login-trigger").forEach((button) => button.addEventListener("click", openAuthDialog));
campusCodeButton.addEventListener("click", () => void requestCampusCode());
campusLoginForm.addEventListener("submit", (event) => void verifyCampusCode(event));
document.querySelector(".guest-continue").addEventListener("click", closeAuthDialog);
document.querySelector(".auth-close").addEventListener("click", closeAuthDialog);
authBackdrop.addEventListener("click", (event) => { if (event.target === authBackdrop) closeAuthDialog(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && authBackdrop.classList.contains("open")) closeAuthDialog(); });

bindSuggestions();
restoreConversation();
refreshSuggestions();
refreshStatus();
refreshVisitorStatus();
updateSendState();

