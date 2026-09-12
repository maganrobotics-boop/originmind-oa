import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const executeFile = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendDir = path.join(root, "frontend");
const publicDir = path.join(root, "public");
const assetDir = path.join(publicDir, "assets");
const buildScript = path.join(root, "scripts", "build-frontend.mjs");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

async function expectedFrontend() {
  const [template, app, style] = await Promise.all([
    readFile(path.join(frontendDir, "index.html"), "utf8"),
    readFile(path.join(frontendDir, "app.js")),
    readFile(path.join(frontendDir, "styles.css")),
  ]);
  const appName = `app-${digest(app)}.js`;
  const styleName = `styles-${digest(style)}.css`;
  const html = template
    .replace("__APP_ASSET__", `/assets/${appName}`)
    .replace("__STYLE_ASSET__", `/assets/${styleName}`);
  return { template, html, app, style, appName, styleName };
}

async function fileSnapshot(paths) {
  const result = [];
  for (const file of paths) {
    const [bytes, metadata] = await Promise.all([readFile(file), stat(file, { bigint: true })]);
    result.push({
      file: path.relative(root, file),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mtimeNs: String(metadata.mtimeNs),
    });
  }
  return result;
}

test("the deterministic build contains exactly the current content-hashed frontend", async () => {
  const expected = await expectedFrontend();
  assert.equal(expected.template.split("__APP_ASSET__").length - 1, 1);
  assert.equal(expected.template.split("__STYLE_ASSET__").length - 1, 1);

  const top = (await readdir(publicDir)).sort();
  assert.deepEqual(top, ["LICENSES.md", "_headers", "assets", "favicon.svg", "index.html"]);
  assert.deepEqual((await readdir(assetDir)).sort(), [expected.appName, expected.styleName].sort());
  assert.equal(await readFile(path.join(publicDir, "index.html"), "utf8"), expected.html);
  assert.deepEqual(await readFile(path.join(assetDir, expected.appName)), expected.app);
  assert.deepEqual(await readFile(path.join(assetDir, expected.styleName)), expected.style);
});

