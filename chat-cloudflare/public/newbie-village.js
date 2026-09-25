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

const LOCAL_GUEST_KEY = "originmind-newbie-guest-v1";
const GUEST_EMAIL = "guest@originmind.local";
const LOCAL_AGREEMENT = Object.freeze({
  version: "2026-09-25-v2",
  title: "OriginMind × ARTS Robotics 新手村保密协议",
  effectiveDate: "2026-09-25",
  introduction: "为保护实验室成员、合作方和项目资料，在进入新手村并接触学习任务前，请阅读并同意以下保密约定。",
  privacyNotice: "免登录访问模式下，签署记录暂存在本机浏览器；正式加入项目或领取权限时，实验室可要求补充实名信息并归档到 OA。",
  clauses: [
    {
      title: "一、保密信息范围",
      text: "保密信息包括通过新手村、实验室成员或项目协作接触到的未公开代码、数据、模型、设计、文档、实验记录、账号信息、会议内容，以及其他已标注或依其性质应当保密的信息。",
    },
    {
      title: "二、使用与保护义务",
      text: "保密信息仅可用于获准的新手村学习和实验室任务；未经书面许可，不得向无关人员披露、复制到非授权平台、公开发布或用于其他目的。应妥善保管账号和资料，发现误传、泄露或异常访问时应立即报告。",
    },
    {
      title: "三、不属于保密信息的情形",
      text: "能够证明在接收前已合法知悉、并非因违反本协议而公开、从有权披露的第三方合法取得、独立开发形成，或已取得实验室书面公开许可的信息，不受本协议限制。",
    },
    {
      title: "四、保密期限与资料处理",
      text: "保密义务自签署时起生效，持续至相关信息依法公开或实验室书面解除保密要求。任务结束、退出项目或收到要求时，应停止使用并按要求归还或删除相关资料。",
    },
    {
      title: "五、违规处理",
      text: "违反本协议可能导致新手村或项目权限暂停、任务资格取消，并应按适用规则和法律承担相应责任。涉及第三方权益或安全事件时，应配合采取补救措施。",
    },
  ],
});
const LOCAL_TASKS = Object.freeze([
  {
    id: "registration",
    index: 1,
    title: "入村登记",
    stage: "身份与方向",
    summary: "完善个人主页，确认学习方向和当前基础。",
    goal: "让导师和后续任务知道你是谁、想学什么，以及目前可以从哪里开始。",
    deliverables: ["完成个人主页", "选择兴趣方向", "写下本阶段学习目标"],
  },
  {
    id: "toolkit",
    index: 2,
    title: "装备铺",
    stage: "开发环境",
    summary: "准备 Git、VS Code、Python 与 Linux/WSL 环境。",
    goal: "建立一套能复现、能提交、能排查问题的个人开发环境。",
    deliverables: ["Git 版本截图", "Python 版本截图", "工作目录说明"],
  },
  {
    id: "git-basics",
    index: 3,
    title: "Git 训练场",
    stage: "协作基础",
    summary: "完成分支、提交、合并与 README 练习。",
    goal: "能独立维护一个小型仓库，并用清晰提交记录说明自己的工作。",
    deliverables: ["仓库链接", "至少 3 次有效提交", "README 复盘"],
  },
  {
    id: "python-basics",
    index: 4,
    title: "Python 训练场",
    stage: "编程基础",
    summary: "完成数据处理、函数拆分和基础测试任务。",
    goal: "用可读、可运行、可验证的代码解决一个小问题。",
    deliverables: ["源代码链接", "运行结果", "测试说明"],
  },
  {
    id: "ros2-simulation",
    index: 5,
    title: "ROS2 仿真场",
    stage: "机器人基础",
    summary: "运行 turtlesim，并完成 publisher/subscriber 练习。",
    goal: "理解节点、话题和消息如何组成一个最小机器人软件系统。",
    deliverables: ["节点图截图", "终端日志", "关键代码链接"],
  },
  {
    id: "mini-project",
    index: 6,
    title: "任务大厅",
    stage: "小型项目",
    summary: "从感知、导航、控制、机械或 AI 中完成一个小任务。",
    goal: "把工具和基础知识组合成一项可演示、可复盘的小成果。",
    deliverables: ["演示截图或视频链接", "代码链接", "问题与改进"],
  },
  {
    id: "graduation",
    index: 7,
    title: "出村考核",
    stage: "成果复盘",
    summary: "整理证据包和个人主页，形成可审核的阶段成果。",
    goal: "证明自己能完成任务、记录过程并清楚说明下一步方向。",
    deliverables: ["完整证据包", "个人复盘", "下一阶段计划"],
  },
]);

