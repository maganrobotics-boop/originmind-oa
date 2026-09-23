"use strict";

const directionLabels = Object.freeze({
  undecided: "待选择",
  perception: "感知",
  navigation: "导航",
  control: "控制",
  mechanics: "机械",
  ai: "AI",
});

const statusLabels = Object.freeze({
  not_started: "未开始",
  in_progress: "进行中",
  completed: "已完成",
});

const state = {
  dashboard: null,
  currentTaskId: "",
  activeView: location.hash === "#profile" ? "profile" : "tasks",
};

const elements = {
  loggedOut: document.querySelector(".logged-out"),
  agreementGate: document.querySelector(".agreement-gate"),
  agreementForm: document.querySelector(".agreement-form"),
  agreementStatus: document.querySelector(".agreement-status"),
  agreementReview: document.querySelector(".agreement-review"),
  dashboard: document.querySelector(".dashboard"),
  tasksView: document.querySelector(".tasks-view"),
  profileView: document.querySelector(".profile-view"),
  taskGrid: document.querySelector(".task-grid"),
  userChip: document.querySelector(".user-chip"),
  logout: document.querySelector(".logout-trigger"),
  loginDialog: document.querySelector(".login-dialog"),
  loginForm: document.querySelector(".login-form"),
  email: document.querySelector(".email-input"),
  code: document.querySelector(".code-input"),
  codeButton: document.querySelector(".code-button"),
  loginStatus: document.querySelector(".login-status"),
  profileForm: document.querySelector(".profile-form"),
  profileStatus: document.querySelector(".form-status"),
  taskDialog: document.querySelector(".task-dialog"),
  taskEvidence: document.querySelector(".task-evidence"),
  taskStatus: document.querySelector(".task-status"),
  toast: document.querySelector(".toast"),
};
let toastTimer;

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "服务暂时不可用，请稍后重试。");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2200);
}

function setLoginStatus(message, error = false) {
  elements.loginStatus.textContent = message || "";
  elements.loginStatus.style.color = error ? "#b42318" : "#68707c";
}

function setTaskStatus(message, error = false) {
  elements.taskStatus.textContent = message || "";
  elements.taskStatus.style.color = error ? "#b42318" : "#68707c";
}

function switchView(view) {
  state.activeView = view === "profile" ? "profile" : "tasks";
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.activeView);
  });
  elements.tasksView.hidden = state.activeView !== "tasks";
  elements.profileView.hidden = state.activeView !== "profile";
  const nextHash = state.activeView === "profile" ? "#profile" : "#tasks";
  if (location.hash !== nextHash) history.replaceState(null, "", nextHash);
}

function statusClass(status) {
  return status === "in_progress" ? "in-progress" : status === "completed" ? "completed" : "";
}

function createTaskCard(task) {
  const article = document.createElement("article");
  article.className = `task-card${task.unlocked ? "" : " locked"}`;
  const top = document.createElement("div");
  top.className = "task-top";
  const index = document.createElement("span");
  index.className = "task-index";
  index.textContent = String(task.index);
  const status = document.createElement("span");
  status.className = `status ${statusClass(task.status)}`;
  status.textContent = task.unlocked ? statusLabels[task.status] : "未解锁";
  top.append(index, status);
  const title = document.createElement("h3");
  title.textContent = task.title;
  const stage = document.createElement("span");
  stage.className = "task-stage";
  stage.textContent = task.stage;
  const summary = document.createElement("p");
  summary.textContent = task.summary;
  const open = document.createElement("button");
  open.className = "secondary task-open";
  open.type = "button";
  open.disabled = !task.unlocked;
  open.textContent = task.unlocked ? "查看任务" : "先完成上一关";
  open.addEventListener("click", () => openTask(task.id));
  article.append(top, title, stage, summary, open);
  return article;
}

