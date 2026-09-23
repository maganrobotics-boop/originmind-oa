"use strict";

const state = { records: [], selected: null };
const elements = {
  loginPanel: document.querySelector(".login-panel"),
  loginForm: document.querySelector(".login-form"),
  loginStatus: document.querySelector(".login-status"),
  app: document.querySelector(".admin-app"),
  logout: document.querySelector(".logout"),
  filter: document.querySelector(".status-filter"),
  records: document.querySelector(".records"),
  listStatus: document.querySelector(".list-status"),
  dialog: document.querySelector(".review-dialog"),
  reviewStatus: document.querySelector(".review-status"),
};

const statusLabels = { pending: "待审核", approved: "已通过", rejected: "已驳回" };

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "请求失败，请稍后重试。");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value));
}

function showLogin(message = "") {
  elements.loginPanel.hidden = false;
  elements.app.hidden = true;
  elements.logout.hidden = true;
  elements.loginStatus.textContent = message;
}

function showApp() {
  elements.loginPanel.hidden = true;
  elements.app.hidden = false;
  elements.logout.hidden = false;
}

function detail(label, value) {
  const box = document.createElement("div");
  const caption = document.createElement("span");
  const content = document.createElement("strong");
  caption.textContent = label;
  content.textContent = value;
  box.append(caption, content);
  return box;
}

function reviewButton(label, className, record) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", () => openReview(record));
  return button;
}

function recordCard(record) {
  const article = document.createElement("article");
  article.className = "record";
  const head = document.createElement("div");
  head.className = "record-head";
  const identity = document.createElement("div");
  const name = document.createElement("h2");
  const email = document.createElement("div");
  name.textContent = record.signerName;
  email.className = "record-email";
  email.textContent = record.email;
  identity.append(name, email);
  const tag = document.createElement("span");
  tag.className = `tag ${record.reviewStatus}`;
  tag.textContent = statusLabels[record.reviewStatus] || record.reviewStatus;
  head.append(identity, tag);
  const meta = document.createElement("div");
  meta.className = "record-meta";
  meta.append(
    detail("协议版本", record.agreementVersion),
    detail("签署时间", formatTime(record.acceptedAt)),
    detail("内容摘要", record.contentSha256),
  );
  const actions = document.createElement("div");
  actions.className = "record-actions";
  if (record.reviewStatus === "pending") {
    actions.append(reviewButton("审核", "primary", record));
  }
  article.append(head, meta);
  if (record.reviewNote) {
    const note = document.createElement("p");
    note.textContent = `审核备注：${record.reviewNote}`;
    article.append(note);
  }
  if (record.reviewStatus === "pending") article.append(actions);
  return article;
}

function renderRecords() {
  if (!state.records.length) {
    const empty = document.createElement("div");
    empty.className = "panel empty";
    empty.textContent = "当前没有符合条件的签署记录。";
    elements.records.replaceChildren(empty);
    return;
  }
  elements.records.replaceChildren(...state.records.map(recordCard));
}

async function loadRecords() {
  elements.listStatus.textContent = "正在读取内部归档…";
  try {
    const data = await requestJson(`/api/admin/newbie-agreements?status=${encodeURIComponent(elements.filter.value)}`, { cache: "no-store" });
    state.records = data.records || [];
    renderRecords();
    elements.listStatus.textContent = `共 ${state.records.length} 条记录`;
  } catch (error) {
    if (error.status === 403 || error.status === 401) {
      showLogin("管理会话已失效，请重新登录。");
      return;
    }
    elements.listStatus.textContent = error.message;
  }
}

function openReview(record) {
  state.selected = record;
  document.querySelector(".review-person").textContent = `${record.signerName} · ${record.email} · ${record.agreementVersion}`;
  elements.dialog.querySelector('[name="reviewNote"]').value = record.reviewNote || "";
  elements.reviewStatus.textContent = "";
  elements.dialog.showModal();
}

async function review(reviewStatus) {
  if (!state.selected) return;
  const reviewNote = elements.dialog.querySelector('[name="reviewNote"]').value.trim();
  elements.dialog.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  elements.reviewStatus.textContent = reviewStatus === "approved" ? "正在通过…" : "正在驳回…";
  try {
    await requestJson("/api/admin/newbie-agreements/review", {
      method: "POST",
      body: JSON.stringify({
        email: state.selected.email,
        agreementVersion: state.selected.agreementVersion,
        reviewStatus,
        reviewNote,
      }),
    });
    elements.dialog.close();
    await loadRecords();
  } catch (error) {
    elements.reviewStatus.textContent = error.message;
  } finally {
    elements.dialog.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = elements.loginForm.querySelector("button");
  button.disabled = true;
  elements.loginStatus.textContent = "正在登录…";
  try {
    const form = new FormData(elements.loginForm);
    await requestJson("/api/auth/login", { method: "POST", body: JSON.stringify({ password: String(form.get("password") || "") }) });
    elements.loginForm.reset();
    showApp();
    await loadRecords();
  } catch (error) {
    elements.loginStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
elements.filter.addEventListener("change", () => void loadRecords());
document.querySelector(".refresh").addEventListener("click", () => void loadRecords());
elements.logout.addEventListener("click", async () => {
  await requestJson("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
  showLogin("已退出管理端。");
});
elements.dialog.querySelector(".close").addEventListener("click", () => elements.dialog.close());
elements.dialog.querySelector(".approve").addEventListener("click", () => void review("approved"));
elements.dialog.querySelector(".reject").addEventListener("click", () => void review("rejected"));

requestJson("/api/auth/status", { cache: "no-store" })
  .then((result) => result.signedIn ? (showApp(), loadRecords()) : showLogin())
  .catch(() => showLogin("无法读取管理状态，请刷新重试。"));

