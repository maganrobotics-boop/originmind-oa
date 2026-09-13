"use strict";

const APP_NAME = "ARTS Robotics AI Assistant";
const OFFICIAL_SITE = "https://omindos.ai";
const BAILIAN_CONSOLE = "https://bailian.console.aliyun.com/";
const OA_KNOWLEDGE_URL = "https://oa.omindos.ai/";
const OA_CHAT_IMPORT_URL = "https://oa.omindos.ai/api/knowledge/import-chat";
const MAX_TEXT_IMPORT_BYTES = 120_000;
const MAX_BINARY_IMPORT_BYTES = 10 * 1024 * 1024;
const IMPORT_MIME_BY_EXTENSION = Object.freeze({
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
});

const TOPICS = [
  {
    id: "technology",
    path: "/technology",
    requestTopic: "research",
    index: "01",
    title: "技术成果与产业化",
    detail: "核心成果 · 应用转化",
    eyebrow: "TECHNOLOGY & IMPACT",
    heading: "从核心技术到真实场景",
    intro: "了解数字孪生双臂操作、精密装配、智能巡检等成果与产业应用方向。",
    featuredSuggestions: [
      { kind: "latest", text: "四足巡检机器人最近有什么新进展？" },
      { kind: "latest", text: "最近公开了哪些机器人技术成果？" },
    ],
    fallbackSuggestions: [
      "团队有哪些可落地的机器人技术成果？",
      "机器人自主移动与操作包含哪些核心能力？",
    ],
  },
  {
    id: "academic",
    path: "/research",
    requestTopic: "research",
    index: "02",
    title: "科研合作与学术交流",
    detail: "国际合作 · 学术交流",
    eyebrow: "RESEARCH & EXCHANGE",
    heading: "与全球研究网络建立连接",
    intro: "了解团队的国际科研经历、合作网络与代表性研究成果。",
    featuredSuggestions: [
      { kind: "latest", text: "ARTS Robotics 最近公开了哪些研究成果？" },
      { kind: "latest", text: "近期有哪些新的科研合作与交流？" },
    ],
    fallbackSuggestions: [
      "ARTS Robotics 主要研究哪些方向？",
      "团队开展过哪些国内外科研合作？",
    ],
  },
  {
    id: "company",
    path: "/originmind",
    requestTopic: "business",
    index: "03",
    title: "源灵智能科技有限公司",
    detail: "机器人产品 · OmindOS",
    eyebrow: "ORIGINMIND",
    heading: "让机器人硬件与 OmindOS 协同工作",
    intro: "了解深圳源灵智能科技有限公司的机器人产品、工程适配与商业合作方案。",
    featuredSuggestions: [
      { kind: "feature", text: "新上线的四个 AI 模块有什么区别？" },
      { kind: "feature", text: "OmindOS 最近新增了哪些能力？" },
    ],
    fallbackSuggestions: [
      "源灵智能有哪些机器人产品与解决方案？",
      "机器人厂商可以怎样与源灵智能合作？",
    ],
  },
  {
    id: "association",
    path: "/ius",
    requestTopic: "student",
    index: "04",
    title: "智能无人系统创新协会",
    detail: "学生创新 · 科技实践",
    eyebrow: "STUDENT INNOVATION",
    heading: "让学生创新走进机器人前沿",
    intro: "从协会指导教师与所在实验室出发，了解面向学生的智能无人系统研究方向、竞赛与创新成果。",
    featuredSuggestions: [
      { kind: "latest", text: "IUS 最近有哪些活动或项目？" },
      { kind: "latest", text: "近期开放了哪些学生创新机会？" },
    ],
    fallbackSuggestions: [
      "IUS 主要开展哪些机器人创新实践？",
      "学生可以怎样参与协会项目？",
    ],
  },
];

const DEFAULT_TOPIC_ID = TOPICS[0].id;
const TOPIC_ID_BY_PATH = new Map([
  ["/", DEFAULT_TOPIC_ID],
  ...TOPICS.map((topic) => [topic.path, topic.id]),
]);

function topicIdForPath(pathname) {
  return TOPIC_ID_BY_PATH.get(pathname) || DEFAULT_TOPIC_ID;
}

function suggestionsForTopic(topic) {
  const selected = [];
  const candidates = [
    ...(Array.isArray(topic.featuredSuggestions) ? topic.featuredSuggestions.map((item) => item?.text) : []),
    ...(Array.isArray(topic.fallbackSuggestions) ? topic.fallbackSuggestions : []),
  ];
  for (const candidate of candidates) {
    const text = typeof candidate === "string" ? candidate.trim() : "";
    if (!text || selected.includes(text)) continue;
    selected.push(text);
    if (selected.length === 2) break;
  }
  return selected;
}

const TOPIC_LABELS = Object.freeze({
  student: "课题参与",
  research: "科研交流",
  business: "合作咨询",
});

const STATUS_LABELS = Object.freeze({
  pending: "待处理",
  replied: "已联系",
  closed: "已关闭",
});

const root = document.getElementById("app");

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

function icon(text, className = "icon") {
  return element("span", {
    className,
    text,
    attributes: { "aria-hidden": "true" },
  });
}

function textButton(label, className = "") {
  const button = element("button", { className, text: label });
  button.type = "button";
  return button;
}

function brandLink() {
  const link = element("a", {
    className: "wordmark",
    attributes: { href: "/", "aria-label": "OriginMind 首页" },
  });
  link.append(document.createTextNode("OriginMind"));
  link.append(element("span", { className: "brand-square", attributes: { "aria-hidden": "true" } }));
  return link;
}

function safeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function externalLink(label, href, className = "") {
  const safeHref = safeHttpUrl(href);
  if (!safeHref) return null;
  const link = element("a", {
    className,
    attributes: {
      href: safeHref,
      target: "_blank",
      rel: "noopener noreferrer",
    },
  });
  link.append(document.createTextNode(label), icon("↗", "link-arrow"));
  return link;
}

function setRegion(region, message) {
  region.textContent = message || "";
  region.hidden = !message;
}

async function requestJson(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...options,
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error("处理超时，请压缩或拆分文件后重试。");
    }
    throw new Error("暂时无法连接服务，请稍后重试。");
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // A non-JSON response is treated as an unavailable service below.
  }

  if (!response.ok) {
    const fallback = response.status === 401 ? "登录状态已失效，请重新登录。" : "服务暂时不可用，请稍后重试。";
    throw new Error(typeof payload?.error === "string" ? payload.error : fallback);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("服务返回异常，请稍后重试。");
  }
  return payload;
}