function fillProfile(profile) {
  for (const name of ["displayName", "grade", "major", "direction", "bio"]) {
    const field = elements.profileForm.elements.namedItem(name);
    if (field) field.value = profile[name] || (name === "direction" ? "undecided" : "");
  }
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function renderAgreement() {
  const data = state.dashboard;
  const agreement = data?.agreement;
  if (!agreement) return;
  elements.loggedOut.hidden = true;
  elements.dashboard.hidden = true;
  elements.agreementGate.hidden = false;
  elements.userChip.hidden = false;
  elements.logout.hidden = false;
  document.querySelectorAll(".login-trigger").forEach((button) => { button.hidden = true; });
  document.querySelectorAll(".nav-button").forEach((button) => { button.disabled = true; });
  elements.userChip.textContent = `${data.user.roleLabel} · ${data.user.email}`;
  document.querySelector(".agreement-version").textContent = `版本 ${agreement.version}`;
  document.querySelector(".agreement-effective").textContent = `生效日期 ${agreement.effectiveDate}`;
  document.querySelector(".agreement-email").textContent = `签署账号 ${data.user.email}`;
  document.querySelector(".agreement-introduction").textContent = agreement.introduction;
  document.querySelector(".privacy-notice").textContent = agreement.privacyNotice;
  document.querySelector(".agreement-clauses").replaceChildren(...agreement.clauses.map((clause) => {
    const section = document.createElement("section");
    section.className = "agreement-clause";
    const title = document.createElement("h2");
    title.textContent = clause.title;
    const text = document.createElement("p");
    text.textContent = clause.text;
    section.append(title, text);
    return section;
  }));
  const pending = agreement.reviewStatus === "pending";
  const rejected = agreement.reviewStatus === "rejected";
  elements.agreementForm.hidden = pending;
  elements.agreementReview.hidden = !pending && !rejected;
  elements.agreementReview.className = `agreement-review${pending ? " pending" : rejected ? " rejected" : ""}`;
  if (pending || rejected) {
    elements.agreementReview.querySelector("h2").textContent = pending ? "签署记录已归档，等待管理员审核" : "本次签署未通过审核";
    elements.agreementReview.querySelector(".review-summary").textContent =
      `签署人：${agreement.signerName} · 签署时间：${formatTime(agreement.acceptedAt)}`;
    elements.agreementReview.querySelector(".review-note").textContent = rejected
      ? `审核说明：${agreement.reviewNote || "请核对签署信息后重新提交。"}`
      : "审核通过后，任务地图和个人主页会自动开放。";
  }
  if (rejected) {
    const signer = elements.agreementForm.elements.namedItem("signerName");
    if (signer && !signer.value) signer.value = agreement.signerName;
  }
}

function renderDashboard() {
  const data = state.dashboard;
  if (!data) return;
  if (!data.agreement?.approved) {
    renderAgreement();
    return;
  }
  elements.loggedOut.hidden = true;
  elements.agreementGate.hidden = true;
  elements.dashboard.hidden = false;
  elements.userChip.hidden = false;
  elements.logout.hidden = false;
  document.querySelectorAll(".login-trigger").forEach((button) => { button.hidden = true; });
  document.querySelectorAll(".nav-button").forEach((button) => { button.disabled = false; });
  elements.userChip.textContent = `${data.user.roleLabel} · ${data.user.email}`;

  document.querySelector(".progress-number").textContent = String(data.progress.completed);
  document.querySelector(".progress-total").textContent = String(data.progress.total);
  document.querySelector(".progress-bar").style.width = `${data.progress.total ? data.progress.completed / data.progress.total * 100 : 0}%`;
  document.querySelector(".metric-role").textContent = data.user.roleLabel;
  document.querySelector(".metric-direction").textContent = directionLabels[data.profile.direction] || "待选择";
  const nextTask = data.tasks.find((task) => task.status !== "completed" && task.unlocked);
  document.querySelector(".metric-next").textContent = nextTask?.title || "全部完成";

  elements.taskGrid.replaceChildren(...data.tasks.map(createTaskCard));
  fillProfile(data.profile);
  const displayName = data.profile.displayName || data.user.email.split("@", 1)[0];
  document.querySelector(".profile-name").textContent = displayName;
  document.querySelector(".profile-email").textContent = data.user.email;
  document.querySelector(".profile-role").textContent = data.user.roleLabel;
  document.querySelector(".profile-progress").textContent = `已完成 ${data.progress.completed}/${data.progress.total}`;
  document.querySelector(".avatar").textContent = displayName.slice(0, 1).toUpperCase() || "新";
  switchView(state.activeView);
}

function renderLoggedOut() {
  state.dashboard = null;
  elements.loggedOut.hidden = false;
  elements.agreementGate.hidden = true;
  elements.dashboard.hidden = true;
  elements.userChip.hidden = true;
  elements.logout.hidden = true;
  document.querySelectorAll(".login-trigger").forEach((button) => { button.hidden = false; });
  document.querySelectorAll(".nav-button").forEach((button) => { button.disabled = true; });
}

async function loadDashboard() {
  try {
    state.dashboard = await requestJson("/api/newbie/dashboard", { cache: "no-store" });
    renderDashboard();
  } catch (error) {
    if (error.status === 401) {
      renderLoggedOut();
      return;
    }
    renderLoggedOut();
    showToast(error.message);
  }
}

function openLogin() {
  setLoginStatus("");
  elements.loginDialog.showModal();
  elements.email.focus();
}

async function requestCode() {
  const email = elements.email.value.trim();
  elements.codeButton.disabled = true;
  setLoginStatus("正在发送验证码…");
  try {
    const result = await requestJson("/api/visitor/request-code", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    setLoginStatus(result.devCode ? `预览验证码：${result.devCode}` : "验证码已发送，请检查邮箱。");
    elements.code.focus();
  } catch (error) {
    setLoginStatus(error.message, true);
  } finally {
    elements.codeButton.disabled = false;
  }
}

async function verifyCode(event) {
  event.preventDefault();
  const button = document.querySelector(".verify-button");
  button.disabled = true;
  setLoginStatus("正在验证…");
  try {
    await requestJson("/api/visitor/verify-code", {
      method: "POST",
      body: JSON.stringify({
        email: elements.email.value.trim(),
        code: elements.code.value.trim(),
      }),
    });
    elements.loginDialog.close();
    elements.loginForm.reset();
    await loadDashboard();
    showToast("登录成功，欢迎来到新手村");
  } catch (error) {
    setLoginStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function saveProfile(event) {
  event.preventDefault();
  const submit = elements.profileForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  elements.profileStatus.textContent = "正在保存…";
  try {
    const form = new FormData(elements.profileForm);
    state.dashboard = await requestJson("/api/newbie/profile", {
      method: "PATCH",
      body: JSON.stringify({
        displayName: String(form.get("displayName") || ""),
        grade: String(form.get("grade") || ""),
        major: String(form.get("major") || ""),
        direction: String(form.get("direction") || "undecided"),
        bio: String(form.get("bio") || ""),
      }),
    });
    renderDashboard();
    elements.profileStatus.textContent = "已保存";
    showToast("个人主页已更新");
  } catch (error) {
    elements.profileStatus.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

async function signAgreement(event) {
  event.preventDefault();
  const submit = elements.agreementForm.querySelector('button[type="submit"]');
  const signerName = String(new FormData(elements.agreementForm).get("signerName") || "").trim();
  submit.disabled = true;
  elements.agreementStatus.textContent = "正在归档签署记录…";
  try {
    state.dashboard = await requestJson("/api/newbie/agreement", {
      method: "POST",
      body: JSON.stringify({
        agreementVersion: state.dashboard.agreement.version,
        signerName,
        accepted: true,
      }),
    });
    renderDashboard();
    showToast("已签署并归档，等待管理员审核");
  } catch (error) {
    elements.agreementStatus.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

function openTask(id) {
  const task = state.dashboard?.tasks.find((candidate) => candidate.id === id);
  if (!task || !task.unlocked) return;
  state.currentTaskId = id;
  document.querySelector(".task-stage-dialog").textContent = `第 ${task.index} 关 · ${task.stage}`;
  document.querySelector(".task-title-dialog").textContent = task.title;
  document.querySelector(".task-summary-dialog").textContent = task.summary;
  document.querySelector(".task-goal").textContent = task.goal;
  const list = document.querySelector(".task-deliverables");
  list.replaceChildren(...task.deliverables.map((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    return li;
  }));
  elements.taskEvidence.value = task.evidence || "";
  document.querySelector(".task-start").hidden = task.status !== "not_started";
  document.querySelector(".task-complete").textContent = task.status === "completed" ? "更新证据" : "提交完成";
  setTaskStatus(task.status === "completed" ? "这个任务已经完成，你仍可以更新证据和复盘。" : "");
  elements.taskDialog.showModal();
}

async function updateTask(status) {
  const task = state.dashboard?.tasks.find((candidate) => candidate.id === state.currentTaskId);
  if (!task) return;
  const buttons = elements.taskDialog.querySelectorAll("button");
  buttons.forEach((button) => { button.disabled = true; });
  setTaskStatus(status === "completed" ? "正在保存完成记录…" : "正在开始任务…");
  try {
    state.dashboard = await requestJson(`/api/newbie/tasks/${encodeURIComponent(task.id)}`, {
      method: "POST",
      body: JSON.stringify({ status, evidence: elements.taskEvidence.value.trim() }),
    });
    renderDashboard();
    elements.taskDialog.close();
    showToast(status === "completed" ? "任务已完成，下一关已解锁" : "任务已开始");
  } catch (error) {
    setTaskStatus(error.message, true);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function logout() {
  elements.logout.disabled = true;
  try {
    await requestJson("/api/visitor/logout", { method: "POST", body: "{}" });
  } catch { /* Local state still returns to the signed-out view. */ }
  elements.logout.disabled = false;
  renderLoggedOut();
  showToast("已退出新手村");
}

document.querySelectorAll(".login-trigger").forEach((button) => button.addEventListener("click", openLogin));
document.querySelector(".login-close").addEventListener("click", () => elements.loginDialog.close());
elements.codeButton.addEventListener("click", () => void requestCode());
elements.loginForm.addEventListener("submit", (event) => void verifyCode(event));
elements.profileForm.addEventListener("submit", (event) => void saveProfile(event));
elements.agreementForm.addEventListener("submit", (event) => void signAgreement(event));
elements.logout.addEventListener("click", () => void logout());
document.querySelectorAll(".nav-button").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
document.querySelector(".task-close").addEventListener("click", () => elements.taskDialog.close());
document.querySelector(".task-start").addEventListener("click", () => void updateTask("in_progress"));
document.querySelector(".task-complete").addEventListener("click", () => void updateTask("completed"));
window.addEventListener("hashchange", () => switchView(location.hash === "#profile" ? "profile" : "tasks"));

void loadDashboard();

