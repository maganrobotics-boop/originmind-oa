// Isolated desktop/mobile journey; every API is a browser-local test double.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.env.PLAYWRIGHT_MODULE) throw Error("Set PLAYWRIGHT_MODULE");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = fileURLToPath(new URL("../public/", import.meta.url));
const output = resolve(process.env.BROWSER_REPORT_DIR || "newbie-village-browser-report");
await mkdir(output, { recursive: true });

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const requestedPath = pathname === "/newbie-village"
      ? "/newbie-village.html"
      : pathname === "/newbie-village/admin"
        ? "/newbie-village-admin.html"
        : pathname;
    const path = resolve(root, `.${requestedPath}`);
    if (!path.startsWith(resolve(root) + sep)) throw Error("invalid path");
    const bytes = await readFile(path);
    response.setHeader("Content-Type", ({
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
    })[extname(path)] || "application/octet-stream");
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

function tasks(firstStatus = "not_started") {
  const definitions = [
    ["registration", "入村登记", "身份与方向"],
    ["toolkit", "装备铺", "开发环境"],
    ["git-basics", "Git 训练场", "协作基础"],
    ["python-basics", "Python 训练场", "编程基础"],
    ["ros2-simulation", "ROS2 仿真场", "机器人基础"],
    ["mini-project", "任务大厅", "小型项目"],
    ["graduation", "出村考核", "成果复盘"],
  ];
  return definitions.map(([id, title, stage], index) => ({
    id,
    index: index + 1,
    title,
    stage,
    summary: `${title}任务说明。`,
    goal: `${title}任务目标。`,
    deliverables: ["提交任务证据", "写下复盘"],
    status: index === 0 ? firstStatus : "not_started",
    evidence: index === 0 && firstStatus === "completed" ? "个人主页已经完成。" : "",
    updatedAt: null,
    unlocked: index === 0 || (index === 1 && firstStatus === "completed"),
  }));
}

function agreement(reviewStatus = "unsigned") {
  const accepted = reviewStatus !== "unsigned";
  return {
    version: "2026-09-23-v1",
    title: "OriginMind × ARTS Robotics 新手村保密协议",
    effectiveDate: "2026-09-23",
    introduction: "进入新手村前请阅读并同意保密约定。",
    clauses: [{ title: "一、保密信息范围", text: "未公开代码、数据、模型和文档属于保密信息。" }],
    privacyNotice: "系统仅保存必要的签署记录，不写入 OA。",
    accepted,
    approved: reviewStatus === "approved",
    signerName: accepted ? "小深同学" : "",
    acceptedAt: accepted ? Date.now() : null,
    reviewStatus,
    reviewedAt: reviewStatus === "approved" ? Date.now() : null,
    reviewNote: "",
  };
}

function dashboard(firstStatus = "not_started", displayName = "student", agreementStatus = "approved") {
  const currentAgreement = agreement(agreementStatus);
  if (!currentAgreement.approved) {
    return {
      user: { email: "student@stumail.sztu.edu.cn", role: "student", roleLabel: "学生" },
      agreement: currentAgreement,
      profile: null,
      tasks: [],
      progress: { completed: 0, total: 7 },
    };
  }
  return {
    user: { email: "student@stumail.sztu.edu.cn", role: "student", roleLabel: "学生" },
    agreement: currentAgreement,
    profile: { displayName, grade: "2024", major: "机器人工程", direction: "navigation", bio: "学习 ROS2。" },
    tasks: tasks(firstStatus),
    progress: { completed: firstStatus === "completed" ? 1 : 0, total: 7 },
  };
}