test("build --check verifies outputs without mutating them", async () => {
  const expected = await expectedFrontend();
  const outputs = [
    path.join(publicDir, "index.html"),
    path.join(assetDir, expected.appName),
    path.join(assetDir, expected.styleName),
  ];
  const before = await fileSnapshot(outputs);
  const result = await executeFile(process.execPath, [buildScript, "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(result.stdout, /^Frontend checked: app-[a-f0-9]{16}\.js, styles-[a-f0-9]{16}\.css\n$/u);
  assert.deepEqual(await fileSnapshot(outputs), before);
});

test("HTML uses only self-hosted generated assets and retains public metadata", async () => {
  const expected = await expectedFrontend();
  const html = await readFile(path.join(publicDir, "index.html"), "utf8");
  assert.equal(html.includes("__APP_ASSET__"), false);
  assert.equal(html.includes("__STYLE_ASSET__"), false);
  assert.match(html, /<html\b[^>]*\blang=["']zh-CN["']/iu);
  assert.match(html, /<meta\b[^>]*\bname=["']viewport["']/iu);
  assert.match(html, /<meta\b[^>]*\bname=["']robots["'][^>]*\bcontent=["']noindex,nofollow["']/iu);
  assert.match(html, /<meta\b[^>]*\bname=["']description["']/iu);
  assert.ok(html.includes("ARTS Robotics AI assistant"));
  assert.ok(html.includes(`/assets/${expected.appName}`));
  assert.ok(html.includes(`/assets/${expected.styleName}`));

  const scriptSources = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu)]
    .map((match) => match[1]);
  const styleSources = [...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/giu)]
    .map((match) => match[1]);
  assert.deepEqual(scriptSources, [`/assets/${expected.appName}`]);
  assert.deepEqual(styleSources, [`/assets/${expected.styleName}`]);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>/iu);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/iu);
  assert.ok([...scriptSources, ...styleSources].every((source) => source.startsWith("/assets/")));
});

test("vanilla frontend preserves every same-origin API and visibility contract", async () => {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  for (const route of [
    "/api/status",
    "/api/chat",
    "/api/inquiries",
    "/api/auth/status",
    "/api/auth/login",
    "/api/auth/logout",
  ]) {
    assert.ok(script.includes(route), route);
  }
  assert.ok(script.includes("/api/admin/${endpoint}"));
  for (const endpoint of ["config", "test", "oa-test", "documents", "inquiries"]) {
    assert.match(script, new RegExp(`adminRequest\\(["']${endpoint}["']`, "u"), endpoint);
  }
  assert.match(script, /(?:window\.)?location\.pathname\s*===?\s*["']\/manage["']/u);
  assert.match(script, /\bconst\s+APP_NAME\s*=\s*["']ARTS Robotics AI assistant["']\s*;/u);
  assert.match(script, /\bconst\s+HEADER_NAME\s*=\s*["']ARTS Robotics AI Assistant["']\s*;/u);
  assert.ok(script.includes("机器人自主自动与操作实验室"));
  assert.ok(script.includes("OriginMind x ARTS Robotics"));
  for (const section of [
    "技术成果与产业化",
    "科研合作与学术交流",
    "源灵智能科技有限公司",
    "智能无人系统创新协会",
  ]) {
    assert.ok(script.includes(section), section);
  }
  for (const question of [
    "从双臂灵巧操作到 3C 精密装配，团队有哪些可落地技术成果？",
    "试管抓取如何实现随机姿态 96.6% 成功率与 38.4% 效率提升？",
    "ARTS Robotics 与哪些国内外高校和科研机构开展合作？",
    "马淦团队有哪些代表性的国际科研经历与合作成果？",
    "源灵智能如何用 OmindOS 让机器人理解任务、自主行动？",
    "源灵智能能为机器人厂商和场景集成商提供哪些合作方案？",
    "智能无人系统创新协会由谁指导，可以连接哪些机器人研究方向？",
    "协会指导教师所在实验室有哪些公开的竞赛与创新成果？",
  ]) {
    assert.ok(script.includes(question), question);
  }
  assert.match(script, /id:\s*["']technology["'][\s\S]*?requestTopic:\s*["']research["']/u);
  assert.match(script, /id:\s*["']academic["'][\s\S]*?requestTopic:\s*["']research["']/u);
  assert.match(script, /id:\s*["']company["'][\s\S]*?requestTopic:\s*["']business["']/u);
  assert.match(script, /id:\s*["']association["'][\s\S]*?requestTopic:\s*["']student["']/u);
  assert.match(script, /\bpublished\s*:\s*0\b/u);
  assert.ok(script.includes("保存并提交 OA 待审"));
  assert.ok(script.includes("未经审核的资料不会用于回答。"));
  const externalApis = [...script.matchAll(/https?:\/\/[^\s"'`]+\/api\/[^\s"'`]+/giu)].map((match) => match[0]);
  assert.deepEqual(externalApis, ["https://oa.omindos.ai/api/knowledge/import-chat"]);

  for (const forbidden of [
    "马教授 AI 助手",
    "ask_professor_assistant",
    "legacy_seed",
    "非 OA 审核",
    "published:o.published",
  ]) {
    assert.equal(script.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(script, /\bpublished\s*:\s*(?:1|true)\b/u);
});

test("public topics keep independent view state without a duplicate welcome avatar", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);

  assert.match(script, /sessions:\s*Object\.fromEntries\(TOPICS\.map/u);
  assert.match(script, /function\s+sessionFor\s*\(/u);
  assert.match(script, /function\s+saveCurrentView\s*\(/u);
  for (const field of ["messages", "draft", "scrollTop", "stickToEnd", "sending", "error", "notice"]) {
    assert.match(script, new RegExp(`\\b${field}:`, "u"), field);
  }
  assert.doesNotMatch(script, /className:\s*["']welcome-mark["']/u);
  assert.doesNotMatch(style, /\.welcome-mark\b/u);
});

test("frontend source avoids executable HTML and dynamic-code sinks", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);
  for (const forbidden of [
    /\.innerHTML\b/u,
    /\binsertAdjacentHTML\s*\(/u,
    /\bdocument\.write\s*\(/u,
    /\bdangerouslySetInnerHTML\b/u,
    /\beval\s*\(/u,
    /\bnew\s+Function\s*\(/u,
  ]) {
    assert.doesNotMatch(script, forbidden);
  }
  assert.doesNotMatch(script, /(?:import\s*(?:\(|[^;]*?\bfrom\s*)|export\s+[^;]*?\bfrom\s*)["']https?:/u);
  assert.doesNotMatch(style, /@import\b|url\(\s*["']?https?:/iu);
});
