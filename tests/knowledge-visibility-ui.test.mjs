import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("requires reviewers to choose internal or public before approving knowledge", async () => {
  const source = await readFile(path.join(root, "components/knowledge/knowledge-view.tsx"), "utf8");

  assert.match(source, /KnowledgeVisibility,[\s\S]*?from "@\/lib\/knowledge-types"/u);
  assert.match(source, /value="internal"[\s\S]*?>对内</u);
  assert.match(source, /value="public"[\s\S]*?>对外公开</u);
  assert.match(source, /if \(item\.status !== "active" && item\.status !== "revoked"\) return undefined/u);
  assert.match(source, /const canApprove = canAct && Boolean\(visibility\)/u);
  assert.match(source, /body: JSON\.stringify\(\{ action, mutationRevision:[\s\S]*?\.\.\.approvalScope \}\)/u);
  assert.match(source, /visibility === "public" && knowledgeVisibility\(reviewDetail\.item\) !== "public" \? \{ publicConfirmation: confirmation \} : \{\}/u);
});

test("requires the exact second confirmation before publishing knowledge", async () => {
  const source = await readFile(path.join(root, "components/knowledge/knowledge-view.tsx"), "utf8");

  assert.match(source, /PUBLIC_KNOWLEDGE_CONFIRMATION[\s\S]*?from "@\/lib\/knowledge-policy"/u);
  assert.match(source, /publicConfirmation === PUBLIC_KNOWLEDGE_CONFIRMATION/u);
  assert.match(source, /confirmation !== PUBLIC_KNOWLEDGE_CONFIRMATION/u);
  assert.doesNotMatch(source, /confirmation\.trim\(\)\s*!==\s*PUBLIC_KNOWLEDGE_CONFIRMATION/u);
  assert.match(source, /设为公开后，该知识仍可在 OA 内检索，并将同时供 chat\.omindos\.ai 对外检索/u);
});

test("explains the internal OA and public ARTS Robotics assistant split", async () => {
  const [knowledgeSource, guideSource, pageSource] = await Promise.all([
    readFile(path.join(root, "components/knowledge/knowledge-view.tsx"), "utf8"),
    readFile(path.join(root, "app/guide/page.tsx"), "utf8"),
    readFile(path.join(root, "app/page.tsx"), "utf8"),
  ]);

  assert.match(knowledgeSource, /对内：在 OA 里面问/u);
  assert.match(knowledgeSource, /ARTS Robotics AI assistant/u);
  assert.match(knowledgeSource, /https:\/\/chat\.omindos\.ai/u);
  assert.match(guideSource, /对外公开必须再次输入指定确认文字/u);
  assert.match(guideSource, /公众无需 OA 登录/u);
  assert.match(guideSource, /OA 管理员可以批准本人提交的知识；项目负责人仍需回避自己的投稿/u);
  assert.match(pageSource, /<h1>请登录账号<\/h1>/u);
  assert.match(pageSource, /实验室 AI 仅在登录并完成 OA 准入与保密签署后显示/u);
});

test("lets authorized reviewers reclassify active knowledge with the same public confirmation guard", async () => {
  const source = await readFile(path.join(root, "components/knowledge/knowledge-view.tsx"), "utf8");

  assert.match(source, /查看并调整范围/u);
  assert.match(source, /detail\.item\.status === "active" && detail\.item\.canSetVisibility/u);
  assert.match(source, /item\.status === "active" && item\.canRevoke/u);
  assert.match(source, /detail\?\.item\.canReject !== false/u);
  assert.match(source, /detail\?\.item\.canReturn !== false/u);
  assert.match(source, /onAction\("set_visibility", visibility \|\| undefined/u);
  assert.match(source, /action === "set_visibility"[\s\S]*?visibility === "public"[\s\S]*?PUBLIC_KNOWLEDGE_CONFIRMATION/u);
  assert.match(source, /visibility_changed_internal: "调整为仅 OA 内部"/u);
  assert.match(source, /visibility_changed_public: "调整为对外公开"/u);

  const guideSource = await readFile(path.join(root, "app/guide/page.tsx"), "utf8");
  assert.match(guideSource, /已入库知识可在“知识库管理”中重新调整范围/u);
});

test("labels legacy approved events as internal and names both new audit events", async () => {
  const source = await readFile(path.join(root, "components/knowledge/knowledge-view.tsx"), "utf8");

  assert.match(source, /approved: "审核入库（仅 OA 内部）"/u);
  assert.match(source, /approved_internal: "批准为仅 OA 内部"/u);
  assert.match(source, /approved_public: "批准为对外公开"/u);
});
