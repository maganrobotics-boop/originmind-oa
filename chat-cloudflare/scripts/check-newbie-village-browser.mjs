// Current guest/account contract against real Chat handlers and in-memory SQLite.
// Only the external OA archive is doubled. Synthetic sessions are bridged over
// loopback HTTP so production Secure cookie attributes need not be weakened.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handleRequest } from "../src/app.mjs";
import { sha256Hex } from "../src/crypto.mjs";
import { D1DatabaseAdapter } from "../test/d1-adapter.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw Error("Set PLAYWRIGHT_MODULE");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = fileURLToPath(new URL("../public/", import.meta.url));
const output = resolve(process.env.BROWSER_REPORT_DIR || "newbie-village-browser-report");
await mkdir(output, { recursive: true });
const canonical = "https://newbie.example.test";
const localKey = "originmind-newbie-guest-v1";
const courseIds = ["registration", "toolkit", "git-basics", "python-basics", "ros2-simulation", "mini-project", "graduation"];
const clients = new Map();
const calls = [];
const archiveCalls = [];
const serverErrors = [];
const db = new D1DatabaseAdapter();
let archiveAvailable = true;
const env = {
  DB: db, APP_ORIGIN: canonical, ADMIN_EMAIL: "synthetic-admin@example.test",
  APP_ENCRYPTION_KEY: "synthetic-key".padEnd(48, "e"),
  RATE_LIMIT_HMAC_KEY: "synthetic-hmac".padEnd(48, "r"),
  PUBLIC_LAB_AI_SERVICE_TOKEN: "A".repeat(43),
  OA_SERVICE: { async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/api/public/lab-ai/newbie-agreement");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("x-originmind-public-lab-ai-service-token"), env.PUBLIC_LAB_AI_SERVICE_TOKEN);
    const payload = await request.json();
    archiveCalls.push(payload);
    if (!archiveAvailable) return Response.json({ error: "测试归档暂不可用" }, { status: 503 });
    return Response.json({ approval: { id: `synthetic-${payload.email.split("@")[0]}`, status: "已归档" } }, { status: 201 });
  } },
};
let origin;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, canonical);
    if (url.pathname.startsWith("/api/")) {
      const client = clients.get(req.headers["x-newbie-test-client"]);
      if (!client) throw Error("Unknown isolated test client");
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
      headers.set("cookie", client.cookie || "");
      if (headers.get("origin") === origin) headers.set("origin", canonical);
      const call = { client: client.id, pathname: url.pathname, search: url.search, method: req.method,
        body: body.length ? JSON.parse(body) : null };
      calls.push(call);
      const request = new Request(url, { method: req.method, headers, ...(body.length ? { body } : {}) });
      const response = client.failTask && url.pathname === `/api/newbie/tasks/${client.failTask}`
        ? Response.json({ error: "测试保存失败" }, { status: 503 })
        : await handleRequest(request, env, {}, { fetch() { throw Error("External network forbidden in newbie QA"); } });
      call.status = response.status;
      const cookie = response.headers.get("set-cookie");
      if (cookie) client.cookie = cookie.split(";", 1)[0];
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("set-cookie");
      res.writeHead(response.status, Object.fromEntries(responseHeaders));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    // Exercise this legacy page directly; entrypoint redirects have separate tests.
    const requestedPath = url.pathname === "/newbie-village" ? "/newbie-village.html"
      : url.pathname === "/newbie-village/admin" ? "/newbie-village-admin.html" : url.pathname;
    const path = resolve(root, `.${requestedPath}`);
    if (!path.startsWith(resolve(root) + sep)) throw Error("Invalid asset path");
    let bytes;
    try { bytes = await readFile(path); } catch { res.writeHead(404); res.end("not found"); return; }
    res.setHeader("Content-Type", ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" })[extname(path)] || "application/octet-stream");
    res.end(bytes);
  } catch (error) {
    serverErrors.push(error.message);
    res.writeHead(500); res.end("Test harness error");
  }
});
await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
origin = `http://127.0.0.1:${server.address().port}`;
const checks = [];
const contexts = [];
let browser;
let activePage;
function passed(name) { checks.push(name); console.log(`PASS ${name}`); }
function taskWrites(client) { return calls.filter(call => call.client === client.id && call.pathname.startsWith("/api/newbie/tasks/")); }
function progress(email) {
  return db.sqlite.prepare("SELECT task_id,status,evidence FROM newbie_task_progress WHERE email=? ORDER BY task_id").all(email).map(row => ({ ...row }));
}
function acceptance(email) { return db.sqlite.prepare("SELECT * FROM newbie_agreement_acceptances WHERE email=?").get(email); }
async function local(page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key) || "{}"), localKey); }
async function noOverflow(page) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true); }
async function newContext(id, viewport, cookie = "") {
  const client = { id, cookie };
  clients.set(id, client);
  const context = await browser.newContext({ viewport, hasTouch: id === "mobile", isMobile: id === "mobile",
    extraHTTPHeaders: { "X-Newbie-Test-Client": id } });
  contexts.push(context);
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  activePage = page;
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  return { client, context, page, errors };
}
async function load(page) {
  await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === "/api/newbie/dashboard"),
    page.goto(origin + "/newbie-village")]);
  await page.locator(".task-card").first().waitFor();
}
async function openTask(page, id) {
  await page.locator('[data-view="tasks"]').click();
  await page.locator(".task-card").nth(courseIds.indexOf(id)).getByRole("button", { name: "查看课程与任务", exact: true }).click();
  await page.locator(".task-dialog[open]").waitFor();
}
async function completeLocal(page, id, evidence) {
  await openTask(page, id);
  await page.locator(".task-evidence").fill(evidence);
  await page.getByRole("button", { name: "标记学完（本机）", exact: true }).click();
  await page.locator(".task-dialog").waitFor({ state: "hidden" });
  assert.equal((await local(page)).tasks[id].evidence, evidence);
}
async function login(page, account) {
  await page.locator(".email-input").fill(`${account}@stumail.sztu.edu.cn`);
  await page.locator(".code-input").fill(account);
  assert.equal(await page.locator(".code-input").getAttribute("type"), "password");
  assert.equal(await page.getByRole("button", { name: "发送验证码", exact: true }).isVisible(), false);
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/api/visitor/login"),
    page.getByRole("button", { name: "登录并进入新手村", exact: true }).click(),
  ]);
  assert.equal(response.status(), 200, "account/password login must succeed");
  await page.locator(".sync-progress").waitFor();
}
async function sync(page) {
  await page.locator(".sync-progress").click();
  await page.getByText("已同步可提交的记录；未同步内容仍保留在本机", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector(".sync-progress").disabled);
}