function jsonOptions(body, method = "POST") {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function makeRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function sourceOriginLabel(origin) {
  return origin === "oa_public" ? "OA 已审核公开" : "公开资料";
}

function adminSourceOriginLabel(origin) {
  return origin === "oa_public" ? "OA 已审核公开" : "Chat 待审核草稿";
}

function serviceLabel(service) {
  if (!service) return "正在连接…";
  if (!service.storageReady) return "资料服务暂不可用";
  return service.modelReady ? "基于 OA 审核公开资料回答" : "公开资料检索模式";
}

function createPublicApp() {
  document.documentElement.classList.add("public-chat-page");
  document.body.classList.add("public-chat-page");

  const state = {
    section: topicIdForPath(window.location.pathname),
    service: null,
    serviceError: "",
    sessions: Object.fromEntries(TOPICS.map((topic) => [topic.id, {
      requestTopic: topic.requestTopic,
      messages: [],
      conversationToken: "",
      draft: "",
      scrollTop: 0,
      stickToEnd: true,
      sending: false,
      error: "",
      notice: "",
    }])),
    inquiry: {
      name: "",
      organisation: "",
      contact: "",
      summary: "",
      includeConversation: false,
      consent: false,
      submitting: false,
      requestId: "",
      reference: "",
      error: "",
      section: "",
    },
  };

  function topicFor(section = state.section) {
    return TOPICS.find((topic) => topic.id === section) || TOPICS[0];
  }

  function sessionFor(section = state.section) {
    return state.sessions[section] || state.sessions[TOPICS[0].id];
  }

  function hasResettableState(session) {
    return Boolean(session.messages.length || session.draft || session.error || session.notice);
  }

  const app = element("div", { className: "chat-app" });
  const header = element("header", { className: "topbar site-header" });
  const menuButton = textButton("", "menu-button");
  menuButton.setAttribute("aria-label", "打开主题菜单");
  menuButton.setAttribute("aria-controls", "topic-drawer");
  menuButton.setAttribute("aria-expanded", "false");
  menuButton.append(element("span", {
    className: "menu-glyph",
    attributes: { "aria-hidden": "true" },
  }, [
    element("span", { className: "menu-line" }),
    element("span", { className: "menu-line" }),
  ]));
  const topicTitle = element("h1", { className: "topic-title", text: topicFor().title });
  const headerBalance = element("span", {
    className: "header-balance",
    attributes: { "aria-hidden": "true" },
  });
  const statusText = element("span", {
    className: "sr-only",
    text: serviceLabel(null),
    attributes: { role: "status", "aria-live": "polite" },
  });
  const topicStatus = element("span", {
    className: "sr-only",
    attributes: { role: "status", "aria-live": "polite" },
  });
  header.append(menuButton, topicTitle, headerBalance, statusText, topicStatus);

  const topicDrawer = element("dialog", {
    id: "topic-drawer",
    className: "topic-drawer",
    attributes: { "aria-labelledby": "topic-drawer-title" },
  });
  const drawerPanel = element("div", { className: "drawer-panel" });
  const drawerHeader = element("div", { className: "drawer-header" });
  const drawerTitle = element("div", { className: "drawer-title" }, [
    element("strong", { id: "topic-drawer-title", text: "ARTS Robotics" }),
    element("span", { text: "选择主题" }),
  ]);
  const drawerClose = textButton("×", "drawer-close");
  drawerClose.setAttribute("aria-label", "关闭主题菜单");
  drawerHeader.append(drawerTitle, drawerClose);

  const topicList = element("nav", {
    className: "drawer-topic-list",
    attributes: { "aria-label": "选择主题" },
  });
  const topicLinks = new Map();
  for (const topic of TOPICS) {
    const link = element("a", {
      className: "drawer-topic-link",
      attributes: { href: topic.path },
    });
    if (topic.id === state.section) link.setAttribute("aria-current", "page");
    link.append(
      element("span", { text: topic.title }),
      icon("›", "drawer-topic-arrow"),
    );
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      closeTopicDrawer();
      activateTopic(topic.id, { historyMode: "push", announce: true });
    });
    topicLinks.set(topic.id, link);
    topicList.append(link);
  }
  topicLinks.get(state.section)?.classList.add("selected");

  const drawerActions = element("div", { className: "drawer-actions" });
  const newConversation = textButton("新对话", "drawer-action drawer-reset");
  newConversation.disabled = true;
  const officialLink = externalLink("访问官网", OFFICIAL_SITE, "drawer-action drawer-link");
  const manageLink = element("a", {
    className: "drawer-action drawer-link",
    attributes: { href: "/manage" },
    text: "管理入口",
  });
  drawerActions.append(newConversation);
  if (officialLink) drawerActions.append(officialLink);
  drawerActions.append(manageLink);
  drawerPanel.append(drawerHeader, topicList, drawerActions);
  topicDrawer.append(drawerPanel);

  function closeTopicDrawer() {
    if (!topicDrawer.open) return;
    menuButton.setAttribute("aria-expanded", "false");
    topicDrawer.close();
  }

  menuButton.addEventListener("click", () => {
    if (topicDrawer.open) return;
    menuButton.setAttribute("aria-expanded", "true");
    topicDrawer.showModal();
    window.requestAnimationFrame(() => topicLinks.get(state.section)?.focus());
  });
  drawerClose.addEventListener("click", closeTopicDrawer);
  topicDrawer.addEventListener("click", (event) => {
    if (event.target === topicDrawer) closeTopicDrawer();
  });
  topicDrawer.addEventListener("cancel", () => {
    menuButton.setAttribute("aria-expanded", "false");
  });
  topicDrawer.addEventListener("close", () => {
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.focus();
  });

  const layout = element("main", { className: "chat-layout" });
  const conversation = element("section", {
    className: "conversation",
    attributes: { "aria-label": "咨询对话" },
  });
  newConversation.addEventListener("click", () => {
    const session = sessionFor();
    if (session.sending || !hasResettableState(session)) return;
    session.messages = [];
    session.conversationToken = "";
    session.draft = "";
    session.scrollTop = 0;
    session.stickToEnd = true;
    session.error = "";
    session.notice = "";
    if (state.inquiry.section === state.section) {
      state.inquiry.summary = "";
      state.inquiry.includeConversation = false;
    }
    questionInput.value = "";
    resizeQuestionInput();
    syncFeedback();
    updateComposer();
    renderMessages({ scrollMode: "start" });
    topicStatus.textContent = `已清空${topicFor().title}对话并返回精选问题`;
    closeTopicDrawer();
    window.requestAnimationFrame(() => questionInput.focus());
  });

  const messageScroll = element("div", {
    className: "message-scroll",
    attributes: {
      tabindex: "0",
      role: "log",
      "aria-label": "对话内容",
      "aria-live": "polite",
      "aria-relevant": "additions text",
      "aria-busy": "false",
    },
  });
  const composerArea = element("div", { className: "composer-area" });
  const errorRegion = element("p", {
    className: "error",
    attributes: { role: "alert", "aria-live": "assertive" },
  });
  const noticeRegion = element("p", {
    className: "small-note composer-notice",
    attributes: { role: "status", "aria-live": "polite" },
  });
  errorRegion.hidden = true;
  noticeRegion.hidden = true;

  const suggestionPanel = element("section", {
    className: "composer-suggestions",
    attributes: { "aria-label": "聊聊新话题" },
  });
  const suggestionTitle = element("p", { className: "suggestion-title", text: "聊聊新话题" });
  const suggestionList = element("div", {
    className: "suggestions",
    attributes: { role: "group" },
  });
  suggestionPanel.append(suggestionTitle, suggestionList);

  const composer = element("form", { className: "composer" });
  const questionLabel = element("label", {
    className: "sr-only",
    text: "你的问题",
    attributes: { for: "question" },
  });
  const questionInput = element("textarea", {
    id: "question",
    attributes: {
      maxlength: "2000",
      rows: "1",
      placeholder: "输入消息",
      autocomplete: "off",
    },
  });
  const sendButton = textButton("发送", "send-button");
  sendButton.type = "submit";
  sendButton.setAttribute("aria-label", "发送问题");
  sendButton.disabled = true;
  composer.append(questionLabel, questionInput, sendButton);
  composerArea.append(errorRegion, noticeRegion, suggestionPanel, composer);
  conversation.append(messageScroll, composerArea);
  layout.append(conversation);

  const sourceDialog = element("dialog", {
    className: "content-dialog source-dialog",
    attributes: {
      "aria-labelledby": "source-dialog-title",
      "aria-describedby": "source-dialog-description",
    },
  });
  const inquiryDialog = element("dialog", {
    className: "content-dialog inquiry-dialog",
    attributes: {
      "aria-labelledby": "inquiry-dialog-title",
      "aria-describedby": "inquiry-dialog-description",
    },
  });
  let sourceDialogOpener = null;
  let inquiryDialogOpener = null;
  let renderEpoch = 0;
  sourceDialog.addEventListener("close", () => {
    const opener = sourceDialogOpener;
    sourceDialogOpener = null;
    if (opener?.isConnected) opener.focus();
  });
  inquiryDialog.addEventListener("close", () => {
    state.inquiry.reference = "";
    state.inquiry.error = "";
    const opener = inquiryDialogOpener;
    inquiryDialogOpener = null;
    if (opener?.isConnected) opener.focus();
  });

  app.append(header, layout, topicDrawer, sourceDialog, inquiryDialog);
  root.replaceChildren(app);

  let viewportFrame = 0;
  function syncChatViewport() {
    window.cancelAnimationFrame(viewportFrame);
    viewportFrame = window.requestAnimationFrame(() => {
      const viewport = window.visualViewport;
      const followsVisualViewport = viewport && document.activeElement === questionInput;
      const height = followsVisualViewport ? viewport.height : window.innerHeight;
      const offsetTop = followsVisualViewport ? viewport.offsetTop : 0;
      app.style.setProperty("--chat-viewport-height", `${Math.max(1, Math.round(height))}px`);
      app.style.setProperty("--chat-viewport-offset", `${Math.max(0, Math.round(offsetTop))}px`);
      if (sessionFor().stickToEnd) messageScroll.scrollTop = messageScroll.scrollHeight;
    });
  }

  function resizeQuestionInput() {
    questionInput.style.height = "44px";
    questionInput.style.height = `${Math.min(questionInput.scrollHeight, 112)}px`;
  }

  function saveCurrentView() {
    const session = sessionFor();
    session.draft = questionInput.value;
    session.scrollTop = messageScroll.scrollTop;
    session.stickToEnd = session.messages.length === 0 ||
      messageScroll.scrollHeight - messageScroll.clientHeight - messageScroll.scrollTop <= 24;
  }

  function syncTopicControls() {
    for (const [section, link] of topicLinks) {
      const selected = section === state.section;
      link.classList.toggle("selected", selected);
      if (selected) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    }
    topicTitle.textContent = topicFor().title;
  }

  function activateTopic(section, { historyMode = "none", announce = false } = {}) {
    const nextTopic = TOPICS.find((topic) => topic.id === section);
    if (!nextTopic) return;

    const changed = state.section !== nextTopic.id;
    if (changed) saveCurrentView();
    if (historyMode === "push" && window.location.pathname !== nextTopic.path) {
      window.history.pushState({ topic: nextTopic.id }, "", nextTopic.path);
    }

    if (changed) {
      state.section = nextTopic.id;
      questionInput.value = sessionFor().draft;
      resizeQuestionInput();
      syncFeedback();
      updateComposer();
      const session = sessionFor();
      renderMessages({
        scrollMode: session.messages.length === 0
          ? "start"
          : session.stickToEnd ? "end" : "restore",
      });
    }

    syncTopicControls();
    if (announce) topicStatus.textContent = `已切换到${nextTopic.title}`;
  }

  function syncFeedback() {
    const session = sessionFor();
    setRegion(errorRegion, session.error || state.serviceError);
    setRegion(noticeRegion, session.notice);
  }

  function updateComposer() {
    const session = sessionFor();
    sendButton.disabled = session.sending || !questionInput.value.trim();
    questionInput.setAttribute("aria-busy", session.sending ? "true" : "false");
    newConversation.disabled = session.sending || !hasResettableState(session);
    messageScroll.setAttribute("aria-busy", session.sending ? "true" : "false");
    for (const [section, button] of topicLinks) {
      const candidate = sessionFor(section);
      button.classList.toggle("busy", candidate.sending);
      button.setAttribute("aria-busy", candidate.sending ? "true" : "false");
    }
  }

  function openSource(source, opener) {
    sourceDialogOpener = opener || document.activeElement;
    sourceDialog.replaceChildren();
    const headerBlock = element("div", { className: "dialog-header" });
    headerBlock.append(
      element("p", { className: "eyebrow", text: "SOURCE" }),
      element("h2", { id: "source-dialog-title", text: String(source?.title || "参考资料") }),
      element("p", {
        id: "source-dialog-description",
        className: "dialog-description",
        text: "本回答引用的 OA 审核公开资料",
      }),
    );
    const closeButton = textButton("关闭", "dialog-close");
    closeButton.setAttribute("aria-label", "关闭资料详情");
    closeButton.addEventListener("click", () => sourceDialog.close());
    headerBlock.append(closeButton);
    sourceDialog.append(
      headerBlock,
      element("p", { className: "source-excerpt", text: String(source?.excerpt || "") }),
      element("p", {
        className: "small-note",
        text: `公开范围：${sourceOriginLabel(source?.origin)}`,
      }),
      element("p", {
        className: "small-note",
        text: `资料日期：${String(source?.updatedAt || "未标注")}`,
      }),
    );
    const original = externalLink("打开原始资料", source?.url, "primary-link");
    if (original) sourceDialog.append(original);
    if (!sourceDialog.open) sourceDialog.showModal();
  }

  async function copyAnswer(content, section) {
    const session = sessionFor(section);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(content);
      session.notice = "已复制回答";
    } catch {
      session.notice = "无法自动复制，请长按选择文字。";
    }
    if (state.section === section) syncFeedback();
  }

  function assistantMessageNode(message, section) {
    const article = element("article", {
      className: `message ${message.role}`,
      attributes: { "aria-label": message.role === "user" ? "你发送的消息" : `${APP_NAME} 的回答` },
    });
    article.append(element("div", { className: "message-body", text: String(message.content || "") }));

    if (message.role === "assistant") {
      const sources = Array.isArray(message.sources) ? message.sources : [];
      if (sources.length) {
        const sourceList = element("div", { className: "source-list", attributes: { "aria-label": "回答来源" } });
        sources.forEach((source, index) => {
          const button = textButton("", "source-button");
          button.append(icon("□"), element("span", { text: `[${index + 1}] ${String(source?.title || "参考资料")}` }));
          button.addEventListener("click", (event) => openSource(source, event.currentTarget));
          sourceList.append(button);
        });
        article.append(sourceList);
      }

      const actions = element("div", { className: "message-actions" });
      const copy = textButton("", "copy-answer");
      copy.setAttribute("aria-label", "复制回答");
      copy.append(icon("□"));
      copy.addEventListener("click", () => void copyAnswer(String(message.content || ""), section));
      const further = textButton("需要进一步交流", "further-inquiry");
      further.addEventListener("click", (event) => openInquiry(event.currentTarget));
      actions.append(copy, further);
      article.append(actions);
    }
    return article;
  }

  function dispatchQuestion(rawQuestion, section) {
    const question = String(rawQuestion || "").trim();
    if (!question || sessionFor(section).sending) return;
    const request = sendQuestion(question, section);
    if (state.section === section) questionInput.focus({ preventScroll: true });
    void request.catch(() => {});
  }

  function renderSuggestions() {
    const topic = topicFor();
    const section = state.section;
    const session = sessionFor(section);
    suggestionPanel.hidden = session.messages.length > 0;
    suggestionList.replaceChildren();
    suggestionList.setAttribute("aria-label", `${topic.title}精选问题`);
    if (suggestionPanel.hidden) return;
    for (const suggestion of suggestionsForTopic(topic)) {
      const button = textButton("", "suggestion-button");
      button.append(element("span", { text: suggestion }));
      button.addEventListener("click", () => dispatchQuestion(suggestion, section));
      suggestionList.append(button);
    }
  }

  function renderMessages({ scrollMode = "restore" } = {}) {
    const section = state.section;
    const session = sessionFor(section);
    const topic = topicFor(section);
    const restoreTop = session.scrollTop;
    const epoch = ++renderEpoch;
    const content = element("div", { className: session.messages.length ? "message-list" : "empty-conversation" });
    if (session.messages.length) {
      for (const message of session.messages) content.append(assistantMessageNode(message, section));
      if (session.sending) {
        content.append(
          element("div", {
            className: "thinking",
            attributes: { role: "status", "aria-live": "polite" },
          }, [
            icon("◌", "spin"),
            state.service?.modelReady ? "正在查阅公开资料并组织回答…" : "正在检索公开资料…",
          ]),
        );
      }
    }
    messageScroll.setAttribute("aria-live", "off");
    messageScroll.replaceChildren(content);
    messageScroll.setAttribute("role", session.messages.length ? "log" : "region");
    messageScroll.setAttribute("aria-label", `${topic.title}对话内容`);
    messageScroll.setAttribute("aria-live", session.messages.length ? "polite" : "off");
    renderSuggestions();
    newConversation.disabled = session.sending || !hasResettableState(session);
    window.requestAnimationFrame(() => {
      if (state.section !== section || renderEpoch !== epoch) return;
      if (session.messages.length === 0 || scrollMode === "start") {
        messageScroll.scrollTop = 0;
      } else if (scrollMode === "end") {
        messageScroll.scrollTop = messageScroll.scrollHeight;
      } else {
        const maximum = Math.max(0, messageScroll.scrollHeight - messageScroll.clientHeight);
        messageScroll.scrollTop = Math.min(restoreTop, maximum);
      }
      session.scrollTop = messageScroll.scrollTop;
      session.stickToEnd = session.messages.length === 0 ||
        messageScroll.scrollHeight - messageScroll.clientHeight - messageScroll.scrollTop <= 24;
    });
  }

  async function sendQuestion(rawQuestion, section = state.section) {
    const session = sessionFor(section);
    const topic = topicFor(section);
    const question = String(rawQuestion || "").trim();
    if (!question || session.sending) {
      if (session.sending) throw new Error("请等待当前回答完成");
      return null;
    }
    if (question.length > 2000) {
      session.error = "每次问题请控制在 2000 字以内。";
      if (state.section === section) syncFeedback();
      throw new Error(session.error);
    }

    const previousMessages = session.messages.slice();
    const previousScrollTop = session.scrollTop;
    const previousStickToEnd = session.stickToEnd;
    let completed = false;
    session.sending = true;
    session.error = "";
    session.notice = "";
    session.messages.push({ role: "user", content: question });
    session.draft = "";
    session.stickToEnd = true;
    if (state.section === section) {
      questionInput.value = "";
      resizeQuestionInput();
      syncFeedback();
      updateComposer();
      renderMessages({ scrollMode: "end" });
    }

    try {
      const payload = await requestJson("/api/chat", jsonOptions({
        messages: (session.conversationToken ? session.messages.slice(-1) : session.messages.slice(-9)).map(({ role, content }) => ({ role, content })),
        topic: topic.requestTopic,
        ...(session.conversationToken ? { conversationToken: session.conversationToken } : {}),
      }));
      const assistant = {
        role: "assistant",
        content: typeof payload.answer === "string" ? payload.answer : "暂时没有可显示的回答。",
        sources: Array.isArray(payload.sources) ? payload.sources : [],
        mode: payload.mode,
        provider: payload.provider,
      };
      session.conversationToken = typeof payload.conversationToken === "string" ? payload.conversationToken : "";
      session.messages.push(assistant);
      completed = true;
      return {
        answer: assistant.content,
        sourceTitles: assistant.sources.map((source) => String(source?.title || "参考资料")),
      };
    } catch (error) {
      session.messages = previousMessages;
      session.draft = question;
      session.scrollTop = previousScrollTop;
      session.stickToEnd = previousStickToEnd;
      session.error = error instanceof Error ? error.message : "服务暂时不可用";
      if (state.section === section) {
        questionInput.value = session.draft;
        resizeQuestionInput();
        syncFeedback();
      }
      throw error;
    } finally {
      session.sending = false;
      updateComposer();
      if (state.section === section) {
        questionInput.value = session.draft;
        resizeQuestionInput();
        syncFeedback();
        renderMessages({
          scrollMode: completed
            ? session.stickToEnd ? "end" : "restore"
            : session.messages.length === 0 ? "start" : session.stickToEnd ? "end" : "restore",
        });
      }
    }
  }

  function prefillInquirySummary() {
    const inquiry = state.inquiry;
    if (inquiry.section !== state.section) {
      inquiry.section = state.section;
      inquiry.summary = "";
      inquiry.includeConversation = false;
    }
    if (inquiry.summary) return;
    inquiry.summary = sessionFor(inquiry.section).messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n")
      .slice(0, 3000);
  }

  function renderInquiryDialog() {
    inquiryDialog.replaceChildren();
    const inquiry = state.inquiry;
    const headerBlock = element("div", { className: "dialog-header" });
    headerBlock.append(
      element("p", { className: "eyebrow", text: "CONTACT ARTS ROBOTICS" }),
      element("h2", {
        id: "inquiry-dialog-title",
        text: inquiry.reference ? "咨询已提交" : "向 ARTS Robotics 团队提交咨询",
      }),
      element("p", {
        id: "inquiry-dialog-description",
        className: "dialog-description",
        text: inquiry.reference
          ? "已进入待处理列表。提交不代表录取、报价或合作确认。"
          : "只有在你主动提交咨询后，联系信息及你选择附带的对话才会进入待处理列表。",
      }),
    );
    const close = textButton("关闭", "dialog-close");
    close.setAttribute("aria-label", "关闭咨询窗口");
    close.disabled = inquiry.submitting;
    close.addEventListener("click", () => inquiryDialog.close());
    headerBlock.append(close);
    inquiryDialog.append(headerBlock);

    if (inquiry.reference) {
      const success = element("div", { className: "ticket-success" });
      success.append(
        icon("✓", "success-icon"),
        element("strong", { text: `编号 ${inquiry.reference}` }),
        element("p", { text: "如需进一步沟通，团队将使用你提供的联系方式联系你。" }),
      );
      const done = textButton("完成", "primary-button");
      done.addEventListener("click", () => inquiryDialog.close());
      success.append(done);
      inquiryDialog.append(success);
      return;
    }

    const form = element("form", { className: "stack-form inquiry-form" });
    const pair = element("div", { className: "form-pair" });
    const nameField = createField("inquiry-name", "姓名");
    nameField.input.required = true;
    nameField.input.maxLength = 60;
    nameField.input.autocomplete = "name";
    nameField.input.value = inquiry.name;
    nameField.input.addEventListener("input", (event) => { inquiry.name = event.currentTarget.value; });
    const organisationField = createField("inquiry-organisation", "学校 / 单位");
    organisationField.input.maxLength = 120;
    organisationField.input.autocomplete = "organization";
    organisationField.input.value = inquiry.organisation;
    organisationField.input.addEventListener("input", (event) => { inquiry.organisation = event.currentTarget.value; });
    pair.append(nameField.wrapper, organisationField.wrapper);

    const contactField = createField("inquiry-contact", "邮箱、电话或微信");
    contactField.input.required = true;
    contactField.input.minLength = 3;
    contactField.input.maxLength = 120;
    contactField.input.autocomplete = "email";
    contactField.input.value = inquiry.contact;
    contactField.input.addEventListener("input", (event) => { inquiry.contact = event.currentTarget.value; });

    const summaryLabel = element("label", { attributes: { for: "inquiry-summary" } });
    summaryLabel.append(document.createTextNode("希望沟通的事项"));
    const summary = element("textarea", {
      id: "inquiry-summary",
      attributes: { required: true, minlength: "10", maxlength: "3000", rows: "4" },
    });
    summary.value = inquiry.summary;
    summary.addEventListener("input", (event) => { inquiry.summary = event.currentTarget.value; });
    summaryLabel.append(summary);

    const includeLabel = element("label", { className: "check-label" });
    const include = element("input", { attributes: { type: "checkbox" } });
    include.checked = inquiry.includeConversation;
    include.addEventListener("change", (event) => { inquiry.includeConversation = event.currentTarget.checked; });
    includeLabel.append(include, element("span", { text: "附上本次最近的对话，便于了解背景" }));

    const consentLabel = element("label", { className: "check-label" });
    const consent = element("input", { attributes: { type: "checkbox", required: true } });
    consent.checked = inquiry.consent;
    consent.addEventListener("change", (event) => { inquiry.consent = event.currentTarget.checked; });
    consentLabel.append(
      consent,
      element("span", {
        text: "同意将以上信息提交给 ARTS Robotics 团队及授权管理人员，用于本次咨询联络。",
      }),
    );

    const inquiryError = element("p", {
      className: "error",
      attributes: { role: "alert", "aria-live": "assertive" },
      text: inquiry.error,
    });
    inquiryError.hidden = !inquiry.error;
    const actions = element("div", { className: "dialog-actions" });
    const cancel = textButton("取消", "secondary-button");
    cancel.disabled = inquiry.submitting;
    cancel.addEventListener("click", () => inquiryDialog.close());
    const submit = textButton(inquiry.submitting ? "正在提交…" : "确认提交", "primary-button");
    submit.type = "submit";
    submit.disabled = inquiry.submitting || !inquiry.consent;
    consent.addEventListener("change", () => { submit.disabled = inquiry.submitting || !consent.checked; });
    actions.append(cancel, submit);
    form.append(pair, contactField.wrapper, summaryLabel, includeLabel, consentLabel, inquiryError, actions);
    form.addEventListener("submit", (event) => void submitInquiry(event));
    inquiryDialog.append(form);
  }

  async function submitInquiry(event) {
    event.preventDefault();
    const inquiry = state.inquiry;
    const section = state.sessions[inquiry.section] ? inquiry.section : state.section;
    const session = sessionFor(section);
    const topic = topicFor(section);
    if (inquiry.submitting || !inquiry.consent) return;
    inquiry.submitting = true;
    inquiry.error = "";
    renderInquiryDialog();
    try {
      const payload = await requestJson("/api/inquiries", jsonOptions({
        requestId: inquiry.requestId,
        name: inquiry.name,
        organisation: inquiry.organisation,
        contact: inquiry.contact,
        topic: topic.requestTopic,
        summary: inquiry.summary,
        consent: inquiry.consent,
        includeConversation: inquiry.includeConversation,
        transcript: inquiry.includeConversation
          ? session.messages.slice(-12).map(({ role, content }) => ({ role, content }))
          : [],
      }));
      inquiry.reference = String(payload.reference || "");
      inquiry.name = "";
      inquiry.organisation = "";
      inquiry.contact = "";
      inquiry.summary = "";
      inquiry.consent = false;
      inquiry.includeConversation = false;
      inquiry.section = "";
    } catch (error) {
      inquiry.error = error instanceof Error ? error.message : "提交失败";
    } finally {
      inquiry.submitting = false;
      renderInquiryDialog();
    }
  }

  function openInquiry(opener) {
    if (state.inquiry.submitting) return;
    inquiryDialogOpener = opener instanceof HTMLElement ? opener : document.activeElement;
    prefillInquirySummary();
    state.inquiry.requestId = makeRequestId();
    state.inquiry.reference = "";
    state.inquiry.error = "";
    renderInquiryDialog();
    if (!inquiryDialog.open) inquiryDialog.showModal();
    window.requestAnimationFrame(() => inquiryDialog.querySelector("input")?.focus());
  }

  function createField(id, labelText, type = "text") {
    const wrapper = element("label", { attributes: { for: id } });
    wrapper.append(document.createTextNode(labelText));
    const input = element("input", { id, attributes: { type } });
    wrapper.append(input);
    return { wrapper, input };
  }

  messageScroll.addEventListener("scroll", () => {
    const session = sessionFor();
    session.scrollTop = messageScroll.scrollTop;
    session.stickToEnd = session.messages.length === 0 ||
      messageScroll.scrollHeight - messageScroll.clientHeight - messageScroll.scrollTop <= 24;
  }, { passive: true });
  questionInput.addEventListener("input", () => {
    sessionFor().draft = questionInput.value;
    resizeQuestionInput();
    updateComposer();
  });
  questionInput.addEventListener("focus", syncChatViewport);
  questionInput.addEventListener("blur", syncChatViewport);
  window.addEventListener("resize", syncChatViewport, { passive: true });
  window.visualViewport?.addEventListener("resize", syncChatViewport, { passive: true });
  window.visualViewport?.addEventListener("scroll", syncChatViewport, { passive: true });
  questionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      dispatchQuestion(questionInput.value, state.section);
    }
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    dispatchQuestion(questionInput.value, state.section);
  });
  window.addEventListener("popstate", () => {
    activateTopic(topicIdForPath(window.location.pathname), { announce: true });
  });

  syncTopicControls();
  renderMessages({ scrollMode: "start" });
  resizeQuestionInput();
  syncChatViewport();
  updateComposer();
  void requestJson("/api/status")
    .then((payload) => {
      state.service = payload;
      state.serviceError = "";
      statusText.textContent = serviceLabel(payload);
      syncFeedback();
    })
    .catch((error) => {
      state.service = { storageReady: false, modelReady: false };
      statusText.textContent = serviceLabel(state.service);
      state.serviceError = error instanceof Error ? error.message : "暂时无法连接服务，请稍后重试。";
      syncFeedback();
    });

  const modelContext = document.modelContext;
  if (modelContext && typeof modelContext.registerTool === "function") {
    const controller = new AbortController();
    const tool = {
      name: "ask_arts_robotics_assistant",
      title: `向 ${APP_NAME} 提问`,
      description: "提交问题并在当前对话中显示回答；不提交联系人或转交咨询。",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", minLength: 1, maxLength: 2000 },
        },
        required: ["question"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: true,
      },
      execute: async (input) => {
        if (!input || typeof input.question !== "string" || !input.question.trim() || input.question.length > 2000) {
          throw new Error("请输入 1–2000 字的问题");
        }
        const section = state.section;
        if (sessionFor(section).sending) throw new Error("请等待当前回答完成");
        return sendQuestion(input.question, section);
      },
    };
    try {
      Promise.resolve(modelContext.registerTool(tool, { signal: controller.signal })).catch(() => {});
      window.addEventListener("pagehide", () => controller.abort(), { once: true });
    } catch {
      // Model Context support is optional in ordinary browsers.
    }
  }
}

