import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});

after(async () => {
  await vite.close();
});

async function readCssTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return readCssTree(entryPath);
      }
      return entry.name.endsWith(".css") ? readFile(entryPath, "utf8") : "";
    }),
  );
  return contents.join("\n");
}

test("keeps registration and sidebar branding text-only", async () => {
  const pageSource = await readFile(path.join(root, "app/page.tsx"), "utf8");

  assert.doesNotMatch(
    pageSource,
    /className\s*=\s*["'][^"']*\b(?:registration-mark|brand-mark)\b[^"']*["']/,
  );
});

test("shows the system administrator role consistently across account and collaboration views", async () => {
  const [pageSource, peopleRouteSource, directMessagesSource] = await Promise.all([
    readFile(path.join(root, "app/page.tsx"), "utf8"),
    readFile(path.join(root, "app/api/people/route.ts"), "utf8"),
    readFile(path.join(root, "app/api/direct-messages/route.ts"), "utf8"),
  ]);

  assert.match(pageSource, /if \(isAdmin\) return "系统管理员"/u);
  assert.match(pageSource, /session\.isAdmin \? "系统管理员待办"/u);
  assert.match(pageSource, /session\.isAdmin \? "你已具备系统管理员角色，必须先完成负责人专用承诺书。"/u);
  assert.match(pageSource, /session\.isAdmin \? "原成员保密协议仍保留；由于你已成为系统管理员，需另行签署《项目负责人保密承诺书》。"/u);
  assert.match(pageSource, /className="sidebar-user-role">\{sessionRoleLabel\(currentRole, isAdmin\)\}/u);
  assert.match(pageSource, /<span>系统角色<\/span><strong>\{sessionRoleLabel\(currentRole, isAdmin\)\}<\/strong>/u);
  assert.match(pageSource, /if \(person\.isAdmin\) return "系统管理员"/u);
  assert.match(pageSource, /person\.isAdmin \|\| person\.permissions\.includes\("project_owner"\)/u);
  assert.match(pageSource, /isAdmin: summary\.peer\.isAdmin === true/u);
  assert.match(pageSource, /currentRoleLabel=\{sessionRoleLabel\(currentRole, isAdmin\)\}/u);
  assert.match(pageSource, /<ChatHub currentUser=\{session\.user\} currentRole=\{session\.role\} isAdmin=\{session\.isAdmin\}/u);
  assert.match(peopleRouteSource, /isAdmin: isAdministrator\(row\.chatgptAccount, row\.accountUserId \?\? undefined\)/u);
  assert.match(peopleRouteSource, /isAdmin: owner\.isAdmin/u);
  assert.match(directMessagesSource, /isAdmin: eligibleReviewers\.get\(peerEmail\)\?\.isAdmin === true/u);
  assert.match(directMessagesSource, /isAdmin: owner\.isAdmin/u);
});

test("keeps the internal laboratory AI discoverable only inside the admitted OA dashboard", async () => {
  const pageSource = await readFile(path.join(root, "app/page.tsx"), "utf8");

  assert.match(pageSource, /className="dashboard-ai-entry"/u);
  assert.match(pageSource, /onClick=\{\(\) => navigate\("knowledge"\)\}/u);
  assert.match(pageSource, /实验室 AI（内部）/u);
  assert.match(pageSource, /进入内部 AI/u);
  assert.match(pageSource, /if \(!session\) return[\s\S]*?<h1>请登录账号<\/h1>/u);
  assert.match(pageSource, /if \(needsNda\) return[\s\S]*?<NdaAdmissionGate/u);
  assert.ok(pageSource.indexOf("if (needsNda) return") < pageSource.indexOf('<div className="oa-app">'));
});

test("makes the official Feishu QR the primary login and keeps ChatGPT and GitHub under smaller alternatives", async () => {
  const pageSource = await readFile(path.join(root, "app/page.tsx"), "utf8");
  const choiceStart = pageSource.indexOf(
    'className="login-entry-panel"',
  );
  const choiceEnd = pageSource.indexOf(
    "function IdentityAccessGate",
    choiceStart,
  );

  assert.notEqual(choiceStart, -1);
  assert.notEqual(choiceEnd, -1);
  const choiceSource = pageSource.slice(choiceStart, choiceEnd);

  assert.match(choiceSource, /<FeishuQrLogin enabled=\{feishuLoginEnabled\}\s*\/>/u);
  assert.match(choiceSource, /<details className="other-login-options">/u);
  assert.match(choiceSource, /<summary>采用其他方式登录<\/summary>/u);
  assert.match(
    choiceSource,
    /\{chatgptLoginEnabled\s*&&\s*<a[^>]*href="\/signin-with-chatgpt\?return_to=%2F"/,
  );
  assert.match(
    choiceSource,
    /\{githubLoginEnabled\s*&&\s*<a[^>]*href="\/api\/auth\/github\/start"/,
  );
  assert.match(pageSource, /请登录账号/u);
  assert.match(pageSource, /fetch\("\/api\/auth\/feishu\/name-binding"/u);
  assert.match(pageSource, /fetch\("\/api\/auth\/feishu\/provision"/u);
  assert.match(pageSource, /provision-feishu-member/u);
  assert.match(pageSource, /这是我的账户，确认绑定/u);
  assert.match(pageSource, /系统不会仅凭姓名自动合并/u);
  assert.match(pageSource, /LarkSSOSDKWebQRCode-1\.0\.3\.js/u);
  assert.match(pageSource, /qrLogin\.matchOrigin\(event\.origin\)\s*\|\|\s*!qrLogin\.matchData\(event\.data\)/u);
  assert.match(pageSource, /authorizeUrl\.searchParams\.set\("tmp_code", temporaryCode\)/u);
  assert.match(pageSource, /本机已登录飞书，直接继续/u);
  const gateSource = pageSource.slice(pageSource.indexOf("function RegistrationGate"), pageSource.indexOf("function IdentityAccessGate"));
  assert.doesNotMatch(gateSource, /首次使用登记|提交注册申请|<Field label="学号 \/ 工号|<Field label="当前认证身份"/u);
  assert.match(gateSource, /扫码确认企业身份后即可进入 OA/u);
  assert.doesNotMatch(gateSource, /无需填写姓名、学号、工号或额外认证资料/u);
  assert.match(gateSource, /都不是我的，以当前飞书身份进入/u);
});

test("lets a member change their name in personal settings and updates the current UI identity", async () => {
  const pageSource = await readFile(path.join(root, "app/page.tsx"), "utf8");
  const settingsStart = pageSource.indexOf("function ProfileSettingsView");
  const settingsEnd = pageSource.indexOf("function NewRequestDialog", settingsStart);
  assert.notEqual(settingsStart, -1);
  assert.notEqual(settingsEnd, -1);
  const settingsSource = pageSource.slice(settingsStart, settingsEnd);
  assert.match(settingsSource, /<Field label="姓名"><Input value=\{displayName\}/u);
  assert.match(settingsSource, /JSON\.stringify\(\{ fullName: displayName, avatarDataUrl, profile \}\)/u);
  assert.match(settingsSource, /onIdentityChanged\(nextDisplayName, data\.profile\.avatarDataUrl \|\| ""\)/u);
  assert.match(settingsSource, /历史审批中的姓名快照不会随之改变/u);
});

test("canonicalizes browser canvas PNG metadata before submitting a handwritten signature", async () => {
  const pageSource = await readFile(path.join(root, "app/page.tsx"), "utf8");
  assert.match(pageSource, /canonicalizeSignaturePngDataUrl\(canvas\.toDataURL\("image\/png"\)\)/u);
});

test("binds Feishu to the exact active member through a locked top-level POST", async () => {
  const pageSource = await readFile(path.join(root, "app/page.tsx"), "utf8");
  const formStart = pageSource.indexOf('<form method="post" action="/api/auth/feishu/start?return_to=%2F"');
  const formEnd = pageSource.indexOf("</form>", formStart);
  assert.notEqual(formStart, -1);
  assert.notEqual(formEnd, -1);
  const formSource = pageSource.slice(formStart, formEnd);
  assert.match(formSource, /target="_top"/u);
  assert.match(formSource, /aria-busy=\{linkingFeishu\}/u);
  assert.match(formSource, /onSubmit=\{beginFeishuLink\}/u);
  assert.match(formSource, /disabled=\{linkingFeishu\}/u);
  assert.match(pageSource, /if \(feishuLinkLockRef\.current\) \{\s*event\.preventDefault\(\);/u);
  assert.match(pageSource, /按当前成员 ID 关联，不按姓名或邮箱自动合并/u);
});

test("launches GitHub OAuth at the top level and locks repeated binding submits", async () => {
  const [pageSource, stylesheet] = await Promise.all([
    readFile(path.join(root, "app/page.tsx"), "utf8"),
    readFile(path.join(root, "app/globals.css"), "utf8"),
  ]);
  const formStart = pageSource.indexOf(
    '<form method="post" action="/api/auth/github/start?return_to=%2F"',
  );
  const formEnd = pageSource.indexOf("</form>", formStart);

  assert.notEqual(formStart, -1);
  assert.notEqual(formEnd, -1);
  const formSource = pageSource.slice(formStart, formEnd);
  assert.match(formSource, /target="_top"/);
  assert.match(formSource, /aria-busy=\{linkingGithub\}/);
  assert.match(formSource, /onSubmit=\{beginGitHubLink\}/);
  assert.match(formSource, /disabled=\{linkingGithub\}/);
  assert.match(formSource, /正在前往 GitHub/);
  assert.match(pageSource, /if \(githubLinkLockRef\.current\) \{\s*event\.preventDefault\(\);/);
  assert.match(pageSource, /githubLinkLockRef\.current = true;\s*setLinkingGithub\(true\);/);
  assert.match(
    pageSource,
    /className="registration-login github-login"[^>]*href="\/api\/auth\/github\/start"[^>]*target="_top"/,
  );
  assert.match(
    stylesheet,
    /\.github-link-button:disabled\s*\{[^}]*cursor:\s*wait;[^}]*opacity:/,
  );
});

test("lets a pending applicant sign out into a QR-first account switch screen", async () => {
  const pageSource = await readFile(path.join(root, "app/page.tsx"), "utf8");
  const gateStart = pageSource.indexOf("function PendingGate");
  const gateEnd = pageSource.indexOf("function MembersView", gateStart);

  assert.notEqual(gateStart, -1);
  assert.notEqual(gateEnd, -1);
  const gateSource = pageSource.slice(gateStart, gateEnd);
  assert.match(gateSource, /fetch\("\/api\/session", \{ method: "DELETE", credentials: "same-origin" \}\)/u);
  assert.match(gateSource, /if \(!response\.ok\) throw new Error\("当前 OA 会话未能退出"\)/u);
  assert.match(gateSource, /切换 GitHub 账户登录/u);
  assert.match(gateSource, /<FeishuQrLogin enabled=\{session\.feishuLoginEnabled === true\}\s*\/>/u);
  assert.match(gateSource, /<summary>采用其他方式登录<\/summary>/u);
  assert.match(gateSource, /href="\/api\/auth\/github\/start" target="_top"/u);
  assert.match(gateSource, /切换登录方式不会删除原账户的注册、审核或业务记录/u);
});

test("returns successful external sign-ins to the OA dashboard", async () => {
  const pageSource = await readFile(path.join(root, "app/page.tsx"), "utf8");

  for (const provider of ["github", "feishu"]) {
    const signedInBranch = new RegExp(
      `${provider}Status === "signed-in"\\) \\{[\\s\\S]*?setActiveView\\("dashboard"\\);[\\s\\S]*?setShowMineOnly\\(false\\);[\\s\\S]*?window\\.scrollTo\\(\\{ top: 0, left: 0, behavior: "auto" \\}\\);`,
      "u",
    );
    assert.match(pageSource, signedInBranch);
  }
});

test("shows the encrypted migration download only through the admin session capability", async () => {
  const pageSource = await readFile(path.join(root, "app/page.tsx"), "utf8");
  assert.match(pageSource, /\{migrationExportEnabled\s*&&\s*\(/u);
  assert.match(pageSource, /action="\/api\/admin\/migration-export"/u);
  assert.match(pageSource, /下载加密迁移包/u);
  assert.match(pageSource, /migrationExportEnabled=\{session\.migrationExportEnabled\}/u);
});

test("shows migration recovery only after the server capability gate and requires deliberate confirmation", async () => {
  const pageSource = await readFile(path.join(root, "app/page.tsx"), "utf8");
  assert.match(pageSource, /\{migrationUnfreezeEnabled\s*&&\s*\(/u);
  assert.match(pageSource, /action="\/api\/admin\/migration-unfreeze"/u);
  assert.match(pageSource, /value="discard-current-migration-package"/u);
  assert.match(pageSource, /window\.confirm\("确认取消本次迁移/u);
  assert.match(pageSource, /migrationUnfreezeEnabled=\{session\.migrationUnfreezeEnabled\}/u);
});

test("emits the catalog's animation and scrolling utilities", async () => {
  const css = await readCssTree(path.join(root, "dist"));

  assert.match(css, /--tw-enter-opacity/);
  assert.match(css, /scrollbar-width:\s*thin/);
  assert.match(css, /scrollbar-width:\s*none/);
  assert.match(css, /scrollbar-gutter:\s*stable/);
  assert.match(css, /scroll-fade-reveal-b/);
  assert.match(css, /mask-image:/);
  assert.match(css, /tw-shimmer/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("forwards progress semantics to the primitive", async () => {
  const { Progress } = await vite.ssrLoadModule("/components/ui/progress.tsx");
  const html = renderToStaticMarkup(React.createElement(Progress, { value: 37 }));

  assert.match(html, /aria-valuenow="37"/);
  assert.match(html, /aria-valuetext="37%"/);
  assert.match(html, /data-state="loading"/);
});

test("emits chart themes for the starter's media dark mode", async () => {
  const { ChartStyle } = await vite.ssrLoadModule("/components/ui/chart.tsx");
  const html = renderToStaticMarkup(
    React.createElement(ChartStyle, {
      id: "contract",
      config: {
        latency: { theme: { light: "#ffffff", dark: "#000000" } },
      },
    }),
  );

  assert.match(html, /\[data-chart=contract\]/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.doesNotMatch(html, /\.dark/);
});

test("renders sidebar skeletons deterministically", async () => {
  const { SidebarMenuSkeleton } = await vite.ssrLoadModule(
    "/components/ui/sidebar.tsx",
  );
  const first = renderToStaticMarkup(React.createElement(SidebarMenuSkeleton));
  const second = renderToStaticMarkup(React.createElement(SidebarMenuSkeleton));

  assert.equal(first, second);
  assert.match(first, /--skeleton-width:70%/);
});