const state = {
  dashboard: null,
  localGuest: false,
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

function readLocalGuest() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_GUEST_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeLocalGuest(value) {
  localStorage.setItem(LOCAL_GUEST_KEY, JSON.stringify(value));
}

function localDashboard() {
  const saved = readLocalGuest();
  const now = Date.now();
  const agreementAccepted = Boolean(saved.agreement?.approved);
  const progressByTask = new Map(Object.entries(saved.tasks || {}));
  let previousCompleted = true;
  const tasks = LOCAL_TASKS.map((task) => {
    const progress = progressByTask.get(task.id) || {};
    const status = progress.status || "not_started";
    const result = {
      ...task,
      status,
      evidence: progress.evidence || "",
      updatedAt: progress.updatedAt || null,
      unlocked: previousCompleted,
    };
    previousCompleted = status === "completed";
    return result;
  });
  const profile = {
    displayName: saved.profile?.displayName || "访客学生",
    grade: saved.profile?.grade || "",
    major: saved.profile?.major || "",
    direction: saved.profile?.direction || "undecided",
    bio: saved.profile?.bio || "",
    updatedAt: saved.profile?.updatedAt || now,
  };
  return {
    user: {
      email: GUEST_EMAIL,
      role: "guest",
      roleLabel: "免登录访客",
    },
    agreement: {
      ...LOCAL_AGREEMENT,
      accepted: agreementAccepted,
      approved: agreementAccepted,
      reviewStatus: agreementAccepted ? "approved" : "unsigned",
      signerName: saved.agreement?.signerName || "",
      acceptedAt: saved.agreement?.acceptedAt || null,
      reviewNote: saved.agreement?.reviewNote || "",
    },
    profile: agreementAccepted ? profile : null,
    tasks: agreementAccepted ? tasks : [],
    progress: {
      completed: agreementAccepted ? tasks.filter((task) => task.status === "completed").length : 0,
      total: LOCAL_TASKS.length,
    },
  };
}

function enterLocalGuestMode(message) {
  state.localGuest = true;
  state.dashboard = localDashboard();
  renderDashboard();
  if (message) showToast(message);
}

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

function switchView(view, preserveHash = false) {
  const wasPasses = location.hash === "#passes";
  state.activeView = view === "profile" ? "profile" : "tasks";
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.activeView);
  });
  elements.tasksView.hidden = state.activeView !== "tasks";
  elements.profileView.hidden = state.activeView !== "profile";
  const nextHash = state.activeView === "profile" ? "#profile" : "#tasks";
  if (!preserveHash && location.hash !== nextHash) history.replaceState(null, "", nextHash);
  if (wasPasses && !preserveHash) {
    requestAnimationFrame(() => document.querySelector(".content")?.scrollIntoView({ block: "start" }));
  }
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
    elements.agreementReview.querySelector("h2").textContent = pending ? "签署记录正在自动归档" : "本次签署未完成归档";
    elements.agreementReview.querySelector(".review-summary").textContent =
      `签署人：${agreement.signerName} · 签署时间：${formatTime(agreement.acceptedAt)}`;
    elements.agreementReview.querySelector(".review-note").textContent = rejected
      ? `审核说明：${agreement.reviewNote || "请核对签署信息后重新提交。"}`
      : "归档完成后，任务地图和个人主页会自动开放。";
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
  const showPasses = location.hash === "#passes";
  switchView(state.activeView, showPasses);
  if (showPasses) requestAnimationFrame(() => document.getElementById("passes")?.scrollIntoView({ block: "start" }));
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
    state.localGuest = false;
    renderDashboard();
  } catch (error) {
    enterLocalGuestMode(error.status === 401 || error.status === 404
      ? "已开启免登录访问"
      : "接口暂不可用，已进入免登录模式");
  }
}

