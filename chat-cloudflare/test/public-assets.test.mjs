import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

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

async function frontendAnswerFormatter() {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  const start = script.indexOf("function referenceSectionStart");
  const end = script.indexOf("function serviceLabel", start);
  assert.ok(start >= 0 && end > start, "frontend answer formatter must remain directly testable");
  return runInNewContext(`${script.slice(start, end)}\nuserFacingAnswer;`, Object.create(null));
}

async function frontendImportHelpers() {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  const start = script.indexOf("const MAX_TEXT_IMPORT_BYTES");
  const end = script.indexOf("const TOPICS", start);
  assert.ok(start >= 0 && end > start, "frontend import helpers must remain directly testable");
  return runInNewContext(
    `${script.slice(start, end)}\n({ MAX_TEXT_IMPORT_BYTES, CHAT_DIRECT_OA_THRESHOLD_CHARACTERS, MAX_OA_STORAGE_FRAGMENT_CHARACTERS, normalizeImportedText, decodeImportedUtf8, utf8ByteLength, estimatedOaStorageFragmentCount, oaImportReceipt, returnedKnowledgeItemIdFromSearch, withoutReturnedKnowledgeItemQuery });`,
    { TextDecoder, TextEncoder, URL, URLSearchParams },
  );
}

async function frontendReturnedImportHarness({
  ok,
  payload,
  returnedKnowledgeItemId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  initialOaSubmissionState = "unsubmitted",
  failSubmittedPatchCount = 0,
  deferStatus = false,
}) {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  const start = script.indexOf("function clearReturnedKnowledgeContext");
  const end = script.indexOf("async function runAdminAction", start);
  assert.ok(start >= 0 && end > start, "returned-import lifecycle must remain directly testable");
  const draft = {
    id: "11111111-2222-4333-8444-555555555555",
    title: "修订稿",
    body: "已按审核意见修改后的正文内容。",
    url: "",
    category: "research",
    updatedAt: "2026-09-13",
    draftRevision: 3,
    oaSubmissionState: initialOaSubmissionState,
    submissionRequestId: "",
  };
  const calls = {
    request: null,
    requestUrl: "",
    importRequests: [],
    statusRequests: [],
    adminRequests: [],
    events: [],
    renders: 0,
    replacedUrl: "",
  };
  const state = {
    returnedKnowledgeItemId,
    notice: "",
    documents: [draft],
    oaStatusSyncRequired: false,
    oaStatusSyncing: false,
    loading: false,
    config: { keyConfigured: false },
    inquiries: [],
    initialized: false,
    activeTab: "inquiries",
  };
  let remainingSubmittedPatchFailures = failSubmittedPatchCount;
  const api = runInNewContext(`${script.slice(start, end)}\n({ submitDocumentToOa, fetchAdminData });`, {
    state,
    OA_CHAT_IMPORT_URL: "https://oa.omindos.ai/api/knowledge/import-chat",
    OA_CHAT_IMPORT_STATUS_URL: "https://oa.omindos.ai/api/knowledge/import-chat/status",
    CHAT_DIRECT_OA_THRESHOLD_CHARACTERS: 30_000,
    SAFE_RETURNED_KNOWLEDGE_ITEM_ID: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    AbortSignal,
    fetch: async (url, options) => {
      const request = JSON.parse(options.body);
      if (url === "https://oa.omindos.ai/api/knowledge/import-chat/status") {
        calls.statusRequests.push(request);
        calls.events.push("oa:status");
        if (deferStatus) return new Promise(() => {});
        return {
          ok: true,
          json: async () => ({ documentId: request.document.id, submitted: false }),
        };
      }
      calls.requestUrl = url;
      calls.request = request;
      calls.importRequests.push(request);
      calls.events.push("oa:import");
      return { ok, json: async () => payload };
    },
    jsonOptions: (body, method = "POST") => ({
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    adminRequest: async (endpoint, options = {}) => {
      if (!options.method) {
        if (endpoint === "config") return { keyConfigured: false };
        if (endpoint === "documents") return { documents: state.documents };
        if (endpoint === "inquiries") return { inquiries: [] };
      }
      const request = {
        endpoint,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null,
      };
      calls.adminRequests.push(request);
      calls.events.push(`chat:${request.body?.submissionState || request.method.toLowerCase()}`);
      if (request.body?.submissionState === "submitted" && remainingSubmittedPatchFailures > 0) {
        remainingSubmittedPatchFailures -= 1;
        throw new Error("Chat PATCH failed");
      }
      const current = state.documents.find((document) => document.id === request.body?.id) || draft;
      return {
        saved: true,
        document: {
          ...current,
          oaSubmissionState: request.body?.submissionState || current.oaSubmissionState,
          oaItemId: request.body?.oaItemId || "",
          oaSubmittedAt: "2026-09-13T06:00:00.000Z",
        },
      };
    },
    oaImportReceipt: (result) => ({ items: result.item ? [result.item] : [], partCount: Number(result.partCount) || 1 }),
    withoutReturnedKnowledgeItemQuery: (href) => {
      const url = new URL(href);
      url.searchParams.delete("returnedKnowledgeItem");
      return `${url.pathname}${url.search}${url.hash}`;
    },
    window: {
      location: { href: "https://chat.omindos.ai/manage?keep=1&returnedKnowledgeItem=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee#upload" },
      history: {
        state: null,
        replaceState: (_state, _title, url) => { calls.replacedUrl = url; },
      },
    },
    renderAdminShell: () => { calls.renders += 1; },
  });
  return { api, calls, draft, state };
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
  assert.match(html, /<meta\b[^>]*\bname=["']viewport["'][^>]*\bcontent=["'][^"']*\binteractive-widget=resizes-content\b[^"']*["']/iu);
  assert.match(html, /<meta\b[^>]*\bname=["']robots["'][^>]*\bcontent=["']noindex,nofollow["']/iu);
  assert.match(html, /<meta\b[^>]*\bname=["']description["']/iu);
  assert.ok(html.includes("ARTS Robotics AI Assistant"));
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

test("frontend answer formatting hides citations without truncating ordinary source-like words", async () => {
  const format = await frontendAnswerFormatter();
  assert.equal(format("事实[1]。另一个事实。【１—２】"), "事实。另一个事实。");
  assert.equal(format("回答。[1]\n\n> 参考资料\n[1] OA"), "回答。");
  assert.equal(format("Answer.[1]\n\nBibliography:\n[1] OA"), "Answer.");
  assert.equal(format("回答。[1]\n\n参考：\n[1] OA"), "回答。");
  assert.equal(format("回答。[1]\n\n出处：\n[1] OA"), "回答。");
  assert.equal(format("Answer.[1]\n\nCitation:\n[1] OA"), "Answer.");
  assert.equal(format("Answer.[1]\n\nSources [1] OA"), "Answer.");
  assert.equal(format("回答。[1]\n\n[1] OA 标题\n[2] 第二标题"), "回答。");
  assert.equal(format("回答。[1]\n\n• [1] OA 标题"), "回答。");
  assert.equal(format("回答。[1]\n[1] OA 标题"), "回答。");
  assert.equal(format("Available Resources: robotics lab.[1]"), "Available Resources: robotics lab.");
  assert.equal(format("Preference: concise answers.[1]"), "Preference: concise answers.");
  assert.equal(format("open-source: selected components are public.[1]"), "open-source: selected components are public.");
  assert.equal(format("回答。[1] 可参考资料：[1] OA"), "暂时没有可显示的回答。");
  assert.equal(format("回答。[1] 可查看**参考资料**：[1] OA"), "暂时没有可显示的回答。");
  assert.equal(format("回答。[1] 嵌套标记 [[1]]"), "暂时没有可显示的回答。");
});

test("text imports use normalized fatal UTF-8 decoding and a five MiB byte cap", async () => {
  const helpers = await frontendImportHelpers();
  assert.equal(helpers.MAX_TEXT_IMPORT_BYTES, 5 * 1024 * 1024);
  assert.equal(helpers.CHAT_DIRECT_OA_THRESHOLD_CHARACTERS, 30_000);
  assert.equal(helpers.MAX_OA_STORAGE_FRAGMENT_CHARACTERS, 20_000);
  assert.equal(helpers.normalizeImportedText("\uFEFFＡ\r\nB\rC\u0000\u0007"), "A\nB\nC");
  assert.equal(helpers.decodeImportedUtf8(new TextEncoder().encode("\uFEFFＭＤ\r\n正文")), "MD\n正文");
  assert.throws(
    () => helpers.decodeImportedUtf8(Uint8Array.from([0xc3, 0x28])),
    /必须使用有效的 UTF-8 编码/u,
  );
  assert.equal(helpers.utf8ByteLength("中"), 3);
  assert.equal(helpers.estimatedOaStorageFragmentCount("a".repeat(40_001)), 3);

  const current = helpers.oaImportReceipt({ item: { id: "one", status: "pending" }, partCount: 7 }, "short body");
  assert.equal(current.items.length, 1);
  assert.equal(current.items[0].id, "one");
  assert.equal(current.partCount, 7);
  const legacy = helpers.oaImportReceipt({ items: [{ contentPartCount: 2 }, { contentPartCount: 3 }] }, "short body");
  assert.equal(legacy.items.length, 2);
  assert.equal(legacy.partCount, 5);

  const returnedId = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
  assert.equal(helpers.returnedKnowledgeItemIdFromSearch(`?returnedKnowledgeItem=${returnedId}`), returnedId.toLowerCase());
  assert.equal(helpers.returnedKnowledgeItemIdFromSearch("?returnedKnowledgeItem=not-an-id"), "");
  assert.equal(helpers.returnedKnowledgeItemIdFromSearch(`?returnedKnowledgeItem=${returnedId}&returnedKnowledgeItem=${returnedId}`), "");
  assert.equal(
    helpers.withoutReturnedKnowledgeItemQuery(`https://chat.omindos.ai/manage?keep=1&returnedKnowledgeItem=${returnedId}#upload`),
    "/manage?keep=1#upload",
  );
});

test("returned-import context survives failure and is cleared only after OA acknowledges the revision", async () => {
  const failed = await frontendReturnedImportHarness({ ok: false, payload: { error: "暂时失败" } });
  await assert.rejects(() => failed.api.submitDocumentToOa(failed.draft, {
    retainedAsChatDraft: false,
    submissionContext: { returnedKnowledgeItemId: failed.state.returnedKnowledgeItemId },
  }), /暂时失败/u);
  assert.equal(failed.state.returnedKnowledgeItemId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(failed.calls.replacedUrl, "");
  assert.equal(failed.calls.request.returnedKnowledgeItemId, failed.state.returnedKnowledgeItemId);

  const succeeded = await frontendReturnedImportHarness({
    ok: true,
    payload: { item: { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", status: "pending" }, partCount: 3 },
  });
  await succeeded.api.submitDocumentToOa(succeeded.draft, {
    retainedAsChatDraft: false,
    submissionContext: { returnedKnowledgeItemId: succeeded.state.returnedKnowledgeItemId },
  });
  assert.equal(succeeded.calls.request.returnedKnowledgeItemId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(succeeded.state.returnedKnowledgeItemId, "");
  assert.equal(succeeded.calls.replacedUrl, "/manage?keep=1#upload");
  assert.match(succeeded.state.notice, /更新原 OA 条目并重新进入待审核状态/u);
});

test("local drafts never inherit an unrelated returned-import context", async () => {
  const oaItemId = "22222222-3333-4444-8555-666666666666";
  const local = await frontendReturnedImportHarness({
    ok: true,
    payload: { item: { id: oaItemId, status: "pending" }, partCount: 1 },
  });
  await local.api.submitDocumentToOa(local.draft);
  assert.equal(local.calls.requestUrl, "https://oa.omindos.ai/api/knowledge/import-chat");
  assert.equal(Object.hasOwn(local.calls.request, "returnedKnowledgeItemId"), false);
  assert.equal(local.calls.adminRequests.length, 2);
  assert.deepEqual(local.calls.adminRequests[0], {
    endpoint: "documents",
    method: "PATCH",
    body: {
      id: local.draft.id,
      draftRevision: local.draft.draftRevision,
      submissionState: "unknown",
    },
  });
  assert.deepEqual(local.calls.adminRequests[1], {
    endpoint: "documents",
    method: "PATCH",
    body: {
      id: local.draft.id,
      draftRevision: local.draft.draftRevision,
      submissionState: "submitted",
      oaItemId,
    },
  });
  assert.deepEqual(local.calls.events, ["chat:unknown", "oa:import", "chat:submitted"]);
  assert.equal(local.state.documents[0].oaSubmissionState, "submitted");
  assert.equal(local.state.documents[0].oaItemId, oaItemId);
  assert.equal(local.state.returnedKnowledgeItemId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(local.calls.replacedUrl, "");

  const invalid = await frontendReturnedImportHarness({
    ok: true,
    payload: { item: { id: oaItemId, status: "pending" }, partCount: 1 },
  });
  await assert.rejects(
    () => invalid.api.submitDocumentToOa(invalid.draft, {
      submissionContext: { returnedKnowledgeItemId: "not-an-id" },
    }),
    /退回资料上下文无效/u,
  );
  assert.equal(invalid.calls.request, null);
  assert.equal(invalid.calls.adminRequests.length, 0);
});

test("a failed final Chat PATCH leaves the draft unknown and starts OA reconciliation", async () => {
  const uncertain = await frontendReturnedImportHarness({
    ok: true,
    payload: {
      item: { id: "22222222-3333-4444-8555-666666666666", status: "pending" },
      partCount: 1,
    },
    returnedKnowledgeItemId: "",
    failSubmittedPatchCount: 1,
    deferStatus: true,
  });

  await assert.rejects(
    () => uncertain.api.submitDocumentToOa(uncertain.draft),
    /OA 已接收，但 Chat 未能保存提交状态/u,
  );
  assert.deepEqual(uncertain.calls.events, [
    "chat:unknown",
    "oa:import",
    "chat:submitted",
    "oa:status",
  ]);
  assert.equal(uncertain.calls.importRequests.length, 1);
  assert.equal(uncertain.calls.statusRequests.length, 1);
  assert.equal(uncertain.state.documents[0].oaSubmissionState, "unknown");
  assert.equal(uncertain.state.oaStatusSyncRequired, true);
  assert.equal(uncertain.state.oaStatusSyncing, true);
});

test("initial admin loading starts legacy OA reconciliation without awaiting it", async () => {
  const legacy = await frontendReturnedImportHarness({
    ok: true,
    payload: {},
    returnedKnowledgeItemId: "",
    initialOaSubmissionState: "unknown",
    deferStatus: true,
  });

  await legacy.api.fetchAdminData(true);
  assert.equal(legacy.state.initialized, true);
  assert.equal(legacy.calls.statusRequests.length, 1);
  assert.equal(legacy.state.oaStatusSyncing, true);

  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  const start = script.indexOf("async function fetchAdminData");
  const end = script.indexOf("async function runAdminAction", start);
  const fetchAdminDataSource = script.slice(start, end);
  assert.match(fetchAdminDataSource, /void reconcileUnknownDocumentStatuses\(\)/u);
  assert.doesNotMatch(fetchAdminDataSource, /await reconcileUnknownDocumentStatuses\(\)/u);
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
  for (const endpoint of ["config", "test", "oa-test", "extract", "documents", "inquiries"]) {
    assert.match(script, new RegExp(`adminRequest\\(["']${endpoint}["']`, "u"), endpoint);
  }
  assert.match(script, /(?:window\.)?location\.pathname\s*===?\s*["']\/manage["']/u);
  assert.match(script, /\bconst\s+APP_NAME\s*=\s*["']ARTS Robotics AI Assistant["']\s*;/u);
  for (const section of [
    "技术成果与产业化",
    "科研合作与学术交流",
    "源灵智能科技有限公司",
    "智能无人系统创新协会",
  ]) {
    assert.ok(script.includes(section), section);
  }
  for (const question of [
    "四足巡检机器人最近有什么新进展？",
    "最近公开了哪些机器人技术成果？",
    "ARTS Robotics 最近公开了哪些研究成果？",
    "近期有哪些新的科研合作与交流？",
    "新上线的四个 AI 模块有什么区别？",
    "OmindOS 最近新增了哪些能力？",
    "IUS 最近有哪些活动或项目？",
    "近期开放了哪些学生创新机会？",
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
  assert.ok(script.includes(".txt,.md,.pdf,.jpg,.jpeg,.png,.webp"));
  assert.ok(script.includes("PDF、扫描件和图片"));
  assert.ok(script.includes("发送至 Cloudflare AI 临时解析"));
  assert.ok(script.includes("本站不保存原件"));
  assert.ok(script.includes("解析正文不设 30000 字上限"));
  assert.ok(script.includes("TXT、Markdown 单个文件最多 5 MB"));
  assert.ok(script.includes("1.6 MB 文件可以直接导入"));
  assert.ok(script.includes("OA 作为 1 条资料统一审核"));
  assert.ok(script.includes("每个不超过 20000 字"));
  assert.ok(script.includes("OA 接收成功后才清空"));
  assert.ok(script.includes("导入新文件将替换当前正文"));
  assert.ok(script.includes("请重新上传修改后的完整文件"));
  assert.ok(script.includes("成功提交后会更新原条目并保留审计链"));
  assert.ok(script.includes("本次仅替换正文，标题、分类、资料日期、来源链接和可见范围沿用原 OA 条目"));
  for (const control of ["title.input", "category", "date.input", "url.input", "body"]) {
    assert.match(script, new RegExp(`${control.replace(".", "\\.")}\\.disabled\\s*=\\s*Boolean\\(state\\.busy\\)`, "u"));
  }
  assert.match(script, /\.slice\(0,\s*120\)/u);
  assert.match(script, /focusImportedField\(imported\s*\?\s*["']document-body["']\s*:\s*["']document-file["']\)/u);
  assert.match(script, /adminRequest\(["']extract["'][\s\S]*?body:\s*file/u);
  assert.match(script, /"X-File-Name":\s*encodeURIComponent\(file\.name\)/u);
  assert.match(script, /new TextDecoder\(["']utf-8["'],\s*\{\s*fatal:\s*true\s*\}\)/u);
  assert.match(script, /decodeImportedUtf8\(await file\.arrayBuffer\(\)\)/u);
  assert.doesNotMatch(script, /await file\.text\(\)/u);
  assert.doesNotMatch(script, /!isText\s*&&\s*text\.length\s*>\s*CHAT_DIRECT_OA_THRESHOLD_CHARACTERS/u);
  assert.doesNotMatch(script, /id:\s*["']document-body["'][\s\S]{0,160}maxlength:\s*["']30000["']/u);
  assert.match(script, /signal:\s*AbortSignal\.timeout\(120_000\)/u);
  assert.match(script, /submissionRequestId:\s*["']["']/u);
  assert.doesNotMatch(script, /每条资料最多 30000 字/u);
  assert.match(script, /if \(!returnedKnowledgeItemId && state\.draft\.id && normalizedBody\.length > CHAT_DIRECT_OA_THRESHOLD_CHARACTERS\)[\s\S]*?已有 Chat 草稿不能直接改为大型正文/u);
  assert.match(script, /const id = state\.draft\.id \|\| state\.draft\.submissionRequestId \|\| makeRequestId\(\)/u);
  assert.match(script, /state\.draft\.submissionRequestId = id/u);
  assert.match(script, /await submitDocumentToOa\(\{ \.\.\.state\.draft, id \}, \{[\s\S]*?submissionContext: \{ returnedKnowledgeItemId \}[\s\S]*?\}\);[\s\S]*?state\.draft = emptyDraft\(\)/u);
  assert.match(script, /if \(returnedKnowledgeItemId \|\| normalizedBody\.length > CHAT_DIRECT_OA_THRESHOLD_CHARACTERS\)[\s\S]*?await submitDocumentToOa[\s\S]*?return;[\s\S]*?adminRequest\("documents"/u);
  const directSubmitStart = script.indexOf("if (returnedKnowledgeItemId || normalizedBody.length > CHAT_DIRECT_OA_THRESHOLD_CHARACTERS)");
  const directSubmitEnd = script.indexOf("const draft = { ...state.draft }", directSubmitStart);
  assert.ok(directSubmitStart >= 0 && directSubmitEnd > directSubmitStart);
  assert.doesNotMatch(script.slice(directSubmitStart, directSubmitEnd), /state\.draft\.id\s*=\s*id/u);
  const submitToOa = script.slice(script.indexOf("async function submitDocumentToOa"), script.indexOf("async function lookupDocumentSubmissionState"));
  assert.doesNotMatch(submitToOa, /state\.returnedKnowledgeItemId/u);
  assert.match(submitToOa, /\.\.\.\(returnedKnowledgeItemId \? \{ returnedKnowledgeItemId \} : \{\}\)/u);
  const checkpointIndex = submitToOa.indexOf('submissionState: "unknown"');
  const oaPostIndex = submitToOa.indexOf("fetch(OA_CHAT_IMPORT_URL");
  assert.ok(checkpointIndex >= 0 && oaPostIndex > checkpointIndex);
  assert.match(script, /Promise\.allSettled\(unknown\.slice\(index, index \+ 5\)\.map\(lookupDocumentSubmissionState\)\)/u);
  assert.match(script, /if \(state\.oaStatusSyncing\)[\s\S]*?state\.oaStatusSyncQueued = true/u);
  assert.match(script, /if \(rerun && !state\.returnedKnowledgeItemId\) void reconcileUnknownDocumentStatuses\(\)/u);
  assert.equal(submitToOa.match(/clearReturnedKnowledgeContext\(returnedKnowledgeItemId\)/gu)?.length, 1);
  assert.ok(submitToOa.indexOf("clearReturnedKnowledgeContext(returnedKnowledgeItemId)") > submitToOa.indexOf("const oaItemId"));
  assert.match(script, /state\.returnedKnowledgeItemId = "";[\s\S]*?history\.replaceState[\s\S]*?withoutReturnedKnowledgeItemQuery/u);
  assert.match(script, /if \(state\.returnedKnowledgeItemId\) \{[\s\S]*?本地草稿已暂时隐藏，不能编辑或提交[\s\S]*?\} else if \(!state\.documents\.length\)/u);
  assert.match(script, /submitDocumentToOa\(document\)\);/u);
  const externalApis = [...script.matchAll(/https?:\/\/[^\s"'`]+\/api\/[^\s"'`]+/giu)].map((match) => match[0]);
  assert.deepEqual(externalApis, [
    "https://oa.omindos.ai/api/knowledge/import-chat",
    "https://oa.omindos.ai/api/knowledge/import-chat/status",
  ]);

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

test("document rows show exact persisted OA labels and submit only unsubmitted drafts", async () => {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  const start = script.indexOf("function renderDocumentsPanel");
  const end = script.indexOf("function parseTranscript", start);
  assert.ok(start >= 0 && end > start, "document panel must remain directly testable");
  const panel = script.slice(start, end);

  assert.match(
    panel,
    /const submissionLabel = submissionState === "submitted"\s*\? "OA 待审核"\s*: submissionState === "unsubmitted"\s*\? "待提交 OA 审核"/u,
  );
  assert.equal((panel.match(/["']OA 待审核["']/gu) || []).length, 1);
  assert.equal((panel.match(/["']待提交 OA 审核["']/gu) || []).length, 1);

  const guardStart = panel.indexOf('if (submissionState === "unsubmitted")');
  const otherStateStart = panel.indexOf("} else {", guardStart);
  const rowBodyStart = panel.indexOf("const documentBody", otherStateStart);
  assert.ok(guardStart >= 0 && otherStateStart > guardStart && rowBodyStart > otherStateStart);
  const unsubmittedActions = panel.slice(guardStart, otherStateStart);
  const otherStateActions = panel.slice(otherStateStart, rowBodyStart);
  assert.match(unsubmittedActions, /textButton\([^)]*"提交 OA 待审"/u);
  assert.match(unsubmittedActions, /submitDocumentToOa\(document\)/u);
  assert.doesNotMatch(otherStateActions, /提交 OA 待审|submitDocumentToOa\(document\)/u);
  assert.equal((panel.match(/submitDocumentToOa\(document\)/gu) || []).length, 1);
});

test("public topics keep independent view state without a duplicate welcome avatar", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);

  assert.match(script, /sessions:\s*Object\.fromEntries\(TOPICS\.map/u);
  assert.match(script, /function\s+sessionFor\s*\(/u);
  assert.match(script, /function\s+saveCurrentView\s*\(/u);
  for (const field of ["messages", "conversationToken", "draft", "scrollTop", "stickToEnd", "sending", "error", "notice"]) {
    assert.match(script, new RegExp(`\\b${field}:`, "u"), field);
  }
  assert.doesNotMatch(script, /className:\s*["']welcome-mark["']/u);
  assert.doesNotMatch(style, /\.welcome-mark\b/u);
});

test("public chat keeps a minimal topic header and compact message composer", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);

  assert.match(script, /className:\s*["']topic-title["']/u);
  assert.match(script, /textButton\(["']["'],\s*["']menu-button["']\)/u);
  assert.match(script, /rows:\s*["']1["']/u);
  assert.match(script, /placeholder:\s*["']输入消息["']/u);
  assert.match(script, /textButton\(["']发送["'],\s*["']send-button["']\)/u);
  assert.match(script, /className:\s*["']composer-suggestions["']/u);
  assert.match(script, /className:\s*["']suggestion-title["'],\s*text:\s*["']聊聊新话题["']/u);
  assert.match(script, /composerArea\.append\(errorRegion,\s*noticeRegion,\s*suggestionPanel,\s*composer\)/u);
  assert.match(script, /suggestionPanel\.hidden\s*=\s*session\.messages\.length\s*>\s*0/u);
  assert.match(script, /function\s+suggestionsForTopic\s*\(/u);
  assert.match(script, /selected\.length\s*===\s*2/u);
  assert.doesNotMatch(script, /className:\s*["']suggestion-arrow["']/u);
  for (const removedClass of ["context-panel", "conversation-toolbar", "composer-footer", "site-footer", "topic-select"]) {
    assert.doesNotMatch(script, new RegExp(`className:\\s*["']${removedClass}["']`, "u"), removedClass);
  }
  for (const removedCopy of [
    "从一个问题，走近机器人研究。",
    "机器人自主自动与操作实验室",
    "AI 回答仅供参考，不构成 ARTS Robotics",
    "OriginMind x ARTS Robotics",
  ]) {
    assert.equal(script.includes(removedCopy), false, removedCopy);
  }
  assert.match(style, /\.chat-app\s+\.composer\s*\{[\s\S]*?display:\s*flex/u);
  assert.match(style, /\.chat-app\s+\.composer-suggestions\s*\{[\s\S]*?padding:\s*0 2px 10px/u);
  assert.match(style, /\.chat-app\s+\.suggestion-button\s*\{[\s\S]*?min-height:\s*44px[\s\S]*?border-radius:\s*15px/u);
  assert.match(style, /\.chat-app\s+:focus-visible\s*\{[\s\S]*?outline-color:\s*#0b57d0/u);
  assert.match(style, /\.chat-app\s+\.composer\s+textarea:focus-visible\s*\{[\s\S]*?outline:\s*3px solid #0b57d0/u);
  assert.match(style, /\.chat-app\s+\.composer\s+textarea\s*\{[\s\S]*?min-height:\s*44px[\s\S]*?font-size:\s*16px/u);
  assert.match(style, /\.chat-app\s+\.send-button\s*\{[\s\S]*?height:\s*44px/u);
  assert.ok(script.includes('document.body.classList.add("public-chat-page")'));
  assert.ok(script.includes("window.visualViewport"));
  assert.ok(script.includes('app.style.setProperty("--chat-viewport-height"'));
  assert.ok(script.includes('app.style.setProperty("--chat-viewport-offset"'));
  assert.match(style, /body\.public-chat-page\s*\{[\s\S]*?overflow:\s*hidden/u);
  assert.match(style, /\.chat-app\s*\{[\s\S]*?height:\s*var\(--chat-viewport-height,\s*100dvh\)[\s\S]*?transform:\s*translateY\(var\(--chat-viewport-offset,\s*0px\)\)/u);
  assert.match(script, /function\s+userFacingAnswer\s*\(/u);
  assert.match(script, /content:\s*userFacingAnswer\(payload\.answer\)/u);
  assert.doesNotMatch(script, /className:\s*["']source-(?:list|button|dialog)["']/u);
  assert.doesNotMatch(style, /\.source-(?:list|button|dialog)\b/u);
});

test("public chat keeps five compact live status lights below the fixed header title", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);

  for (const [key, label] of [
    ["network", "网络"],
    ["oa", "OA"],
    ["qwen", "千问"],
    ["knowledge", "知识"],
    ["system", "系统"],
  ]) {
    assert.match(script, new RegExp(`key:\\s*["']${key}["']\\s*,\\s*label:\\s*["']${label}["']`, "u"), key);
  }
  assert.match(script, /className:\s*["']topic-header["'][\s\S]{0,160}?\[\s*topicTitle,\s*systemStatus,/u);
  assert.match(script, /header\.append\(menuButton,\s*topicHeader,\s*chatInfoButton/u);
  assert.match(script, /SYSTEM_STATUS_REFRESH_MS\s*=\s*60_000/u);
  assert.match(script, /fetch\(["']\/_health["']/u);
  assert.match(script, /requestJson\(["']\/api\/status["']/u);
  assert.match(script, /service\.systemReady\s*===\s*true/u);
  assert.match(script, /textButton\(\s*["']["']\s*,\s*["']system-status-strip["']\s*\)/u);
  assert.ok(script.includes('systemStatus.setAttribute("aria-controls", "system-status-details")'));
  assert.ok(script.includes('systemStatus.setAttribute("aria-expanded", "false")'));
  assert.match(script, /id:\s*["']system-status-details["'][\s\S]{0,180}?role:\s*["']region["']/u);
  assert.match(script, /systemStatusAnnouncement[\s\S]{0,220}?role:\s*["']status["'][\s\S]{0,120}?["']aria-live["']:\s*["']polite["']/u);
  assert.match(script, /nodes\.panelDetail\.textContent\s*=\s*detail/u);
  assert.match(script, /systemStatusAnnouncement\.textContent\s*=\s*description/u);
  assert.match(style, /\.system-status-strip\s*\{[\s\S]*?height:\s*24px/u);
  assert.match(style, /\.system-status-details\s*\{[\s\S]*?position:\s*absolute/u);
  assert.match(style, /\.chat-app\s+\.site-header\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\)/u);
  assert.match(style, /\.system-light-dot\.is-ok\s*\{[\s\S]*?background:\s*#067a3d/u);
});

test("public modules expose direct links with history navigation and an accessible topic drawer", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);
  const mappings = [
    ["technology", "/technology", "research"],
    ["academic", "/research", "research"],
    ["company", "/originmind", "business"],
    ["association", "/ius", "student"],
  ];
  for (const [id, directPath, requestTopic] of mappings) {
    assert.match(
      script,
      new RegExp(`id:\\s*["']${id}["'][\\s\\S]*?path:\\s*["']${directPath}["'][\\s\\S]*?requestTopic:\\s*["']${requestTopic}["']`, "u"),
      directPath,
    );
  }
  assert.match(script, /section:\s*topicIdForPath\(window\.location\.pathname\)/u);
  assert.match(script, /window\.history\.pushState\(/u);
  assert.match(script, /window\.addEventListener\(["']popstate["']/u);
  assert.match(script, /className:\s*["']drawer-topic-link["'][\s\S]*?href:\s*topic\.path/u);
  assert.ok(script.includes('menuButton.setAttribute("aria-controls", "topic-drawer")'));
  assert.ok(script.includes('menuButton.setAttribute("aria-expanded", "false")'));
  assert.ok(script.includes("topicDrawer.showModal()"));
  assert.ok(script.includes('topicDrawer.addEventListener("close"'));
  assert.match(style, /\.topic-drawer\s*\{[\s\S]*?position:\s*fixed/u);
  assert.match(style, /\.drawer-topic-link\s*\{[\s\S]*?min-height:\s*54px/u);
  assert.match(style, /\.drawer-panel\s*\{[\s\S]*?width:\s*min\(86vw,\s*340px\)/u);
});

test("public chat exposes an accessible full-screen chat information surface", async () => {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");

  assert.match(script, /textButton\(\s*["']["']\s*,\s*["']chat-info-button["']\s*\)/u);
  assert.ok(script.includes('chatInfoButton.setAttribute("aria-label", "聊天信息")'));
  assert.ok(script.includes('chatInfoButton.setAttribute("aria-controls", "chat-info-dialog")'));
  assert.ok(script.includes('chatInfoButton.setAttribute("aria-haspopup", "dialog")'));
  assert.ok(script.includes('chatInfoButton.setAttribute("aria-expanded", "false")'));
  assert.ok(script.includes('chatInfoButton.setAttribute("aria-expanded", "true")'));
  assert.match(script, /className:\s*["']more-glyph["'][\s\S]{0,500}?className:\s*["']more-dot["']/u);
  assert.equal((script.match(/className:\s*["']more-dot["']/gu) || []).length, 3);

  assert.match(script, /const\s+chatInfoDialog\s*=\s*element\(\s*["']dialog["']/u);
  assert.match(script, /\bid:\s*["']chat-info-dialog["']/u);
  assert.match(script, /\bclassName:\s*["']chat-info-dialog["']/u);
  assert.match(script, /element\(\s*["']h2["'][\s\S]{0,180}?\btext:\s*["']聊天信息["']/u);
  for (const label of ["查找聊天记录", "清空聊天记录"]) {
    assert.ok(script.includes(label), label);
  }
  for (const label of ["查找聊天记录", "清空聊天记录"]) {
    assert.match(script, new RegExp(`chatInfoActionRow\\(\\s*["']${label}["']`, "u"), label);
  }
  assert.match(script, /\bsrc:\s*["']\/favicon\.svg["']/u);

  assert.match(script, /function\s+openChatInfo\s*\([^)]*\)\s*\{[\s\S]{0,700}?chatInfoDialog\.showModal\(\)/u);
  assert.match(script, /function\s+closeChatInfo\s*\([^)]*\)\s*\{[\s\S]{0,500}?chatInfoDialog\.close\(\)/u);
  assert.ok(script.includes('chatInfoDialog.addEventListener("cancel"'));
  assert.match(
    script,
    /chatInfoDialog\.addEventListener\(\s*["']close["'][\s\S]{0,600}?chatInfoDialogOpener[\s\S]{0,400}?\.focus\(/u,
  );
  assert.match(script, /function\s+findChatMessage\s*\(/u);
  assert.match(script, /window\.prompt\(\s*["']查找聊天记录["']/u);
  assert.match(
    script,
    /chatInfoActionRow\(\s*["']清空聊天记录["']\s*,\s*\(\)\s*=>\s*\{[\s\S]{0,500}?window\.confirm\([^)]*清空当前聊天记录[^)]*\)[\s\S]{0,500}?resetCurrentConversation\(/u,
  );
});

test("chat information omits unavailable placeholder controls", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);

  for (const removedCopy of [
    "暂未开放",
    "添加成员",
    "消息免打扰",
    "置顶聊天",
    "提醒",
    "设置当前聊天背景",
    "投诉",
  ]) {
    assert.equal(script.includes(removedCopy), false, removedCopy);
  }
  assert.doesNotMatch(script, /chatInfo(?:Unavailable|Add)|chat-info-(?:unavailable|toggle|switch|add)/u);
  assert.doesNotMatch(style, /\.chat-info-(?:unavailable|toggle|switch|add)\b/u);
});

test("chat record search moves focus and marks the matching message semantically", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);

  assert.match(script, /className:\s*`message \$\{message\.role\}`[\s\S]{0,220}?tabindex:\s*["']-1["']/u);
  assert.match(script, /closeChatInfo\(\{\s*restoreFocus:\s*false\s*\}\)/u);
  assert.match(script, /match\.setAttribute\(\s*["']aria-current["']\s*,\s*["']true["']\s*\)/u);
  assert.match(script, /聊天记录搜索结果：\$\{originalLabel\}/u);
  assert.match(script, /match\.focus\(\{\s*preventScroll:\s*true\s*\}\)/u);
  assert.match(script, /match\.removeAttribute\(\s*["']aria-current["']\s*\)/u);
  assert.match(script, /data-search-original-label/u);
  assert.match(style, /\.message\.search-match\s+\.message-body\s*\{[\s\S]*?outline:\s*3px solid #9a6500/u);
});

test("chat information styles preserve the Tencent mobile geometry", async () => {
  const style = await readFile(path.join(frontendDir, "styles.css"), "utf8");
  const rule = (selector) => {
    const match = style.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "u"));
    assert.ok(match, selector);
    return match[1];
  };

  const button = rule("\\.chat-info-button");
  assert.match(button, /justify-self:\s*end/u);

  const dialog = rule("#chat-info-dialog\\.chat-info-dialog");
  for (const declaration of [
    /position:\s*fixed/u,
    /inset:\s*0/u,
    /height:\s*var\(--chat-viewport-height,\s*100dvh\)/u,
    /max-height:\s*var\(--chat-viewport-height,\s*100dvh\)/u,
    /width:\s*min\(100%,\s*960px\)/u,
    /border-radius:\s*0/u,
    /background:\s*#ededed\b/iu,
  ]) {
    assert.match(dialog, declaration);
  }

  const header = rule("\\.chat-info-header");
  assert.match(header, /position:\s*sticky/u);
  assert.match(header, /env\(safe-area-inset-top\)/u);
  assert.match(header, /env\(safe-area-inset-right\)/u);
  assert.match(header, /env\(safe-area-inset-left\)/u);
  assert.match(rule("\\.chat-info-scroll"), /env\(safe-area-inset-bottom\)/u);
  assert.match(rule("\\.chat-info-block"), /background:\s*#fff(?:fff)?\b/iu);

  const row = rule("\\.chat-info-row");
  assert.match(row, /min-height:\s*56px/u);

  const members = rule("\\.chat-info-members");
  assert.match(members, /min-height:\s*96px/u);
  assert.match(members, /margin-top:\s*8px/u);
  assert.match(members, /padding:\s*16px/u);
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