try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
    ...(process.env.PLAYWRIGHT_ARGS_JSON ? { args: JSON.parse(process.env.PLAYWRIGHT_ARGS_JSON) } : {}),
  });
  for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const { client, context, page, errors } = await newContext(name, viewport);
    const account = `synthetic-${name}`;
    const email = `${account}@stumail.sztu.edu.cn`;
    await load(page);
    assert.equal(await page.locator(".logged-out").isVisible(), false);
    assert.equal(await page.locator(".agreement-gate").isVisible(), false);
    assert.equal(await page.locator(".sync-progress").isVisible(), false);
    assert.equal(await page.locator(".task-card").count(), 7);
    assert.match(await page.locator(".storage-note").innerText(), /仅保存在当前浏览器/);
    for (const id of courseIds) {
      await openTask(page, id);
      assert.ok((await page.locator(".task-goal").innerText()).length);
      assert.ok(await page.locator(".task-steps li").count());
      assert.match(await page.locator(".task-lesson-link").getAttribute("href"), /^\/assets\/newbie-.+\/index\.html$/);
      await page.locator(".task-close").click();
    }
    assert.equal(calls.filter(call => call.client === name && call.method !== "GET").length, 0);
    await noOverflow(page);
    passed(`${name}: seven public courses without login, agreement or writes`);

    await page.locator('[data-view="profile"]').click();
    await page.locator('[name="displayName"]').fill("本机测试同学");
    await page.getByRole("button", { name: "保存个人主页", exact: true }).click();
    await page.getByRole("heading", { name: "本机测试同学", exact: true }).waitFor();
    await completeLocal(page, "registration", "本机登记证据");
    await completeLocal(page, "toolkit", "本机工具证据");
    await completeLocal(page, "graduation", "提前浏览末关的本机记录");
    let savedLocal = await local(page);
    assert.equal(savedLocal.profile.displayName, "本机测试同学");
    assert.equal(savedLocal.agreement, undefined);
    assert.deepEqual(progress(email), []);
    await load(page);
    assert.deepEqual(await local(page), savedLocal);
    assert.equal(await page.locator(".progress-number").innerText(), "3");
    await openTask(page, "registration");
    assert.equal(await page.locator(".task-evidence").inputValue(), "本机登记证据");
    await page.getByRole("button", { name: "登录后正式提交", exact: true }).click();
    await page.locator(".login-dialog[open]").waitFor();
    await page.locator(".login-close").click();
    assert.equal(await page.locator(".dashboard").isVisible(), true);
    assert.equal(taskWrites(client).length, 0);
    passed(`${name}: local profile/progress survive reload; formal submission requests login`);

    await page.locator(".login-trigger:visible").click();
    await login(page, account);
    assert.match(await page.locator(".user-chip").innerText(), new RegExp(email));
    assert.equal(await page.locator(".task-card").count(), 7);
    await openTask(page, "graduation");
    await page.getByRole("button", { name: "正式提交", exact: true }).click();
    await page.getByRole("heading", { name: "先签署，自动入村。", exact: true }).waitFor();
    assert.equal(taskWrites(client).length, 0);
    await page.locator(".agreement-back").click();
    await page.locator(".sync-progress").click();
    await page.locator(".agreement-gate").waitFor();
    await page.locator('[name="signerName"]').fill("合成测试同学");
    await page.locator('[name="accepted"]').check();
    archiveAvailable = false;
    await page.getByRole("button", { name: "签署并进入新手村", exact: true }).click();
    await page.getByText("测试归档暂不可用", { exact: true }).waitFor();
    assert.equal(acceptance(email), undefined);
    assert.equal(await page.locator(".agreement-gate").isVisible(), true);
    assert.deepEqual(await local(page), savedLocal);
    archiveAvailable = true;
    await page.getByRole("button", { name: "签署并进入新手村", exact: true }).click();
    await page.locator(".dashboard").waitFor();
    const archived = acceptance(email);
    assert.equal(archived.signer_name, "合成测试同学");
    assert.equal(archived.review_status, "approved");
    assert.equal(archived.reviewed_by, `system:auto:oa:synthetic-${account}`);
    const archive = archiveCalls.at(-1);
    assert.equal(archive.email, email);
    assert.equal(archive.signerName, archived.signer_name);
    assert.equal(archive.agreement.version, archived.agreement_version);
    assert.equal(archive.contentSha256, await sha256Hex(JSON.stringify(archive.agreement)));
    assert.equal(archive.contentSha256, archived.content_sha256);
    assert.equal(Date.parse(archive.acceptedAt), archived.accepted_at);
    assert.ok(archive.agreementText.includes("保密"));
    assert.equal(await page.locator(".agreement-review").isVisible(), false);
    passed(`${name}: password login, deferred real-name agreement, failed archive and automatic admission`);

    // Locked courses remain browsable but cannot become formal completion.
    await openTask(page, "graduation");
    await page.locator(".task-evidence").fill("不能跳过前置任务");
    await page.getByRole("button", { name: "正式提交", exact: true }).click();
    await page.getByText("请先完成前一项任务。", { exact: true }).waitFor();
    assert.deepEqual(progress(email), []);
    assert.deepEqual(await local(page), savedLocal);
    await page.locator(".task-close").click();
    const syncStart = taskWrites(client).length;
    client.failTask = "toolkit";
    await page.locator(".sync-progress").click();
    await page.getByText("同步未完成：测试保存失败，本机记录已保留", { exact: true }).waitFor();
    assert.deepEqual(progress(email), [{ task_id: "registration", status: "completed", evidence: "本机登记证据" }]);
    assert.deepEqual(await local(page), savedLocal);
    client.failTask = null;
    await sync(page);
    assert.deepEqual(taskWrites(client).slice(syncStart).map(call => ({ path: call.pathname, body: call.body, status: call.status })), [
      { path: "/api/newbie/tasks/registration", body: { status: "completed", evidence: "本机登记证据" }, status: 200 },
      { path: "/api/newbie/tasks/toolkit", body: { status: "completed", evidence: "本机工具证据" }, status: 503 },
      { path: "/api/newbie/tasks/toolkit", body: { status: "completed", evidence: "本机工具证据" }, status: 200 },
    ]);
    assert.deepEqual(progress(email), [
      { task_id: "registration", status: "completed", evidence: "本机登记证据" },
      { task_id: "toolkit", status: "completed", evidence: "本机工具证据" },
    ]);
    assert.equal(await page.locator(".task-card").nth(2).locator(".status").innerText(), "未开始");
    assert.equal(await page.locator(".task-card").nth(6).locator(".status").innerText(), "未解锁");
    const writesAfterSync = taskWrites(client).length;
    await sync(page);
    assert.equal(taskWrites(client).length, writesAfterSync);
    assert.deepEqual(await local(page), savedLocal);
    passed(`${name}: sequential sync, partial failure/retry, exact evidence and locked/completed record protection`);

    await page.locator('[data-view="profile"]').click();
    await page.locator('[name="displayName"]').fill("正式测试同学");
    await page.getByRole("button", { name: "保存个人主页", exact: true }).click();
    await page.getByRole("heading", { name: "正式测试同学", exact: true }).waitFor();
    await openTask(page, "git-basics");
    await page.locator(".task-evidence").fill("服务器正式证据");
    await page.getByRole("button", { name: "开始任务", exact: true }).click();
    await page.locator(".task-dialog").waitFor({ state: "hidden" });
    assert.equal(progress(email).find(row => row.task_id === "git-basics").status, "in_progress");
    await page.locator(".logout-trigger").click();
    await page.locator(".login-trigger:visible").waitFor();
    await completeLocal(page, "git-basics", "本机不同证据，不应覆盖账号");
    savedLocal = await local(page);
    await page.locator(".login-trigger:visible").click();
    await login(page, account);
    const writesBeforeConflictSync = taskWrites(client).length;
    await sync(page);
    assert.equal(taskWrites(client).length, writesBeforeConflictSync);
    assert.deepEqual(progress(email).find(row => row.task_id === "git-basics"),
      { task_id: "git-basics", status: "in_progress", evidence: "服务器正式证据" });
    client.failTask = "git-basics";
    await openTask(page, "git-basics");
    await page.getByRole("button", { name: "正式提交", exact: true }).click();
    await page.getByText("测试保存失败", { exact: true }).waitFor();
    assert.equal(await page.locator(".task-dialog").isVisible(), true);
    assert.equal(progress(email).find(row => row.task_id === "git-basics").status, "in_progress");
    assert.deepEqual(await local(page), savedLocal);
    client.failTask = null;
    await page.getByRole("button", { name: "正式提交", exact: true }).click();
    await page.locator(".task-dialog").waitFor({ state: "hidden" });
    assert.equal(progress(email).find(row => row.task_id === "git-basics").status, "completed");
    await load(page);
    assert.equal(await page.locator(".progress-number").innerText(), "3");
    await openTask(page, "git-basics");
    assert.equal(await page.locator(".task-evidence").inputValue(), "服务器正式证据");
    await page.locator(".task-close").click();
    await page.locator(".logout-trigger").click();
    await page.locator(".login-trigger:visible").waitFor();
    assert.deepEqual(await local(page), savedLocal);
    await load(page);
    assert.equal(await page.locator(".sync-progress").isVisible(), false);
    assert.equal(await page.locator(".progress-number").innerText(), "4");
    await openTask(page, "git-basics");
    assert.equal(await page.locator(".task-evidence").inputValue(), "本机不同证据，不应覆盖账号");
    await page.locator(".task-close").click();
    assert.deepEqual(errors, []);
    await noOverflow(page);
    await page.screenshot({ path: resolve(output, `newbie-village-${name}.png`), fullPage: true, animations: "disabled" });
    passed(`${name}: server evidence is not overwritten; formal writes persist, failures stay failed, logout preserves local records`);
    await context.close();
  }

  const adminToken = "a".repeat(64);
  db.sqlite.prepare("INSERT INTO sessions(hash,expires) VALUES(?,?)").run(await sha256Hex(adminToken), Date.now() + 3600000);
  const { client, context, page, errors } = await newContext("admin", { width: 1280, height: 900 }, `__Host-ma-session=${adminToken}`);
  await page.goto(origin + "/newbie-village/admin");
  await page.getByText("当前没有符合条件的签署记录。", { exact: true }).waitFor();
  assert.equal(await page.locator(".status-filter").inputValue(), "pending");
  await page.locator(".status-filter").selectOption("approved");
  await page.getByText("共 2 条记录", { exact: true }).waitFor();
  assert.equal(await page.locator(".record").count(), 2);
  const before = db.sqlite.prepare("SELECT * FROM newbie_agreement_acceptances ORDER BY email").all();
  for (const record of before) {
    const card = page.locator(".record").filter({ hasText: record.email });
    assert.equal(await card.count(), 1);
    assert.ok((await card.innerText()).includes(record.signer_name));
    assert.ok((await card.innerText()).includes(record.content_sha256));
    assert.ok((await card.innerText()).includes(record.agreement_version));
    assert.ok((await card.innerText()).includes("已自动归档至 OA。"));
    assert.equal(await card.getByRole("button").count(), 0);
  }
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).search === "?status=all"),
    page.locator(".status-filter").selectOption("all"),
  ]);
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).search === "?status=all"),
    page.locator(".refresh").click(),
  ]);
  await page.getByText("共 2 条记录", { exact: true }).waitFor();
  assert.equal(await page.locator(".review-dialog").isVisible(), false);
  assert.deepEqual(db.sqlite.prepare("SELECT * FROM newbie_agreement_acceptances ORDER BY email").all(), before);
  assert.equal(calls.some(call => call.client === client.id && call.method !== "GET"), false);
  assert.deepEqual(errors, []);
  await noOverflow(page);
  await page.screenshot({ path: resolve(output, "newbie-village-admin.png"), fullPage: true, animations: "disabled" });
  // Session expiry returns to login; it cannot expose the internal archive.
  db.sqlite.prepare("DELETE FROM sessions").run();
  await page.locator(".refresh").click();
  await page.locator(".login-panel").waitFor();
  assert.equal(await page.locator(".admin-app").isVisible(), false);
  assert.equal(calls.at(-1).status, 403);
  passed("admin: auto-archived records are read-only, filters/refresh work, expired session is denied");
  await context.close();
  assert.equal(calls.some(call => /request-code|verify-code|newbie-agreements\/review/.test(call.pathname)), false);
  assert.equal(calls.some(call => call.pathname.startsWith("/api/oa")), false);
  assert.deepEqual(serverErrors, []);
  passed("no retired verification/review requests, browser OA writes, or unhandled server errors");
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: resolve(output, "newbie-failure.png"), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  // Avoid emitting login payloads or session tokens, even though fixtures are synthetic.
  await writeFile(resolve(output, "newbie-contract-results.json"), JSON.stringify({ checks, serverErrors,
    calls: calls.map(({ client, pathname, method, status }) => ({ client, pathname, method, status })) }, null, 2));
  for (const context of contexts) await context.close();
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
  db.close();
}
