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

test("presents multipart Chat imports as one file with one review action", async () => {
  const source = await readFile(path.join(root, "components/knowledge/knowledge-view.tsx"), "utf8");

  assert.match(source, /if \(!item\.contentPartCount \|\| item\.contentPartCount <= 1\) return null/u);
  assert.match(source, /1 个文件 · \{item\.contentPartCount\} 个正文分片 · 统一审核/u);
  assert.match(source, /<KnowledgeMultipartReviewMeta item=\{item\} \/>/u);
  assert.match(source, /<KnowledgeMultipartReviewMeta item=\{detail\.item\} \/>/u);

  const reviewFunction = source.slice(source.indexOf("const performReview"), source.indexOf("const performRevoke"));
  assert.equal(reviewFunction.match(/method: "PATCH"/gu)?.length, 1);
});

test("keeps returned multipart reuploads inside OA without using the 20k editor", async () => {
  const source = await readFile(path.join(root, "components/knowledge/knowledge-view.tsx"), "utf8");
  const cardStart = source.indexOf("function KnowledgeItemCard");
  const cardEnd = source.indexOf("function KnowledgeMinePanel", cardStart);
  assert.ok(cardStart >= 0 && cardEnd > cardStart);
  const card = source.slice(cardStart, cardEnd);

  assert.match(card, /const isMultipartImport = Boolean\(item\.contentPartCount && item\.contentPartCount > 1\)/u);
  assert.match(card, /item\.status === "returned" && isMultipartImport \? [\s\S]*?onClick=\{\(\) => onEdit\?\.\(item\)\}[\s\S]*?disabled=\{!onEdit\}[\s\S]*?在 OA 重新上传[\s\S]*?: item\.status === "returned" && onEdit/u);
  assert.doesNotMatch(card, /https:\/\/chat\.omindos\.ai\/manage/u);
  assert.match(card, />修改并重提<\/Button>/u);
  // A multipart return must keep its original item and exit before the small editor fetch.
  assert.match(source, /const startEditing = async \(item: KnowledgeItem\) => \{\s*if \(item\.contentPartCount && item\.contentPartCount > 1\) \{ setReturnedPackageItem\(item\); setActiveTab\("submit"\); return; \}/u);
  assert.match(source, /<KnowledgePackageImport[^>]*returnedItem=\{returnedPackageItem\}/u);
  assert.match(source, /\{!returnedPackageItem && !adminEditItem && editingItem && <KnowledgeSubmitPanel/u);
});

test("requires the exact second confirmation before publishing knowledge", async () => {
  const source = await readFile(path.join(root, "components/knowledge/knowledge-view.tsx"), "utf8");

  assert.match(source, /PUBLIC_KNOWLEDGE_CONFIRMATION[\s\S]*?from "@\/lib\/knowledge-policy"/u);
  assert.match(source, /publicConfirmation === PUBLIC_KNOWLEDGE_CONFIRMATION/u);
  assert.match(source, /confirmation !== PUBLIC_KNOWLEDGE_CONFIRMATION/u);
  assert.doesNotMatch(source, /confirmation\.trim\(\)\s*!==\s*PUBLIC_KNOWLEDGE_CONFIRMATION/u);
  assert.match(source, /设为公开后，该知识仍可在 OA 内检索，并将同时供 chat\.omindos\.ai 对外检索/u);
});

test("shows the public-data anonymization rule during submission and review", async () => {
  const source = await readFile(path.join(root, "components/knowledge/knowledge-view.tsx"), "utf8");

  assert.match(source, /所有公开的数据需要脱敏处理。/u);
  assert.match(source, /论文和学位材料保留摘要、研究方法、实验过程、结果与结论等技术正文/u);
  assert.match(source, /扫描件，仅保留匿名化摘要和检索说明/u);
  assert.match(source, /function KnowledgeAnonymizationNotice\(\)[\s\S]*?role="note"/u);
  assert.equal((source.match(/<KnowledgeAnonymizationNotice \/>/gu) ?? []).length, 2);
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
  assert.match(pageSource, /<h1>进入实验室大模型<\/h1>/u);
  assert.match(pageSource, /游客可以试看公开问答；实习学生请使用飞书登录/u);
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

test("keeps knowledge management search and sorting compact and usable on mobile", async () => {
  const [source, styles] = await Promise.all([
    readFile(path.join(root, "components/knowledge/knowledge-view.tsx"), "utf8"),
    readFile(path.join(root, "app/globals.css"), "utf8"),
  ]);

  const panel = source.slice(source.indexOf("function KnowledgeManagePanel"), source.indexOf("const eventLabels"));
  assert.match(panel, /role="search" aria-label="搜索和排序知识库"/u);
  assert.match(panel, /placeholder="搜索标题、摘要、正文、分类或来源"/u);
  assert.match(panel, /maxLength=\{KNOWLEDGE_LIST_QUERY_MAX_LENGTH\}/u);
  assert.match(panel, /aria-label="清空搜索关键词"/u);
  assert.match(panel, /当前显示 \$\{items\.length\} 条匹配记录/u);
  assert.match(panel, /最多显示前 100 条；可继续缩小关键词范围/u);
  assert.match(source, /value: "updated_desc", label: "最近更新"/u);
  assert.match(source, /value: "updated_asc", label: "最早更新"/u);
  assert.match(source, /value: "title_asc", label: "标题 A-Z"/u);
  assert.match(source, /value: "title_desc", label: "标题 Z-A"/u);
  assert.ok(panel.indexOf("knowledge-manage-toolbar") < panel.indexOf("没有找到匹配的知识"), "the toolbar must remain before the no-results state");

  assert.match(styles, /\.knowledge-manage-toolbar \{[^}]*display: flex;[^}]*\}/u);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.knowledge-manage-toolbar \{[^}]*flex-direction: column;[^}]*\}/u);
  assert.match(styles, /\.knowledge-manage-search input, \.knowledge-manage-sort \[data-slot="native-select"\] \{[^}]*min-height: 44px;[^}]*\}/u);
  assert.match(styles, /\.knowledge-manage-search-clear \{ width: 44px; height: 44px;/u);
});

test("debounces only the knowledge management query and sends the selected server sort", async () => {
  const source = await readFile(path.join(root, "components/knowledge/knowledge-view.tsx"), "utf8");

  assert.match(source, /window\.setTimeout\(\(\) => setDebouncedManageQuery\(normalizedQuery\), 300\)/u);
  assert.match(source, /new URLSearchParams\(\{\s*scope: "all",\s*q: normalizeKnowledgeListQuery\(query\),\s*sort,\s*\}\)/u);
  assert.match(source, /fetch\(`\/api\/knowledge\?\$\{params\.toString\(\)\}`/u);

  const initialLoadEffect = source.slice(
    source.search(/useEffect\(\(\) => \{\r?\n    const controller = new AbortController\(\);/u),
    source.search(/useEffect\(\(\) => \{\r?\n    const normalizedQuery = normalizeKnowledgeListQuery\(manageQuery\);/u)
  );
  assert.match(initialLoadEffect, /loadMine\(controller\.signal\)/u);
  assert.match(initialLoadEffect, /loadReview\(controller\.signal\)/u);
  assert.doesNotMatch(initialLoadEffect, /loadManage/u);
  assert.match(source, /\[canReviewKnowledge, debouncedManageQuery, loadManage, manageSort\]/u);
});