try {
  for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, hasTouch: name === "mobile", isMobile: name === "mobile" });
    const page = await context.newPage();
    const calls = [];
    const errors = [];
    let signedIn = false;
    let agreementStatus = "unsigned";
    let taskStatus = "not_started";
    let displayName = "student";
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      calls.push({ pathname, method: request.method(), body: request.postDataJSON?.() });
      if (pathname === "/api/newbie/dashboard") {
        await route.fulfill(signedIn ? { json: dashboard(taskStatus, displayName, agreementStatus) } : { status: 401, json: { error: "请先登录。" } });
      } else if (pathname === "/api/visitor/request-code") {
        await route.fulfill({ json: { email: "student@stumail.sztu.edu.cn", devCode: "123456" } });
      } else if (pathname === "/api/visitor/verify-code") {
        signedIn = true;
        await route.fulfill({ json: { signedIn: true } });
      } else if (pathname === "/api/newbie/agreement") {
        agreementStatus = "pending";
        await route.fulfill({ json: { signed: true, archived: true, ...dashboard(taskStatus, displayName, agreementStatus) } });
      } else if (pathname === "/api/newbie/profile") {
        displayName = request.postDataJSON().displayName;
        await route.fulfill({ json: { saved: true, ...dashboard(taskStatus, displayName, agreementStatus) } });
      } else if (pathname === "/api/newbie/tasks/registration") {
        taskStatus = request.postDataJSON().status;
        await route.fulfill({ json: { saved: true, ...dashboard(taskStatus, displayName, agreementStatus) } });
      } else {
        await route.fulfill({ status: 404, json: { error: "not found" } });
      }
    });

    await page.goto(`${origin}/newbie-village`);
    await page.getByRole("heading", { name: "从第一项任务，走到能交付。" }).waitFor();
    assert.equal(await page.getByText("任务地图").count() > 0, true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

    await page.getByRole("button", { name: "使用深技大邮箱进入" }).click();
    const email = page.locator(".email-input");
    assert.equal(await email.getAttribute("placeholder"), "学号@stumail.sztu.edu.cn");
    await email.fill("student@stumail.sztu.edu.cn");
    await page.getByRole("button", { name: "发送验证码" }).click();
    await page.locator(".code-input").fill("123456");
    await page.getByRole("button", { name: "验证并进入新手村" }).click();
    await page.getByRole("heading", { name: "先签署，审核后入村。" }).waitFor();
    assert.equal(await page.locator(".task-card").count(), 0);
    await page.screenshot({ path: resolve(output, `newbie-agreement-${name}.png`), fullPage: true, animations: "disabled" });
    await page.locator('[name="signerName"]').fill("小深同学");
    await page.locator('[name="accepted"]').check();
    await page.getByRole("button", { name: "签署并提交审核" }).click();
    await page.getByRole("heading", { name: "签署记录已归档，等待管理员审核" }).waitFor();
    assert.equal(calls.find((call) => call.pathname === "/api/newbie/agreement")?.body.signerName, "小深同学");
    assert.equal(await page.locator(".task-card").count(), 0);
    agreementStatus = "approved";
    await page.reload();
    await page.locator(".task-card").first().waitFor();
    assert.equal(await page.locator(".task-card").count(), 7);
    assert.equal(await page.locator(".task-card").nth(0).locator("button").isEnabled(), true);
    assert.equal(await page.locator(".task-card").nth(1).locator("button").isDisabled(), true);

    await page.locator('[data-view="profile"]').click();
    await page.locator('[name="displayName"]').fill("小深");
    await page.getByRole("button", { name: "保存个人主页" }).click();
    await page.getByRole("heading", { name: "小深" }).waitFor();
    assert.equal(calls.find((call) => call.pathname === "/api/newbie/profile")?.body.displayName, "小深");

    await page.locator('[data-view="tasks"]').click();
    await page.locator(".task-card").first().getByRole("button", { name: "查看任务" }).click();
    await page.getByRole("button", { name: "开始任务" }).click();
    await page.locator(".task-card").first().getByRole("button", { name: "查看任务" }).click();
    await page.locator(".task-evidence").fill("个人主页已经完成，准备开始下一关。");
    await page.getByRole("button", { name: "提交完成" }).click();
    await page.waitForFunction(() => !document.querySelectorAll(".task-card")[1]?.querySelector("button")?.disabled);
    assert.equal(await page.locator(".task-card").nth(1).locator("button").isEnabled(), true);
    assert.equal(calls.some((call) => call.pathname.startsWith("/api/oa")), false);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: resolve(output, `newbie-village-${name}.png`), fullPage: true, animations: "disabled" });
    console.log(`${name}: login, profile, sequential task unlock, OA isolation and responsive width passed`);
    await context.close();
  }

  const adminContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const adminPage = await adminContext.newPage();
  const adminErrors = [];
  let reviewPayload;
  adminPage.on("pageerror", (error) => adminErrors.push(error.message));
  await adminPage.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/auth/status") {
      await route.fulfill({ json: { signedIn: true } });
    } else if (pathname === "/api/admin/newbie-agreements") {
      await route.fulfill({ json: {
        agreement: agreement("pending"),
        records: [{
          email: "student@stumail.sztu.edu.cn",
          agreementVersion: "2026-09-23-v1",
          signerName: "小深同学",
          contentSha256: "a".repeat(64),
          acceptedAt: Date.now(),
          reviewStatus: "pending",
          reviewedBy: "",
          reviewedAt: null,
          reviewNote: "",
        }],
      } });
    } else if (pathname === "/api/admin/newbie-agreements/review") {
      reviewPayload = request.postDataJSON();
      await route.fulfill({ json: { saved: true, reviewStatus: reviewPayload.reviewStatus } });
    } else {
      await route.fulfill({ status: 404, json: { error: "not found" } });
    }
  });
  await adminPage.goto(`${origin}/newbie-village/admin`);
  await adminPage.getByRole("heading", { name: "签署归档与审核" }).waitFor();
  await adminPage.getByRole("button", { name: "审核" }).click();
  await adminPage.locator('[name="reviewNote"]').fill("身份与签署信息一致。");
  await adminPage.getByRole("button", { name: "通过并准予入村" }).click();
  await adminPage.waitForFunction(() => !document.querySelector(".review-dialog")?.open);
  assert.equal(reviewPayload.email, "student@stumail.sztu.edu.cn");
  assert.equal(reviewPayload.reviewStatus, "approved");
  assert.deepEqual(adminErrors, []);
  await adminPage.screenshot({ path: resolve(output, "newbie-village-admin.png"), fullPage: true, animations: "disabled" });
  console.log("admin: internal archive listing and approval journey passed");
  await adminContext.close();
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

