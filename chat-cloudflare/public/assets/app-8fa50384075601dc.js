"use strict";

const APP_NAME = "ARTS Robotics AI assistant";
const HEADER_NAME = "ARTS Robotics AI Assistant";
const OFFICIAL_SITE = "https://omindos.ai";
const BAILIAN_CONSOLE = "https://bailian.console.aliyun.com/";

const TOPICS = [
  {
    id: "student",
    index: "01",
    title: "课题参与",
    detail: "研究方向 · 申请准备",
    prompt: "我想了解 ARTS Robotics 的研究方向，以及申请加入课题组需要准备什么。",
  },
  {
    id: "research",
    index: "02",
    title: "科研交流",
    detail: "研究工作 · 技术讨论",
    prompt: "课题组在双臂操作和机器人系统方面有哪些公开研究？",
  },
  {
    id: "business",
    index: "03",
    title: "合作咨询",
    detail: "应用需求 · 合作咨询",
    prompt: "我们希望开展机器人项目合作，应该先提供哪些需求信息？",
  },
];

const SUGGESTIONS = [
  "ARTS Robotics 目前公开的研究方向有哪些？",
  "想参与课题研究，需要提前准备什么？",
  "有哪些已公开的双臂操作与机器人系统研究？",
  "提出机器人应用合作需求前，应准备哪些信息？",
];

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

