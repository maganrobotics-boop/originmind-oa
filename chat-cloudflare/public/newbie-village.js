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
const PYTHON_LESSON = "/assets/newbie-python-v1/index.html";
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
    summary: "完成个人信息、基础情况和学习方向登记。",
    goal: "让导师和助教知道你是谁、每周能投入多少时间、已经会什么、想从哪个方向开始。",
    steps: [
      "填写姓名、年级、专业和联系方式。",
      "记录每周可投入时间，例如每周 4 小时、8 小时或更多。",
      "勾选已有基础：C/C++、Python、机械设计、电子电路、Linux、ROS、AI 等。",
      "选择一个初始方向：感知、导航、控制、机械、嵌入式、AI 应用；不确定可以选“待选择”。",
    ],
    examples: [
      "机械专业同学可以先选机械结构、测试记录或机器人装配相关任务。",
      "计算机/自动化同学可以先选 Python、ROS2、导航或感知小任务。",
      "基础较弱也可以参加，先从资料整理、复现实验和日志记录开始。",
    ],
    taPrompts: [
      "我适合哪个项目方向？",
      "我每周只有 4 小时，可以从什么任务开始？",
      "我现在基础比较弱，应该先补什么？",
    ],
    deliverables: ["个人主页信息完整", "选择或说明兴趣方向", "写下本阶段学习目标和每周可投入时间"],
  },
  {
    id: "toolkit",
    index: 2,
    title: "装备铺",
    stage: "开发环境",
    summary: "准备 Git、VS Code、Python 与 Linux/WSL，建立可复现的开发环境。",
    goal: "让每个学生都有一套能写代码、跑命令、提交记录和排查问题的基本工具。",
    steps: [
      "安装 VS Code，并确认能打开项目文件夹。",
      "安装 Git，运行 git --version，理解 commit 是学习证据的一部分。",
      "安装 Python 3，运行 python --version 或 python3 --version。",
      "Windows 用户安装 WSL/Ubuntu；Mac/Linux 用户确认能打开终端。",
      "建立一个固定学习目录，例如 robotics-newbie，并把截图和代码都放进去。",
    ],
    examples: [
      "终端能运行 git --version，说明 Git 基本可用。",
      "终端能运行 python -V，说明 Python 基本可用。",
      "如果装不上 ROS2，不影响先完成 Git 和 Python 两关。",
    ],
    taPrompts: [
      "Windows 怎么安装 WSL？",
      "git --version 找不到怎么办？",
      "我应该怎么整理学习目录？",
    ],
    deliverables: ["Git 版本截图", "Python 版本截图", "个人学习目录结构截图或说明"],
  },
  {
    id: "git-basics",
    index: 3,
    title: "Git 训练场",
    stage: "协作基础",
    summary: "用一个小仓库练习 add、commit、branch、merge 和 README。",
    goal: "能独立维护一个小型仓库，用清晰提交记录说明自己做过什么。",
    steps: [
      "新建一个仓库 robotics-newbie-log。",
      "写 README.md：介绍自己、方向兴趣、第一周计划。",
      "提交至少 3 次 commit：初始化、补充方向、补充学习记录。",
      "创建一个 practice 分支，修改 README 后合并回 main。",
      "在 README 里写 100 字复盘：Git 最容易混淆的地方是什么。",
    ],
    examples: [
      "常用命令：git status、git add .、git commit -m \"message\"、git log --oneline。",
      "好的提交信息应该能看懂，例如 add python setup note，而不是 update。",
      "不会公开仓库时，可以先提交截图，后续再统一规范 GitHub/Gitee。",
    ],
    taPrompts: [
      "git add 和 git commit 有什么区别？",
      "我提交错了怎么办？",
      "README 应该怎么写？",
    ],
    deliverables: ["仓库链接或本地提交截图", "至少 3 次有效提交", "README 复盘"],
  },
  {
    id: "python-basics",
    index: 4,
    title: "Python 训练场",
    stage: "编程基础",
    summary: "用模拟巡检日志计算路程、速率和电量变化；含完整教程、数据、代码模板与自检。",
    goal: "在 60–90 分钟内完成一次可复现的日志分析，能区分路程和位移，定位可疑区间并解释结果。",
    steps: [
      "打开完整实训，下载并解压材料包；仅需 Python 3，无第三方依赖。",
      "运行 analyze.py 和参考自检，核对 21 个采样点、10 m 路程、0.5 m/s 平均速率。",
      "学习相邻点距离、时间间隔和电量百分点，完成 exercise.py 的三个 TODO。",
      "运行 python check_work.py 检查自己的实现，再分析 position_jump.csv 中的 1–2 s 位置跳变。",
      "构造一份静止、斜线或非等间隔数据，先手算再运行，填写提交单。",
    ],
    examples: [
      "本课数据均为教学模拟，不是真实实验记录。完整教材含命令、标准输出和报错排查。",
      "正方形路径回到起点，位移为 0 m，累计路程仍为 10 m；电量从 90% 到 85% 是下降 5 个百分点。",
      "运行参考程序不等于完成个人练习；本机标记和八项自检也不等于教师审核通过。",
    ],
    taPrompts: [
      "我在 Python 日志关，为什么位移为 0，路程仍为 10 m？",
      "非等间隔采样测试得到 0.667 而不是 0.5，请提示我检查计算过程。",
      "1–2 s 的可疑分段显示 10 m/s，还需要哪些证据才能判断原因？",
    ],
    deliverables: ["独立完成的 exercise.py、运行命令和八项自检输出", "正常与异常日志的分析结果；标准指标误差不超过 0.001", "一份自建数据及手算值与运行值对照", "填写 submission.md，解释四个问题并记录复盘与助教帮助"],
  },
  {
    id: "ros2-simulation",
    index: 5,
    title: "ROS2 仿真场",
    stage: "机器人基础",
    summary: "用 turtlesim 理解 ROS2 节点、话题、消息和发布订阅。",
    goal: "理解一个最小机器人软件系统如何由节点、话题和消息组成。",
    steps: [
      "安装或使用已有 ROS2 环境，能运行 ros2 --help。",
      "启动 turtlesim_node，并用 teleop 控制小海龟移动。",
      "运行 ros2 topic list、ros2 topic echo、ros2 node list，观察系统结构。",
      "写一个 publisher，让小海龟自动走直线或转圈。",
      "写一个 subscriber，读取 pose 并输出当前位置。",
    ],
    examples: [
      "turtlesim 不是玩具，它对应真实机器人里的运动命令和状态反馈。",
      "cmd_vel 可以理解为给机器人发速度命令。",
      "pose 可以理解为机器人反馈自己的位置和朝向。",
    ],
    taPrompts: [
      "ROS2 节点、话题、消息分别是什么？",
      "turtlesim 跑不起来怎么排查？",
      "publisher/subscriber 最小代码怎么写？",
    ],
    deliverables: ["节点/话题截图", "终端日志", "publisher 或 subscriber 关键代码"],
  },
  {
    id: "mini-project",
    index: 6,
    title: "任务大厅",
    stage: "小型项目",
    summary: "从感知、导航、控制、机械或 AI 中选择一个可交付小任务。",
    goal: "把工具和基础知识组合成一项可演示、可复盘的小成果。",
    steps: [
      "从小任务池选择一个方向，不确定时先问助教。",
      "写清楚任务目标、输入、输出和验收标准。",
      "完成一个最小可演示版本，不追求大而全。",
      "记录遇到的问题、排查过程和下一步改进。",
    ],
    examples: [
      "感知：用一组图片做目标标注，整理常见误检案例。",
      "导航：画一个简化地图，说明机器人从 A 到 B 的路径和障碍物。",
      "控制：解释一个速度曲线，说明加速度过大为什么会抖。",
      "机械：调研一个机器人底盘或夹爪结构，画出关键受力/运动关系。",
      "AI：把一份实验记录整理成结构化摘要，并设计 5 个问答样例。",
    ],
    taPrompts: [
      "根据我的专业，推荐一个一周能完成的小任务。",
      "帮我把这个任务拆成目标、输入、输出、验收标准。",
      "什么成果才算能在机器人上用？",
    ],
    deliverables: ["演示截图或视频链接", "代码/文档/设计文件链接", "问题与改进复盘"],
  },
  {
    id: "graduation",
    index: 7,
    title: "出村考核",
    stage: "成果复盘",
    summary: "整理证据包和个人主页，形成可审核的阶段成果。",
    goal: "证明自己能完成任务、记录过程，并清楚说明下一步适合进入哪个项目方向。",
    steps: [
      "整理所有关卡证据：截图、代码、日志、README、复盘。",
      "更新个人主页：方向、技能、已完成任务和希望参与项目。",
      "写一页复盘：学到了什么、卡在哪里、下一步想做什么。",
      "向导师或助教提交证据包，等待进入正式项目任务。",
    ],
    examples: [
      "好的证据包不是堆文件，而是能让别人快速判断你做了什么。",
      "复盘要写具体问题，例如 ROS2 环境变量、Git 分支冲突、Python 数据读取错误。",
      "下一阶段可以申请加入矿区巡检、四足机器人、AI 助教、机械结构等方向。",
    ],
    taPrompts: [
      "帮我检查证据包是否完整。",
      "我的复盘怎么写更清楚？",
      "我下一阶段适合进哪个项目组？",
    ],
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
  try {
    localStorage.setItem(LOCAL_GUEST_KEY, JSON.stringify(value));
    return true;
  } catch {
    showToast("浏览器无法保存，请允许网站存储后重试。当前记录未保存。");
    return false;
  }
}

