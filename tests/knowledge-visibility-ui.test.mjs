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
  assert.match(source, /visibility === "public" \? \{ publicConfirmation: confirmation \} : \{\}/u);
});

test("requires the exact second confirmation before publishing knowledge", async () => {
  const source = await readFile(path.join(root, "components/knowledge/knowledge-view.tsx"), "utf8");

  assert.match(source, /PUBLIC_KNOWLEDGE_CONFIRMATION[\s\S]*?from "@\/lib\/knowledge-policy"/u);
  assert.match(source, /publicConfirmation === PUBLIC_KNOWLEDGE_CONFIRMATION/u);
  assert.match(source, /confirmation !== PUBLIC_KNOWLEDGE_CONFIRMATION/u);
  assert.doesNotMatch(source, /confirmation\.trim\(\)\s*!==\s*PUBLIC_KNOWLEDGE_CONFIRMATION/u);
  assert.match(source, /公开批准后，该知识仍可在 OA 内检索，并将同时供 chat\.omindos\.ai 对外检索/u);
});

test("explains the internal OA and public Ma Professor assistant split", async () => {
  const [knowledgeSource, guideSource, pageSource] = await Promise.all([
    readFile(path.join(root, "components/knowledge/knowledge-view.tsx"), "utf8"),
    readFile(path.join(root, "app/guide/page.tsx"), "utf8"),
    readFile(path.join(root, "app/page.tsx"), "utf8"),
  ]);

  assert.match(knowledgeSource, /对内：在 OA 里面问/u);
  assert.match(knowledgeSource, /马教授 AI 助手升级版/u);
  assert.match(knowledgeSource, /https:\/\/chat\.omindos\.ai/u);
  assert.match(guideSource, /对外公开必须再次输入指定确认文字/u);
  assert.match(guideSource, /公众无需 OA 登录/u);
  assert.match(pageSource, /<h1>请登录账号<\/h1>/u);
  assert.match(pageSource, /实验室 AI 仅在登录并完成 OA 准入与保密签署后显示/u);
});

test("labels legacy approved events as internal and names both new audit events", async () => {
  const source = await readFile(path.join(root, "components/knowledge/knowledge-view.tsx"), "utf8");

  assert.match(source, /approved: "审核入库（仅 OA 内部）"/u);
  assert.match(source, /approved_internal: "批准为仅 OA 内部"/u);
  assert.match(source, /approved_public: "批准为对外公开"/u);
});