function publicBrandLink() {
  return element("a", {
    className: "lab-brand",
    attributes: { href: "/", "aria-label": "ARTS Robotics 首页" },
  }, [
    element("span", { className: "lab-brand-mark", attributes: { "aria-hidden": "true" } }),
    element("span", { className: "lab-brand-copy" }, [
      element("span", { className: "lab-brand-cn", text: "机器人自主自动与操作实验室" }),
      element("strong", { className: "lab-brand-en", text: "ARTS Robotics" }),
    ]),
  ]);
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
  } catch {
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
  const state = {
    messages: [],
    topic: "student",
    service: null,
    sending: false,
    error: "",
    notice: "",
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
    },
  };

  const app = element("div", { className: "chat-app" });
  const header = element("header", { className: "topbar site-header" });
  const title = element("div", { className: "topbar-center", text: HEADER_NAME });
  header.append(publicBrandLink(), title);

  const layout = element("main", { className: "chat-layout" });
  const contextPanel = element("aside", {
    className: "context-panel",
    attributes: { "aria-label": "咨询方向" },
  });
  const contextHeading = element("div", { className: "context-heading" });
  contextHeading.append(
    element("h1", { text: "从一个问题，走近机器人研究。" }),
    element("p", {
      text: "基于 OA 审核公开资料，了解 ARTS Robotics 的研究方向、课题参与与合作信息。",
    }),
  );

  const topicList = element("div", {
    className: "topic-list",
    attributes: { "aria-label": "选择咨询方向" },
  });
  const topicButtons = new Map();
  for (const topic of TOPICS) {
    const button = textButton("", "topic-card");
    button.setAttribute("aria-pressed", topic.id === state.topic ? "true" : "false");
    button.append(
      element("span", { className: "topic-index", text: topic.index, attributes: { "aria-hidden": "true" } }),
      element("span", { className: "topic-copy" }, [
        element("strong", { text: topic.title }),
        element("small", { text: topic.detail }),
      ]),
      icon("→", "topic-arrow"),
    );
    button.addEventListener("click", () => {
      state.topic = topic.id;
      for (const [id, candidate] of topicButtons) {
        const selected = id === state.topic;
        candidate.classList.toggle("selected", selected);
        candidate.setAttribute("aria-pressed", selected ? "true" : "false");
      }
      questionInput.value = topic.prompt;
      updateComposer();
      questionInput.focus();
    });
    topicButtons.set(topic.id, button);
    topicList.append(button);
  }
  topicButtons.get(state.topic)?.classList.add("selected");

  const contextBottom = element("div", { className: "context-bottom" });
  const boundary = element("p", {
    text: "仅依据 OA 已审核公开资料\n重要事项由团队负责人确认",
  });
  const manageLink = element("a", {
    className: "manage-link",
    attributes: { href: "/manage" },
  }, [icon("◇", "manage-icon"), "管理入口"]);
  contextBottom.append(boundary, manageLink);
  contextPanel.append(contextHeading, topicList, contextBottom);

  const conversation = element("section", {
    className: "conversation",
    attributes: { "aria-label": "咨询对话" },
  });
  const toolbar = element("div", { className: "conversation-toolbar" });
  const assistantIdentity = element("div", { className: "assistant-identity" });
  const statusText = element("small", { text: serviceLabel(null) });
  assistantIdentity.append(
    element("span", { className: "assistant-avatar", text: "AI", attributes: { "aria-hidden": "true" } }),
    element("span", { className: "assistant-name" }, [
      element("strong", { text: APP_NAME }),
      statusText,
    ]),
  );
  const newConversation = textButton("", "new-conversation");
  newConversation.append(icon("＋"), element("span", { className: "new-text", text: "新对话" }));
  newConversation.disabled = true;
  newConversation.addEventListener("click", () => {
    if (state.sending || state.messages.length === 0) return;
    state.messages = [];
    state.error = "";
    state.notice = "";
    questionInput.value = "";
    updateComposer();
    renderMessages();
    questionInput.focus();
  });
  toolbar.append(assistantIdentity, newConversation);

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
      rows: "2",
      placeholder: "输入问题，或简要描述你的研究与合作需求…",
      autocomplete: "off",
    },
  });
  const composerBottom = element("div", { className: "composer-bottom" });
  const characterCount = element("span", { text: "Shift + Enter 换行" });
  const sendButton = textButton("", "send-button");
  sendButton.type = "submit";
  sendButton.setAttribute("aria-label", "发送问题");
  sendButton.append(icon("↑", "send-icon"));
  sendButton.disabled = true;
  composerBottom.append(characterCount, sendButton);
  composer.append(questionLabel, questionInput, composerBottom);

  const composerFooter = element("div", { className: "composer-footer" });
  composerFooter.append(
    element("span", {
      text: "AI 回答仅供参考，不构成 ARTS Robotics、OriginMind 或任何个人的承诺。请勿输入个人敏感信息、未公开成果或商业机密。",
    }),
  );
  const submitInquiryButton = textButton("", "inquiry-trigger");
  submitInquiryButton.append(icon("◇"), document.createTextNode("提交咨询"));
  composerFooter.append(submitInquiryButton);
  composerArea.append(errorRegion, noticeRegion, composer, composerFooter);
  conversation.append(toolbar, messageScroll, composerArea);
  layout.append(contextPanel, conversation);

  const siteFooter = element("footer", { className: "site-footer" });
  siteFooter.append(element("strong", {
    className: "site-footer-credit",
    text: "OriginMind x ARTS Robotics",
  }));
  const footerOfficial = externalLink("访问官网", OFFICIAL_SITE, "site-link site-footer-link");
  if (footerOfficial) siteFooter.append(footerOfficial);

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

  app.append(header, layout, siteFooter, sourceDialog, inquiryDialog);
  root.replaceChildren(app);

  function updateComposer() {
    const length = questionInput.value.length;
    characterCount.textContent = length ? `${length}/2000` : "Shift + Enter 换行";
    sendButton.disabled = state.sending || !questionInput.value.trim();
    questionInput.disabled = state.sending;
    newConversation.disabled = state.sending || state.messages.length === 0;
    messageScroll.setAttribute("aria-busy", state.sending ? "true" : "false");
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

  async function copyAnswer(content) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(content);
      state.notice = "已复制回答";
    } catch {
      state.notice = "无法自动复制，请长按选择文字。";
    }
    setRegion(noticeRegion, state.notice);
  }

  function assistantMessageNode(message) {
    const article = element("article", { className: `message ${message.role}` });
    const label = element("div", { className: "message-label" });
    label.append(document.createTextNode(message.role === "user" ? "你" : APP_NAME));
    if (message.mode === "retrieval") {
      label.append(element("span", { text: "资料摘录" }));
    }
    article.append(label, element("div", { className: "message-body", text: String(message.content || "") }));

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
      copy.addEventListener("click", () => void copyAnswer(String(message.content || "")));
      const further = textButton("需要进一步交流", "further-inquiry");
      further.addEventListener("click", (event) => openInquiry(event.currentTarget));
      actions.append(copy, further);
      article.append(actions);
    }
    return article;
  }

  function welcomeNode() {
    const welcome = element("div", { className: "welcome" });
    welcome.append(
      element("div", { className: "welcome-mark", text: "AI", attributes: { "aria-hidden": "true" } }),
      element("p", { className: "eyebrow", text: "ASK ARTS ROBOTICS" }),
      element("h2", { text: "欢迎使用 ARTS Robotics AI assistant" }),
      element("p", {
        text: "你可以从研究方向、课题参与或合作需求开始。涉及 ARTS Robotics 的事实性回答均以 OA 审核公开资料为依据，并在可用时标注来源。",
      }),
    );
    const suggestions = element("div", { className: "suggestions", attributes: { "aria-label": "建议问题" } });
    for (const suggestion of SUGGESTIONS) {
      const button = textButton("", "suggestion-button");
      button.append(element("span", { text: suggestion }), icon("→", "suggestion-arrow"));
      button.addEventListener("click", () => void sendQuestion(suggestion));
      suggestions.append(button);
    }
    welcome.append(
      suggestions,
      element("div", { className: "welcome-note" }, [
        icon("◇"),
        element("span", { text: "OA 审核公开资料 · 重要事项由团队确认" }),
      ]),
    );
    return welcome;
  }

  function renderMessages() {
    const content = element("div", { className: state.messages.length ? "message-list" : "welcome-shell" });
    if (state.messages.length) {
      for (const message of state.messages) content.append(assistantMessageNode(message));
      if (state.sending) {
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
    } else {
      content.append(welcomeNode());
    }
    messageScroll.replaceChildren(content);
    newConversation.disabled = state.sending || state.messages.length === 0;
    window.requestAnimationFrame(() => {
      messageScroll.scrollTop = messageScroll.scrollHeight;
    });
  }

  async function sendQuestion(rawQuestion) {
    const question = String(rawQuestion || "").trim();
    if (!question || state.sending) {
      if (state.sending) throw new Error("请等待当前回答完成");
      return null;
    }
    if (question.length > 2000) {
      state.error = "每次问题请控制在 2000 字以内。";
      setRegion(errorRegion, state.error);
      throw new Error(state.error);
    }

    const previousMessages = state.messages.slice();
    state.sending = true;
    state.error = "";
    state.notice = "";
    state.messages.push({ role: "user", content: question });
    questionInput.value = "";
    setRegion(errorRegion, "");
    setRegion(noticeRegion, "");
    updateComposer();
    renderMessages();

    try {
      const payload = await requestJson("/api/chat", jsonOptions({
        messages: state.messages.slice(-9).map(({ role, content }) => ({ role, content })),
        topic: state.topic,
      }));
      const assistant = {
        role: "assistant",
        content: typeof payload.answer === "string" ? payload.answer : "暂时没有可显示的回答。",
        sources: Array.isArray(payload.sources) ? payload.sources : [],
        mode: payload.mode,
      };
      state.messages.push(assistant);
      return {
        answer: assistant.content,
        sourceTitles: assistant.sources.map((source) => String(source?.title || "参考资料")),
      };
    } catch (error) {
      state.messages = previousMessages;
      questionInput.value = question;
      state.error = error instanceof Error ? error.message : "服务暂时不可用";
      setRegion(errorRegion, state.error);
      throw error;
    } finally {
      state.sending = false;
      updateComposer();
      renderMessages();
    }
  }

  function prefillInquirySummary() {
    if (state.inquiry.summary) return;
    state.inquiry.summary = state.messages
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
        topic: state.topic,
        summary: inquiry.summary,
        consent: inquiry.consent,
        includeConversation: inquiry.includeConversation,
        transcript: inquiry.includeConversation
          ? state.messages.slice(-12).map(({ role, content }) => ({ role, content }))
          : [],
      }));
      inquiry.reference = String(payload.reference || "");
      inquiry.name = "";
      inquiry.organisation = "";
      inquiry.contact = "";
      inquiry.summary = "";
      inquiry.consent = false;
      inquiry.includeConversation = false;
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

  questionInput.addEventListener("input", updateComposer);
  questionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendQuestion(questionInput.value).catch(() => {});
    }
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendQuestion(questionInput.value).catch(() => {});
  });
  submitInquiryButton.addEventListener("click", (event) => openInquiry(event.currentTarget));

  renderMessages();
  updateComposer();
  void requestJson("/api/status")
    .then((payload) => {
      state.service = payload;
      statusText.textContent = serviceLabel(payload);
    })
    .catch((error) => {
      state.service = { storageReady: false, modelReady: false };
      statusText.textContent = serviceLabel(state.service);
      state.error = error instanceof Error ? error.message : "暂时无法连接服务，请稍后重试。";
      setRegion(errorRegion, state.error);
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
        if (state.sending) throw new Error("请等待当前回答完成");
        return sendQuestion(input.question);
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
    const save = textButton(state.busy === "config" ? "正在保存…" : "保存配置", "primary-button");
    save.type = "submit";
    save.disabled = Boolean(state.busy) || !state.config.encryptionReady;
    const test = textButton(state.busy === "model-test" ? "正在检测…" : "检测连接", "secondary-button");
    test.disabled = Boolean(state.busy) || !state.config.keyConfigured;
    test.addEventListener("click", () => {
      void runAdminAction("model-test", async () => {
        await adminRequest("test", jsonOptions({}));
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
        await adminRequest("config", jsonOptions(body));
        state.config.apiKey = "";
        state.config.keyConfigured = true;
        state.notice = "配置已保存。请点击“检测连接”确认模型可用。";
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
        text: "此处只能暂存待审核草稿；对外知识必须在 OA 审核为“公开”后由系统接入。",
      }),
    );
    const form = element("form", { className: "stack-form document-form" });
    const title = labelledInput("document-title", "资料标题");
    title.input.required = true;
    title.input.minLength = 2;
    title.input.maxLength = 120;
    title.input.value = state.draft.title;
    title.input.addEventListener("input", (event) => { state.draft.title = event.currentTarget.value; });

    const pair = element("div", { className: "form-pair" });
    const categoryLabel = element("label", { attributes: { for: "document-category" } });
    categoryLabel.append(document.createTextNode("咨询方向"));
    const category = element("select", { id: "document-category" });
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
    date.input.addEventListener("input", (event) => { state.draft.updatedAt = event.currentTarget.value; });
    pair.append(categoryLabel, date.label);

    const url = labelledInput("document-url", "原始资料链接（可选）", "url");
    url.input.maxLength = 1500;
    url.input.value = state.draft.url;
    url.input.addEventListener("input", (event) => { state.draft.url = event.currentTarget.value; });

    const bodyLabel = element("label", { attributes: { for: "document-body" } });
    bodyLabel.append(document.createTextNode("供助手引用的正文"));
    const body = element("textarea", {
      id: "document-body",
      className: "admin-textarea",
      attributes: { required: true, minlength: "10", maxlength: "30000" },
    });
    body.value = state.draft.body;
    body.addEventListener("input", (event) => { state.draft.body = event.currentTarget.value; });
    bodyLabel.append(body);

    const fileLabel = element("label", { attributes: { for: "document-file" } });
    fileLabel.append(document.createTextNode("导入文本文件"));
    const fileInput = element("input", {
      id: "document-file",
      attributes: { type: "file", accept: ".txt,.md" },
    });
    fileInput.disabled = Boolean(state.busy);
    fileInput.addEventListener("change", async (event) => {
      const file = event.currentTarget.files?.[0];
      if (!file || state.busy) return;
      if (!/\.(txt|md)$/i.test(file.name)) {
        state.error = "当前版本支持 TXT、Markdown；PDF 或 Word 请先复制需要提交审核的正文。";
        renderAdminShell();
        return;
      }
      if (file.size > 120000) {
        state.error = "文件过大，请分成更短的资料条目。";
        renderAdminShell();
        return;
      }
      state.busy = "file";
      state.error = "";
      renderAdminShell();
      try {
        const text = await file.text();
        if (text.length > 30000) throw new Error("每条资料最多 30000 字");
        if (!state.draft.title) state.draft.title = file.name.replace(/\.(txt|md)$/i, "");
        state.draft.body = text;
        state.notice = "文本已导入，请核对后保存草稿。";
      } catch (error) {
        state.error = error instanceof Error ? error.message : "读取失败";
      } finally {
        state.busy = "";
        renderAdminShell();
      }
    });
    fileLabel.append(
      fileInput,
      element("span", {
        className: "small-note",
        text: "支持 TXT、Markdown。PDF 或 Word 可先复制需要提交审核的正文。",
      }),
    );

    const actions = element("div", { className: "admin-buttons" });
    const save = textButton(state.busy === "document" ? "正在保存…" : "保存资料", "primary-button");
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
        text: "此处仅保存待审核草稿；对外知识必须在 OA 审核为“公开”后由系统接入。",
      }),
      actions,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void runAdminAction("document", async () => {
        await adminRequest("documents", jsonOptions({
          ...(state.draft.id ? { id: state.draft.id } : {}),
          title: state.draft.title,
          body: state.draft.body,
          url: state.draft.url,
          category: state.draft.category,
          updatedAt: state.draft.updatedAt,
          published: 0,
        }));
        const payload = await adminRequest("documents");
        state.documents = Array.isArray(payload.documents) ? payload.documents : [];
        state.draft = emptyDraft();
        state.notice = "资料已保存为草稿，不会用于公开回答；请在 OA 中提交审核。";
      });
    });
    editor.append(form);

    const list = element("section", { className: "admin-card document-list" });
    list.append(
      element("p", { className: "eyebrow", text: "LOCAL DRAFTS" }),
      element("h2", { text: `资料列表 · ${state.documents.length}` }),
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
              text: `${TOPIC_LABELS[document.category] || "未分类"} · ${String(document.updatedAt || "未标注")} · 待 OA 审核 · ${adminSourceOriginLabel(document.origin)}`,
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