function createAdminApp() {
  document.documentElement.classList.remove("public-chat-page");
  document.body.classList.remove("public-chat-page");

  const state = {
    signedIn: null,
    authChecked: false,
    authBusy: false,
    authError: "",
    loading: false,
    busy: "",
    error: "",
    notice: "",
    activeTab: "inquiries",
    initialized: false,
    oaStatus: null,
    config: {
      baseUrl: "",
      model: "qwen-plus",
      apiKey: "",
      keyConfigured: false,
      encryptionReady: false,
      activeProvider: null,
      workersAiReady: false,
    },
    documents: [],
    importReceipts: {},
    inquiries: [],
    draft: emptyDraft(),
  };

  function emptyDraft() {
    return {
      id: "",
      title: "",
      body: "",
      url: "",
      category: "research",
      updatedAt: new Date().toISOString().slice(0, 10),
      published: 0,
    };
  }

  function adminRequest(endpoint, options) {
    return requestJson(`/api/admin/${endpoint}`, options);
  }

  async function submitDocumentToOa(draft) {
    let response;
    try {
      response = await fetch(OA_CHAT_IMPORT_URL, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: {
          id: draft.id, title: draft.title, body: draft.body, url: draft.url || "",
          category: draft.category, updatedAt: draft.updatedAt,
        } }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("Chat 草稿已保留，暂未确认进入 OA。请确认已登录 OA 后点击“提交 OA 待审”重试；重复提交不会重复建单。");
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Chat 草稿已保留，OA 暂未接收，请稍后重试。");
    if (!Array.isArray(result.items) || !result.items.length) throw new Error("OA 未返回接收记录，草稿仍保留，请重试。");
    state.importReceipts[draft.id] = result.items;
    state.notice = result.items.every((item) => item.status === "pending")
      ? `已提交 OA 待审（${result.items.length} 条）。在 OA“实验室 AI”的待审核列表中处理，对内或公开由审核时选择。`
      : "OA 已接收过该版本资料，重复提交不会新增条目。请打开 OA 查看当前审核状态。";
  }

  async function fetchAdminData(initial = false) {
    const [configPayload, documentPayload, inquiryPayload] = await Promise.all([
      adminRequest("config"),
      adminRequest("documents"),
      adminRequest("inquiries"),
    ]);
    state.config = {
      ...state.config,
      ...configPayload,
      apiKey: "",
    };
    state.documents = Array.isArray(documentPayload.documents) ? documentPayload.documents : [];
    state.inquiries = Array.isArray(inquiryPayload.inquiries) ? inquiryPayload.inquiries : [];
    if (initial && !state.initialized) {
      state.activeTab = state.config.keyConfigured ? "inquiries" : "model";
      state.initialized = true;
    }
  }

  async function runAdminAction(key, action) {
    if (state.busy) return;
    state.busy = key;
    state.error = "";
    state.notice = "";
    renderAdminShell();
    try {
      await action();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "操作失败";
    } finally {
      state.busy = "";
      renderAdminShell();
    }
  }

  function renderLogin() {
    const shell = element("main", { className: "admin-shell auth-shell" });
    const back = element("a", {
      className: "primary-link back-link",
      text: "返回咨询页面",
      attributes: { href: "/" },
    });
    const card = element("section", { className: "admin-card auth-card" });
    card.append(
      element("p", { className: "eyebrow", text: "SECURE ACCESS" }),
      element("h1", { text: `${APP_NAME} · 管理` }),
    );

    if (!state.authChecked && !state.authError) {
      card.append(
        element("p", {
          className: "thinking",
          attributes: { role: "status", "aria-live": "polite" },
        }, [icon("◌", "spin"), "正在连接…"]),
      );
    } else {
      const form = element("form", { className: "stack-form auth-form" });
      const passwordLabel = element("label", { attributes: { for: "admin-password" } });
      const password = element("input", {
        id: "admin-password",
        attributes: {
          type: "password",
          required: true,
          maxlength: "256",
          autocomplete: "current-password",
        },
      });
      passwordLabel.append(document.createTextNode("管理员密码"), password);
      const submit = textButton(state.authBusy ? "正在登录…" : "登录", "primary-button");
      submit.type = "submit";
      submit.disabled = state.authBusy;
      form.append(passwordLabel, submit);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (state.authBusy) return;
        state.authBusy = true;
        state.authError = "";
        submit.disabled = true;
        submit.textContent = "正在登录…";
        try {
          await requestJson("/api/auth/login", jsonOptions({ password: password.value }));
          password.value = "";
          state.signedIn = true;
          state.loading = true;
          renderAdminShell();
          try {
            await fetchAdminData(true);
          } catch (error) {
            state.error = error instanceof Error ? error.message : "读取管理数据失败";
          } finally {
            state.loading = false;
            renderAdminShell();
          }
        } catch (error) {
          state.authError = error instanceof Error ? error.message : "登录失败";
          state.authBusy = false;
          renderLogin();
        }
      });
      card.append(form);
    }

    const authError = element("p", {
      className: "error",
      text: state.authError,
      attributes: { role: "alert", "aria-live": "assertive" },
    });
    authError.hidden = !state.authError;
    card.append(authError);
    shell.append(back, card);
    root.replaceChildren(shell);
  }

  function adminHeader() {
    const header = element("header", { className: "topbar admin-topbar" });
    const returnLink = element("a", {
      className: "site-link",
      attributes: { href: "/" },
    }, [icon("←"), "返回咨询页面"]);
    const actions = element("div", { className: "admin-header-actions" });
    const logout = textButton(state.busy === "logout" ? "正在退出…" : "退出管理", "secondary-button");
    logout.disabled = Boolean(state.busy);
    logout.addEventListener("click", () => {
      void runAdminAction("logout", async () => {
        await requestJson("/api/auth/logout", jsonOptions({}));
        state.signedIn = false;
        state.authChecked = true;
        state.authBusy = false;
        state.authError = "";
        state.initialized = false;
        renderLogin();
      });
    });
    actions.append(returnLink, logout);
    header.append(brandLink(), actions);
    return header;
  }

  function tabButton(id, label, count) {
    const selected = state.activeTab === id;
    const button = textButton("", `admin-tab${selected ? " selected" : ""}`);
    button.id = `admin-tab-${id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.setAttribute("aria-controls", `admin-panel-${id}`);
    button.tabIndex = selected ? 0 : -1;
    button.append(element("span", { text: label }));
    if (count !== undefined) button.append(element("span", { className: "tab-count", text: count }));
    button.addEventListener("click", () => {
      state.activeTab = id;
      renderAdminShell();
      document.getElementById(`admin-tab-${id}`)?.focus();
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const ids = ["inquiries", "documents", "model"];
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const next = (ids.indexOf(id) + offset + ids.length) % ids.length;
      state.activeTab = ids[next];
      renderAdminShell();
      document.getElementById(`admin-tab-${ids[next]}`)?.focus();
    });
    return button;
  }

  function adminPanel(id, className = "admin-card") {
    return element("section", {
      id: `admin-panel-${id}`,
      className,
      attributes: {
        role: "tabpanel",
        "aria-labelledby": `admin-tab-${id}`,
        tabindex: "0",
      },
    });
  }

  function labelledInput(id, labelText, type = "text") {
    const label = element("label", { attributes: { for: id } });
    label.append(document.createTextNode(labelText));
    const input = element("input", { id, attributes: { type } });
    label.append(input);
    return { label, input };
  }

  function renderModelPanel() {
    const panel = adminPanel("model");
    panel.append(
      element("p", { className: "eyebrow", text: "MODEL CONNECTION" }),
      element("h2", { text: "阿里云百炼 · 通义千问" }),
      element("p", { className: "admin-notice", text: state.config.activeProvider === "bailian"
        ? `当前使用阿里云千问 · ${state.config.model} · 已保存并验证`
        : state.config.workersAiReady ? "当前使用 Cloudflare 备用模型；阿里云配置验证通过后自动切换。"
        : "当前为资料检索模式；保存并连接千问后启用 AI 回答。" }),
      element("p", {
        className: "admin-notice",
        text: "选择华北 2（北京）地域。密钥仅在此管理页填写，保存后不会再显示完整值。模型调用按阿里云账户实际用量计费。",
      }),
    );

    const form = element("form", { className: "stack-form model-form" });
    const baseUrl = labelledInput("model-base-url", "API Base URL", "url");
    baseUrl.input.required = true;
    baseUrl.input.maxLength = 300;
    baseUrl.input.placeholder = "https://业务空间ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
    baseUrl.input.value = state.config.baseUrl || "";
    baseUrl.input.addEventListener("input", (event) => { state.config.baseUrl = event.currentTarget.value; });
    baseUrl.label.append(
      element("span", {
        className: "small-note",
        text: "在百炼“业务空间管理”复制 API Host，再加 /compatible-mode/v1。",
      }),
    );

    const model = labelledInput("model-name", "模型名称");
    model.input.required = true;
    model.input.maxLength = 101;
    model.input.pattern = "qwen[a-zA-Z0-9_.-]{1,100}";
    model.input.value = state.config.model || "qwen-plus";
    model.input.addEventListener("input", (event) => { state.config.model = event.currentTarget.value; });
    model.label.append(
      element("span", {
        className: "small-note",
        text: "默认 qwen-plus，以你的北京地域控制台可用模型为准。",
      }),
    );

    const apiKey = labelledInput("model-api-key", "API Key", "password");
    apiKey.input.maxLength = 400;
    apiKey.input.autocomplete = "new-password";
    apiKey.input.spellcheck = false;
    apiKey.input.className = "secret-input";
    apiKey.input.placeholder = state.config.keyConfigured ? "已保存；不更换则留空" : "在此填写百炼 API Key";
    apiKey.input.value = state.config.apiKey || "";
    apiKey.input.addEventListener("input", (event) => { state.config.apiKey = event.currentTarget.value; });

    const actions = element("div", { className: "admin-buttons" });
    const save = textButton(state.busy === "config" ? "正在验证并保存…" : "保存并连接", "primary-button");
    save.type = "submit";
    save.disabled = Boolean(state.busy) || !state.config.encryptionReady;
    const test = textButton(state.busy === "model-test" ? "正在检测…" : "检测连接", "secondary-button");
    test.disabled = Boolean(state.busy) || !state.config.keyConfigured;
    test.addEventListener("click", () => {
      void runAdminAction("model-test", async () => {
        await adminRequest("test", jsonOptions({}));
        state.config = { ...state.config, ...await adminRequest("config"), apiKey: "" };
        state.notice = "连接成功，真实 AI 对话已可使用。";
      });
    });
    actions.append(save, test);
    form.append(baseUrl.label, model.label, apiKey.label, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void runAdminAction("config", async () => {
        const body = {
          baseUrl: state.config.baseUrl,
          model: state.config.model,
        };
        if (state.config.apiKey) body.apiKey = state.config.apiKey;
        const result = await adminRequest("config", jsonOptions(body));
        state.config = { ...state.config, ...result };
        state.config.apiKey = "";
        state.config.keyConfigured = true;
        state.notice = "千问连接已验证，配置已保存并启用。之后的提问会继续使用该配置。";
      });
    });
    panel.append(form);
    const consoleLink = externalLink("打开阿里云百炼控制台", BAILIAN_CONSOLE, "primary-link");
    if (consoleLink) panel.append(consoleLink);
    if (!state.config.encryptionReady) {
      panel.append(element("p", { className: "error", text: "安全保存尚未配置，请先完成站点的加密设置。" }));
    }
    panel.append(
      element("p", {
        className: "small-note",
        text: "当前版本默认每个访问来源每小时最多 25 次提问，全站每日最多 300 次 AI 回答。未接入生成模型时仍可使用公开资料检索模式。",
      }),
    );
    return panel;
  }

  function renderDocumentsPanel() {
    const wrapper = element("div", {
      id: "admin-panel-documents",
      className: "admin-panel-stack",
      attributes: {
        role: "tabpanel",
        "aria-labelledby": "admin-tab-documents",
        tabindex: "0",
      },
    });

    const connection = element("section", { className: "admin-card" });
    const oaStatus = state.oaStatus === "connected"
      ? "已连接"
      : state.oaStatus === "not_configured"
        ? "未配置"
        : state.oaStatus === "unavailable"
          ? "暂不可用"
          : "尚未检测";
    connection.append(
      element("p", { className: "eyebrow", text: "KNOWLEDGE CONNECTION" }),
      element("h2", { text: "OA 公开知识连接" }),
      element("p", {
        className: "small-note",
        text: `只检测服务端连接和响应格式，不显示也不返回 Token。状态：${oaStatus}`,
      }),
    );
    const probe = textButton(state.busy === "oa-test" ? "正在检测…" : "检测 OA 公开知识", "secondary-button");
    probe.disabled = Boolean(state.busy);
    probe.addEventListener("click", () => {
      void runAdminAction("oa-test", async () => {
        const payload = await adminRequest("oa-test", jsonOptions({}));
        state.oaStatus = payload.oaPublicKnowledge || "unavailable";
        state.notice = state.oaStatus === "connected"
          ? "OA 公开知识连接正常。"
          : state.oaStatus === "not_configured"
            ? "尚未配置 OA 公共知识服务 Token。"
            : "OA 公开知识暂不可用，请核对两端 Token 和 OA 部署状态。";
      });
    });
    connection.append(element("div", { className: "admin-buttons" }, [probe]));

    const editor = element("section", { className: "admin-card document-editor" });
    editor.append(
      element("p", { className: "eyebrow", text: "DRAFT WORKSPACE" }),
      element("h2", { text: state.draft.id ? "编辑资料" : "添加待审核草稿" }),
      element("p", {
        className: "small-note",
        text: "保存后提交至 OA 待审。请在同一浏览器登录 OA；审核时选择对内或公开，未经审核的资料不会用于回答。",
      }),
    );
    const form = element("form", { className: "stack-form document-form" });
    const title = labelledInput("document-title", "资料标题");
    title.input.required = true;
    title.input.minLength = 2;
    title.input.maxLength = 120;
    title.input.value = state.draft.title;
    title.input.disabled = Boolean(state.busy);
    title.input.addEventListener("input", (event) => { state.draft.title = event.currentTarget.value; });

    const pair = element("div", { className: "form-pair" });
    const categoryLabel = element("label", { attributes: { for: "document-category" } });
    categoryLabel.append(document.createTextNode("咨询方向"));
    const category = element("select", { id: "document-category" });
    category.disabled = Boolean(state.busy);
    for (const id of ["student", "research", "business"]) {
      const option = element("option", { text: TOPIC_LABELS[id], attributes: { value: id } });
      if (state.draft.category === id) option.selected = true;
      category.append(option);
    }
    category.addEventListener("change", (event) => { state.draft.category = event.currentTarget.value; });
    categoryLabel.append(category);
    const date = labelledInput("document-date", "资料日期", "date");
    date.input.required = true;
    date.input.value = state.draft.updatedAt;
    date.input.disabled = Boolean(state.busy);
    date.input.addEventListener("input", (event) => { state.draft.updatedAt = event.currentTarget.value; });
    pair.append(categoryLabel, date.label);

    const url = labelledInput("document-url", "原始资料链接（可选）", "url");
    url.input.maxLength = 1500;
    url.input.value = state.draft.url;
    url.input.disabled = Boolean(state.busy);
    url.input.addEventListener("input", (event) => { state.draft.url = event.currentTarget.value; });

    const bodyLabel = element("label", { attributes: { for: "document-body" } });
    bodyLabel.append(document.createTextNode("供助手引用的正文"));
    const body = element("textarea", {
      id: "document-body",
      className: "admin-textarea",
      attributes: { required: true, minlength: "10", maxlength: "30000" },
    });
    body.value = state.draft.body;
    body.disabled = Boolean(state.busy);
    body.addEventListener("input", (event) => { state.draft.body = event.currentTarget.value; });
    bodyLabel.append(body);

    const fileLabel = element("label", { attributes: { for: "document-file" } });
    fileLabel.append(document.createTextNode(state.busy === "file" ? "正在自动解析…" : "导入资料文件"));
    const fileInput = element("input", {
      id: "document-file",
      attributes: {
        type: "file",
        accept: ".txt,.md,.pdf,.jpg,.jpeg,.png,.webp,text/plain,text/markdown,application/pdf,image/jpeg,image/png,image/webp",
      },
    });
    const focusImportedField = (id) => {
      window.requestAnimationFrame(() => {
        const target = document.getElementById(id);
        target?.scrollIntoView?.({ behavior: "smooth", block: "center" });
        target?.focus?.({ preventScroll: true });
      });
    };
    fileInput.disabled = Boolean(state.busy);
    fileInput.addEventListener("change", async (event) => {
      const file = event.currentTarget.files?.[0];
      if (!file || state.busy) return;
      state.notice = "";
      const extension = file.name.split(".").at(-1)?.toLowerCase() || "";
      const isText = extension === "txt" || extension === "md";
      const extractionMimeType = IMPORT_MIME_BY_EXTENSION[extension];
      if (!isText && !extractionMimeType) {
        state.error = "仅支持 TXT、Markdown、PDF、JPG、PNG 和 WebP 文件。";
        renderAdminShell();
        focusImportedField("document-file");
        return;
      }
      const maximum = isText ? MAX_TEXT_IMPORT_BYTES : MAX_BINARY_IMPORT_BYTES;
      if (file.size > maximum) {
        state.error = isText
          ? "文本文件过大，请分成更短的资料条目。"
          : "PDF 或图片不能超过 10 MB，请压缩或拆分后重试。";
        renderAdminShell();
        focusImportedField("document-file");
        return;
      }
      if (state.draft.body.trim() && !window.confirm("导入新文件将替换当前正文，是否继续？")) {
        event.currentTarget.value = "";
        return;
      }
      state.busy = "file";
      state.error = "";
      renderAdminShell();
      let imported = false;
      try {
        let text;
        if (isText) {
          text = await file.text();
        } else {
          const result = await adminRequest("extract", {
            method: "POST",
            headers: {
              "Content-Type": extractionMimeType,
              "X-File-Name": encodeURIComponent(file.name),
            },
            body: file,
            signal: AbortSignal.timeout(120_000),
          });
          if (typeof result.text !== "string") throw new Error("文件解析结果异常，请稍后重试。");
          text = result.text;
        }
        if (text.length > 30000) throw new Error("每条资料最多 30000 字");
        if (text.trim().length < 10) throw new Error("未识别到足够内容，请手动填写正文。");
        if (!state.draft.title) {
          state.draft.title = file.name
            .replace(/\.(txt|md|pdf|jpe?g|png|webp)$/i, "")
            .trim()
            .slice(0, 120);
        }
        state.draft.body = text;
        imported = true;
        state.notice = isText
          ? "文本已导入，请核对后保存草稿。"
          : `${extension === "pdf" ? "PDF" : "图片"}已由 Cloudflare AI 临时解析（${text.length} 字），本站未保存原件。请核对识别结果后提交。`;
      } catch (error) {
        state.error = error instanceof Error ? error.message : "读取失败";
      } finally {
        state.busy = "";
        renderAdminShell();
        focusImportedField(imported ? "document-body" : "document-file");
      }
    });
    fileLabel.append(
      fileInput,
      element("span", {
        className: "small-note",
        text: "支持 TXT、Markdown、PDF、JPG、PNG、WebP。PDF、扫描件和图片会发送至 Cloudflare AI 临时解析，本站不保存原件；识别可能有误，请提交前核对。单个文件不超过 10 MB，解析正文最多 30000 字。",
      }),
    );

    const actions = element("div", { className: "admin-buttons" });
    const save = textButton(state.busy === "document" ? "正在保存并提交…" : "保存并提交 OA 待审", "primary-button");
    save.type = "submit";
    save.disabled = Boolean(state.busy);
    actions.append(save);
    if (state.draft.id) {
      const cancel = textButton("取消编辑", "secondary-button");
      cancel.disabled = Boolean(state.busy);
      cancel.addEventListener("click", () => {
        state.draft = emptyDraft();
        renderAdminShell();
      });
      actions.append(cancel);
    }
    form.append(
      title.label,
      pair,
      url.label,
      bodyLabel,
      fileLabel,
      element("p", {
        className: "small-note",
        text: "提交失败时保留 Chat 草稿，可从下方列表重试；重复提交同一版本不会重复建单。",
      }),
      actions,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void runAdminAction("document", async () => {
        const draft = { ...state.draft };
        const saved = await adminRequest("documents", jsonOptions({
          ...(state.draft.id ? { id: state.draft.id } : {}),
          title: state.draft.title,
          body: state.draft.body,
          url: state.draft.url,
          category: state.draft.category,
          updatedAt: state.draft.updatedAt,
          published: 0,
        }));
        delete state.importReceipts[saved.id];
        const payload = await adminRequest("documents");
        state.documents = Array.isArray(payload.documents) ? payload.documents : [];
        state.draft = emptyDraft();
        await submitDocumentToOa({ ...draft, id: saved.id });
      });
    });
    editor.append(form);

    const list = element("section", { className: "admin-card document-list" });
    list.append(
      element("p", { className: "eyebrow", text: "LOCAL DRAFTS" }),
      element("h2", { text: `资料列表 · ${state.documents.length}` }),
      externalLink("打开 OA 登录／查看待审核", OA_KNOWLEDGE_URL, "primary-link"),
    );
    if (!state.documents.length) {
      list.append(element("div", { className: "admin-empty", text: "暂时没有待审核草稿。" }));
    } else {
      for (const document of state.documents) {
        const article = element("article", { className: "admin-item" });
        const head = element("div", { className: "admin-item-head" });
        head.append(
          element("div", {}, [
            element("h3", { text: String(document.title || "未命名资料") }),
            element("p", {
              text: `${TOPIC_LABELS[document.category] || "未分类"} · ${String(document.updatedAt || "未标注")} · ${state.importReceipts[document.id] ? "OA 已接收" : "Chat 草稿，可提交 OA"}`,
            }),
          ]),
        );
        const edit = textButton("编辑", "secondary-button small-button");
        edit.disabled = Boolean(state.busy);
        edit.addEventListener("click", () => {
          state.draft = {
            id: String(document.id || ""),
            title: String(document.title || ""),
            body: String(document.body || ""),
            url: String(document.url || ""),
            category: TOPIC_LABELS[document.category] ? document.category : "research",
            updatedAt: String(document.updatedAt || emptyDraft().updatedAt),
            published: 0,
          };
          renderAdminShell();
          window.scrollTo({ top: 0, behavior: "smooth" });
        });
        head.append(edit);
        const submit = textButton(state.busy === `submit-${document.id}` ? "正在提交…" : "提交 OA 待审", "primary-button small-button");
        submit.disabled = Boolean(state.busy);
        submit.addEventListener("click", () => { void runAdminAction(`submit-${document.id}`, () => submitDocumentToOa(document)); });
        head.append(submit);
        const documentBody = String(document.body || "");
        article.append(
          head,
          element("p", { text: `${documentBody.slice(0, 200)}${documentBody.length > 200 ? "…" : ""}` }),
        );
        list.append(article);
      }
    }

    wrapper.append(connection, editor, list);
    return wrapper;
  }

  function parseTranscript(value) {
    let parsed = value;
    if (typeof value === "string") {
      try {
        parsed = JSON.parse(value);
      } catch {
        return [];
      }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((turn) => turn && typeof turn.content === "string" && (turn.role === "user" || turn.role === "assistant"));
  }

  function formatBeijingTime(value) {
    try {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value || "未标注");
      return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    } catch {
      return String(value || "未标注");
    }
  }

  function renderInquiriesPanel() {
    const panel = adminPanel("inquiries");
    panel.append(
      element("p", { className: "eyebrow", text: "INQUIRIES" }),
      element("h2", { text: "咨询记录" }),
      element("p", {
        className: "small-note",
        text: "仅显示访客确认提交的内容。以下记录不表示已经发出通知或邮件。",
      }),
    );
    if (!state.inquiries.length) {
      panel.append(element("div", { className: "admin-empty", text: "暂时没有咨询。访客提交后会显示在这里。" }));
      return panel;
    }

    for (const inquiry of state.inquiries) {
      const article = element("article", { className: "admin-item inquiry-item" });
      const head = element("div", { className: "admin-item-head" });
      head.append(
        element("div", {}, [
          element("h3", {
            text: `${String(inquiry.name || "未署名")}${inquiry.organisation ? ` · ${inquiry.organisation}` : ""}`,
          }),
          element("p", {
            text: `${String(inquiry.reference || "无编号")} · ${TOPIC_LABELS[inquiry.topic] || "未分类"} · ${formatBeijingTime(inquiry.createdAt)}`,
          }),
        ]),
        element("span", { className: `status-label status-${inquiry.status}`, text: STATUS_LABELS[inquiry.status] || "未知" }),
      );
      article.append(
        head,
        element("p", { className: "contact-line", text: `联系方式：${String(inquiry.contact || "未提供")}` }),
        element("pre", { text: String(inquiry.summary || "") }),
      );
      const transcript = parseTranscript(inquiry.transcript);
      if (transcript.length) {
        const details = element("details", { className: "transcript-details" });
        details.append(
          element("summary", { className: "small-note", text: "查看访客同意附带的对话" }),
          element("pre", {
            text: transcript
              .map((turn) => `${turn.role === "user" ? "访客" : "助手"}：${turn.content}`)
              .join("\n\n"),
          }),
        );
        article.append(details);
      }
      const actions = element("div", { className: "admin-buttons" });
      for (const nextStatus of ["pending", "replied", "closed"]) {
        if (nextStatus === inquiry.status) continue;
        const action = textButton(`标记${STATUS_LABELS[nextStatus]}`, "secondary-button small-button");
        action.disabled = Boolean(state.busy);
        action.addEventListener("click", () => {
          void runAdminAction(`inquiry-${inquiry.id}`, async () => {
            await adminRequest("inquiries", jsonOptions({ id: inquiry.id, status: nextStatus }, "PATCH"));
            state.inquiries = state.inquiries.map((candidate) => (
              candidate.id === inquiry.id ? { ...candidate, status: nextStatus } : candidate
            ));
            state.notice = "状态已更新。";
          });
        });
        actions.append(action);
      }
      article.append(actions);
      panel.append(article);
    }
    return panel;
  }

  function renderAdminShell() {
    if (!state.signedIn) {
      renderLogin();
      return;
    }
    const app = element("div", { className: "admin-app" });
    app.append(adminHeader());
    const shell = element("main", { className: "admin-shell" });
    const heading = element("div", { className: "admin-heading" });
    heading.append(
      element("div", {}, [
        element("p", { className: "eyebrow", text: "OPERATIONS CONSOLE" }),
        element("h1", { text: `${APP_NAME} · 管理` }),
        element("p", { text: "查看 OA 连接，维护待审核草稿，处理咨询与模型配置。" }),
      ]),
    );
    const refresh = textButton(state.busy === "refresh" ? "正在刷新…" : "刷新", "secondary-button refresh-button");
    refresh.disabled = Boolean(state.busy) || state.loading;
    refresh.addEventListener("click", () => {
      void runAdminAction("refresh", async () => {
        await fetchAdminData(false);
        state.notice = "管理数据已刷新。";
      });
    });
    heading.append(refresh);
    shell.append(heading);

    const error = element("p", {
      className: "error",
      text: state.error,
      attributes: { role: "alert", "aria-live": "assertive" },
    });
    error.hidden = !state.error;
    const notice = element("p", {
      className: "admin-notice global-notice",
      text: state.notice,
      attributes: { role: "status", "aria-live": "polite" },
    });
    notice.hidden = !state.notice;
    shell.append(error, notice);

    if (state.loading) {
      shell.append(
        element("p", {
          className: "thinking admin-loading",
          attributes: { role: "status", "aria-live": "polite" },
        }, [icon("◌", "spin"), "正在读取配置和咨询…"]),
      );
    } else {
      const tabs = element("div", {
        className: "admin-tabs",
        attributes: { role: "tablist", "aria-label": "管理功能" },
      });
      const pendingCount = state.inquiries.filter((inquiry) => inquiry.status === "pending").length;
      tabs.append(
        tabButton("inquiries", "咨询", pendingCount),
        tabButton("documents", "知识资料"),
        tabButton("model", "模型接入"),
      );
      shell.append(tabs);
      if (state.activeTab === "model") shell.append(renderModelPanel());
      if (state.activeTab === "documents") shell.append(renderDocumentsPanel());
      if (state.activeTab === "inquiries") shell.append(renderInquiriesPanel());
    }
    app.append(shell);
    root.replaceChildren(app);
  }

  async function initialize() {
    renderLogin();
    try {
      const payload = await requestJson("/api/auth/status");
      state.signedIn = Boolean(payload.signedIn);
      state.authChecked = true;
      state.authError = "";
      if (state.signedIn) {
        state.loading = true;
        renderAdminShell();
        try {
          await fetchAdminData(true);
        } catch (error) {
          state.error = error instanceof Error ? error.message : "读取管理数据失败";
        } finally {
          state.loading = false;
          renderAdminShell();
        }
      } else {
        renderLogin();
      }
    } catch (error) {
      state.authChecked = true;
      state.authError = error instanceof Error ? error.message : "暂时无法连接，请刷新页面。";
      renderLogin();
    }
  }

  void initialize();
}

if (window.location.pathname === "/manage") {
  createAdminApp();
} else {
  createPublicApp();
}