function localDashboard() {
  const saved = readLocalGuest();
  const now = Date.now();
  const agreementAccepted = Boolean(saved.agreement?.approved);
  const progressByTask = new Map(Object.entries(saved.tasks || {}));
  const tasks = LOCAL_TASKS.map((task) => {
    const progress = progressByTask.get(task.id) || {};
    const status = progress.status || "not_started";
    const result = {
      ...task,
      status,
      evidence: progress.evidence || "",
      updatedAt: progress.updatedAt || null,
      unlocked: true,
    };
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
    profile,
    tasks,
    progress: {
      completed: tasks.filter((task) => task.status === "completed").length,
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
  open.textContent = "查看课程与任务";
  open.addEventListener("click", () => openTask(task.id));
  article.append(top, title, stage, summary, open);
  if (task.id === "python-basics") {
    const lesson = document.createElement("a");
    lesson.href = PYTHON_LESSON;
    lesson.className = "lesson-link";
    lesson.textContent = "完整实训与材料下载";
    article.append(lesson);
  }
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
  // Public course content is independent of account and agreement status.
  const publicData = localDashboard();
  data.profile ||= publicData.profile;
  data.tasks = LOCAL_TASKS.map((course) => {
    const progress = (data.tasks || []).find((task) => task.id === course.id);
    return { ...course, status: progress?.status || "not_started", unlocked: Boolean(progress?.unlocked),
      evidence: progress?.evidence || "", updatedAt: progress?.updatedAt || null };
  });
  elements.loggedOut.hidden = true;
  elements.agreementGate.hidden = true;
  elements.dashboard.hidden = false;
  elements.userChip.hidden = false;
  elements.logout.hidden = state.localGuest;
  document.querySelectorAll(".login-trigger").forEach((button) => { button.hidden = !state.localGuest; });
  document.querySelector(".sync-progress").hidden = state.localGuest;
  document.querySelector(".storage-note").textContent = state.localGuest
    ? "学习进度仅保存在当前浏览器。换设备或清除浏览器数据后无法找回；正式提交需登录。"
    : "已登录。可同步本机学习记录；正式提交仍需完成协议归档和前置任务。";
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
  const requestedTask = data.tasks.find((task) => location.hash === `#${task.id}`);
  switchView(state.activeView, showPasses || Boolean(requestedTask));
  if (requestedTask && !elements.taskDialog.open) openTask(requestedTask.id);
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
    return true;
  } catch (error) {
    enterLocalGuestMode(error.status === 401 || error.status === 404
      ? "已开启免登录访问"
      : "接口暂不可用，已进入免登录模式");
    return false;
  }
}

function openLogin() {
  elements.taskDialog.close();
  setLoginStatus("登录用于同步进度和正式提交；关闭后可继续免登录学习。");
  elements.loginDialog.showModal();
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
    if (await loadDashboard()) showToast("登录成功，可同步本机进度");
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
  };
  try {
    if (state.localGuest) throw new Error("LOCAL_GUEST");
    state.dashboard = await requestJson("/api/newbie/profile", { method: "PATCH", body: JSON.stringify(profile) });
  } catch (error) {
    if (!state.localGuest) {
      elements.profileStatus.textContent = error.message;
      submit.disabled = false;
      return;
    }
    const saved = readLocalGuest();
    if (!writeLocalGuest({ ...saved, profile })) {
      elements.profileStatus.textContent = "未保存";
      submit.disabled = false;
      return;
    }
    state.localGuest = true;
    state.dashboard = localDashboard();
    if (error.message !== "LOCAL_GUEST") console.info("Falling back to local guest profile save.", error);
  }
  {
    renderDashboard();
    elements.profileStatus.textContent = "已保存";
    showToast("个人主页已更新");
    submit.disabled = false;
  }
}

async function signAgreement(event) {
  event.preventDefault();
  if (state.localGuest) return openLogin();
  const submit = elements.agreementForm.querySelector('button[type="submit"]');
  const signerName = String(new FormData(elements.agreementForm).get("signerName") || "").trim();
  submit.disabled = true;
  elements.agreementStatus.textContent = "正在自动归档…";
  try {
    state.dashboard = await requestJson("/api/newbie/agreement", {
      method: "POST",
      body: JSON.stringify({
        agreementVersion: state.dashboard.agreement.version,
        signerName,
        accepted: true,
      }),
    });
  } catch (error) {
    elements.agreementStatus.textContent = error.message;
    submit.disabled = false;
    return;
  }
  {
    renderDashboard();
    showToast("已签署并进入新手村");
    submit.disabled = false;
  }
}

function openTask(id) {
  const task = state.dashboard?.tasks.find((candidate) => candidate.id === id);
  if (!task) return;
  state.currentTaskId = id;
  document.querySelector(".task-stage-dialog").textContent = `第 ${task.index} 关 · ${task.stage}`;
  document.querySelector(".task-title-dialog").textContent = task.title;
  document.querySelector(".task-summary-dialog").textContent = task.summary;
  document.querySelector(".task-goal").textContent = task.goal;
  document.querySelector(".task-materials").hidden = task.id !== "python-basics";
  const fillList = (selector, items = []) => {
    const list = document.querySelector(selector);
    list.replaceChildren(...items.map((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      return li;
    }));
  };
  fillList(".task-steps", task.steps);
  fillList(".task-examples", task.examples);
  fillList(".task-ta-prompts", task.taPrompts);
  fillList(".task-deliverables", task.deliverables);
  document.querySelectorAll(".task-extra-section").forEach((section) => {
    const list = section.querySelector("ul");
    section.hidden = !list || list.children.length === 0;
  });
  const evidenceHints = [
    `当前任务：${task.title}`,
    "建议填写：完成了什么、证据链接/截图说明、遇到的问题、下一步计划。",
  ];
  elements.taskEvidence.placeholder = evidenceHints.join("\n");
  elements.taskEvidence.value = task.evidence || "";
  document.querySelector(".task-start").hidden = task.status !== "not_started";
  document.querySelector(".task-complete").textContent = state.localGuest ? "标记学完（本机）" : "正式提交";
  document.querySelector(".task-submit").hidden = !state.localGuest;
  setTaskStatus(task.status === "completed" ? "这个任务已经完成，你仍可以更新证据和复盘。" : "");
  elements.taskDialog.showModal();
}

async function updateTask(status) {
  const task = state.dashboard?.tasks.find((candidate) => candidate.id === state.currentTaskId);
  if (!task) return;
  if (!state.localGuest && !state.dashboard.agreement?.approved) {
    elements.taskDialog.close();
    renderAgreement();
    return;
  }
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
    if (!state.localGuest) {
      setTaskStatus(error.message, true);
      buttons.forEach((button) => { button.disabled = false; });
      return;
    }
    const saved = readLocalGuest();
    if (!writeLocalGuest({
      ...saved,
      tasks: {
        ...(saved.tasks || {}),
        [task.id]: {
          status,
          evidence: elements.taskEvidence.value.trim(),
          updatedAt: Date.now(),
        },
      },
    })) {
      setTaskStatus("未保存，请允许浏览器存储后重试。", true);
      buttons.forEach((button) => { button.disabled = false; });
      return;
    }
    state.localGuest = true;
    state.dashboard = localDashboard();
    if (error.message !== "LOCAL_GUEST") console.info("Falling back to local guest task save.", error);
  }
  {
    renderDashboard();
    elements.taskDialog.close();
    showToast(state.localGuest ? "学习记录已保存到本机，尚未正式提交" : "任务记录已保存到账号");
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function logout() {
  elements.logout.disabled = true;
  try {
    if (!state.localGuest) await requestJson("/api/visitor/logout", { method: "POST", body: "{}" });
  } catch {
    elements.logout.disabled = false;
    showToast("退出失败，请重试");
    return;
  }
  elements.logout.disabled = false;
  enterLocalGuestMode("已退出账号，本机学习进度已保留");
}

async function syncProgress() {
  if (state.localGuest) return openLogin();
  if (!state.dashboard.agreement?.approved) return renderAgreement();
  const button = document.querySelector(".sync-progress");
  button.disabled = true;
  try {
    const saved = readLocalGuest();
    for (const course of LOCAL_TASKS) {
      const local = saved.tasks?.[course.id];
      const remote = state.dashboard.tasks.find((task) => task.id === course.id);
      if (!local || remote?.status === "completed" || remote?.evidence || !remote?.unlocked) continue;
      state.dashboard = await requestJson(`/api/newbie/tasks/${encodeURIComponent(course.id)}`, {
        method: "POST", body: JSON.stringify({ status: local.status, evidence: local.evidence || "" }),
      });
    }
    renderDashboard();
    showToast("已同步可提交的记录；未同步内容仍保留在本机");
  } catch (error) {
    showToast(`同步未完成：${error.message}，本机记录已保留`);
  } finally {
    button.disabled = false;
  }
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
document.querySelector(".task-submit").addEventListener("click", openLogin);
document.querySelector(".sync-progress").addEventListener("click", () => void syncProgress());
document.querySelector(".agreement-back").addEventListener("click", renderDashboard);
document.querySelectorAll(".start-learning").forEach((button) => button.addEventListener("click", () => enterLocalGuestMode()));
window.addEventListener("hashchange", () => {
  if (location.hash === "#passes") return;
  const requestedTask = state.dashboard?.tasks.find((task) => location.hash === `#${task.id}`);
  if (requestedTask) {
    switchView("tasks", true);
    if (!elements.taskDialog.open) openTask(requestedTask.id);
    return;
  }
  switchView(location.hash === "#profile" ? "profile" : "tasks");
});

enterLocalGuestMode();
void loadDashboard();