function openLogin() {
  enterLocalGuestMode("已进入免登录新手村");
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
  setLoginStatus("正在登录…");
  try {
    await requestJson("/api/visitor/login", {
      method: "POST",
      body: JSON.stringify({
        account: elements.email.value.trim(),
        password: elements.code.value.trim(),
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
  const form = new FormData(elements.profileForm);
  const profile = {
    displayName: String(form.get("displayName") || ""),
    grade: String(form.get("grade") || ""),
    major: String(form.get("major") || ""),
    direction: String(form.get("direction") || "undecided"),
    bio: String(form.get("bio") || ""),
    updatedAt: Date.now(),
  };
  try {
    if (state.localGuest) throw new Error("LOCAL_GUEST");
    state.dashboard = await requestJson("/api/newbie/profile", { method: "PATCH", body: JSON.stringify(profile) });
  } catch (error) {
    const saved = readLocalGuest();
    writeLocalGuest({ ...saved, profile });
    state.localGuest = true;
    state.dashboard = localDashboard();
    if (error.message !== "LOCAL_GUEST") console.info("Falling back to local guest profile save.", error);
  } finally {
    renderDashboard();
    elements.profileStatus.textContent = "已保存";
    showToast("个人主页已更新");
    submit.disabled = false;
  }
}

async function signAgreement(event) {
  event.preventDefault();
  const submit = elements.agreementForm.querySelector('button[type="submit"]');
  const signerName = String(new FormData(elements.agreementForm).get("signerName") || "").trim();
  submit.disabled = true;
  elements.agreementStatus.textContent = "正在自动归档…";
  try {
    if (state.localGuest) throw new Error("LOCAL_GUEST");
    state.dashboard = await requestJson("/api/newbie/agreement", {
      method: "POST",
      body: JSON.stringify({
        agreementVersion: state.dashboard.agreement.version,
        signerName,
        accepted: true,
      }),
    });
  } catch (error) {
    const saved = readLocalGuest();
    writeLocalGuest({
      ...saved,
      agreement: {
        approved: true,
        signerName: signerName || saved.profile?.displayName || "访客学生",
        acceptedAt: Date.now(),
        reviewNote: "免登录模式本地签署",
      },
    });
    state.localGuest = true;
    state.dashboard = localDashboard();
    if (error.message !== "LOCAL_GUEST") console.info("Falling back to local guest agreement save.", error);
  } finally {
    renderDashboard();
    showToast("已签署并进入新手村");
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
    if (state.localGuest) throw new Error("LOCAL_GUEST");
    state.dashboard = await requestJson(`/api/newbie/tasks/${encodeURIComponent(task.id)}`, {
      method: "POST",
      body: JSON.stringify({ status, evidence: elements.taskEvidence.value.trim() }),
    });
  } catch (error) {
    const saved = readLocalGuest();
    writeLocalGuest({
      ...saved,
      tasks: {
        ...(saved.tasks || {}),
        [task.id]: {
          status,
          evidence: elements.taskEvidence.value.trim(),
          updatedAt: Date.now(),
        },
      },
    });
    state.localGuest = true;
    state.dashboard = localDashboard();
    if (error.message !== "LOCAL_GUEST") console.info("Falling back to local guest task save.", error);
  } finally {
    renderDashboard();
    elements.taskDialog.close();
    showToast(status === "completed" ? "任务已完成，下一关已解锁" : "任务已开始");
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function logout() {
  elements.logout.disabled = true;
  try {
    if (!state.localGuest) await requestJson("/api/visitor/logout", { method: "POST", body: "{}" });
  } catch { /* Local state still returns to the signed-out view. */ }
  elements.logout.disabled = false;
  localStorage.removeItem(LOCAL_GUEST_KEY);
  enterLocalGuestMode("已重置免登录进度");
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
window.addEventListener("hashchange", () => {
  if (location.hash === "#passes") return;
  switchView(location.hash === "#profile" ? "profile" : "tasks");
});

void loadDashboard();

