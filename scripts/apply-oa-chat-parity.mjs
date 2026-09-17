import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = name => readFile(path.join(root, name), 'utf8');
const write = (name, text) => writeFile(path.join(root, name), text);
const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
function replace(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error(`Expected one exact integration anchor: ${before.slice(0, 90)}`);
  return source.replace(before, after);
}
function section(source, begin, end) {
  const first = source.indexOf(begin); const last = source.indexOf(end, first + begin.length);
  if (first < 0 || last <= first || source.indexOf(begin, first + begin.length) >= 0) throw new Error(`Ambiguous section: ${begin}`);
  return source.slice(first, last);
}
let page = await read('app/page.tsx');
if (page.includes('data-sidebar-section="office"')) { console.log('OA Chat integration already materialized.'); process.exit(0); }
const worker = await read('chat-cloudflare/src/app.mjs');
if (blob(page) !== 'a86168e1c2fee77df39ce73b44fb60a1a19854e2' || blob(worker) !== '1f88206906f31243d4025a78a282eae2b6b7288f') throw new Error('OA or Chat base changed; reconcile before applying.');

// Keep the public prompt exactly unchanged. Both surfaces use one prompt builder.
const promptBlock = section(worker, '      const referenceContext = documents\n', '      context.modelDeadline = Date.now() + 60_000;');
const historyHelper = section(worker, 'function boundedUserMessages(', 'function citationNumber(');
const promptModule = `import { cleanAnswerPresentation } from './answer-presentation.mjs';\n\n${historyHelper}\nexport function buildGroundedChatMessages({ documents, history = [], question, messages: inputMessages = [], scope = 'public' }) {\n  const last = { content: question };\n  const payload = { messages: inputMessages };\n${promptBlock}\n  if (scope === 'internal') {\n    messages[0].content = messages[0].content.replace('经 OA 审核公开的参考资料', '经 OA 审核、当前 OA 成员有权访问的内部及公开参考资料');\n    messages[0].content += '\\n本次是已登录的 OA 内部问答。内部资料仅用于本次成员问答，不表示资料已对公众公开。不得把内部内容写入公开资料、公开分享或对外统计。';\n  }\n  return messages;\n}\n`;
await write('chat-cloudflare/src/grounded-prompt.mjs', promptModule);
let nextWorker = replace(worker, promptBlock, '      const messages = buildGroundedChatMessages({ documents, history, question: last.content, messages: payload.messages });\n');
nextWorker = replace(nextWorker, historyHelper, '');
nextWorker = `import { buildGroundedChatMessages } from './grounded-prompt.mjs';\nimport { handleOaChatBridge } from './oa-chat-bridge.mjs';\n${nextWorker}`;
nextWorker = replace(nextWorker, '    if (method === "POST" || method === "PATCH") sameOrigin(context);', `    if (path === "internal/oa-answer") return handleOaChatBridge(context, {
      getModelConfig, modelProvider, currentModelStatus, modelBudgetReady,
      globalBudget, modelCall, workersAiCall, visibleAiAnswer,
      claimRequest: async (nonce) => {
        await consumeCounter(context, \`oa-chat-bridge:\${nonce}\`, 1, Math.floor(Date.now() / 1000) + 120);
        await database(context).prepare("DELETE FROM limits WHERE expires < ?").bind(Math.floor(Date.now() / 1000)).run();
      },
    });
    if (method === "POST" || method === "PATCH") sameOrigin(context);`);
await write('chat-cloudflare/src/app.mjs', nextWorker);

page = replace(page, 'import "./oa-workspace.css";', 'import "./oa-workspace.css";\nimport { OaChatStatus } from "@/components/knowledge/oa-chat-panel";');
const oldSidebar = section(page, 'function Sidebar(', 'function ApprovalRow(');
let sidebar = oldSidebar;
sidebar = replace(sidebar, '  const [userMenuOpen, setUserMenuOpen] = useState(false);', '  const [userMenuOpen, setUserMenuOpen] = useState(false);\n  const [officeOpen, setOfficeOpen] = useState(true);\n  const [knowledgeOpen, setKnowledgeOpen] = useState(true);\n  const officeId = useId();\n  const knowledgeId = useId();');
sidebar = replace(sidebar, '    { key: "rules", label: "流程与规则", icon: FileCheck2 },\n', '');
sidebar = replace(sidebar, ', { key: "oem" as ViewKey, label: "官网 OEM 申请", icon: BriefcaseBusiness }', '');
sidebar = replace(sidebar, '<div className="sidebar-section-label">审批办公</div>', '<button type="button" data-sidebar-section="office" className="sidebar-section-label sidebar-group-toggle" aria-expanded={officeOpen} aria-controls={officeId} onClick={() => setOfficeOpen(open => !open)}><span>审批办公</span><ChevronRight className="size-3.5" /></button>\n    <div id={officeId} hidden={!officeOpen}>');
sidebar = replace(sidebar, '    <div className="sidebar-divider" />', '    </div>\n    <div className="sidebar-divider" />');
sidebar = replace(sidebar, '<div className="sidebar-section-label">大模型与资料</div>', '<button type="button" data-sidebar-section="knowledge" className="sidebar-section-label sidebar-group-toggle" aria-expanded={knowledgeOpen} aria-controls={knowledgeId} onClick={() => setKnowledgeOpen(open => !open)}><span>大模型与资料</span><ChevronRight className="size-3.5" /></button>');
sidebar = replace(sidebar, '<nav className="oa-knowledge-nav" aria-label="大模型后台">', '<nav id={knowledgeId} hidden={!knowledgeOpen} className="oa-knowledge-nav" aria-label="大模型后台">');
page = replace(page, oldSidebar, sidebar);
page = replace(page, '<div className={`oa-app oa-workspace ${sidebarCollapsed ? "oa-sidebar-collapsed" : ""}`}>', '<div className={`oa-app oa-workspace ${sidebarCollapsed ? "oa-sidebar-collapsed" : ""} ${activeView === "knowledge" && knowledgeTab === "ask" ? "oa-chat-open" : ""}`}>');
page = replace(page, '          <div className="topbar-actions">', '          {activeView === "knowledge" && knowledgeTab === "ask" && <OaChatStatus />}\n          <div className="topbar-actions">');
await write('app/page.tsx', page);

let knowledge = await read('components/knowledge/knowledge-view.tsx');
const oldChat = section(knowledge, 'function CitationList(', 'function KnowledgeSubmitPanel(');
knowledge = replace(knowledge, oldChat, 'function KnowledgeAskPanel() { return <OaChatPanel />; }\n\n');
knowledge = replace(knowledge, 'import { KnowledgePackageImport } from "./package-import";', 'import { KnowledgePackageImport } from "./package-import";\nimport { OaChatPanel } from "./oa-chat-panel";');
const modeLabel = section(knowledge, 'function askModeLabel(', 'function KnowledgeStatusBadge(');
knowledge = replace(knowledge, modeLabel, '');
knowledge = knowledge.replace(/^type AskTurn = .*\n/mu, '').replace('  KnowledgeAskResponse,\n', '').replace('  KnowledgeCitation,\n', '');
await write('components/knowledge/knowledge-view.tsx', knowledge);

let asset = await read('app/api/knowledge/[id]/assets/[...assetPath]/route.ts');
if (blob(asset) !== '25804eb37cfcfaf316b9692ec8d96ce5603a54c6') throw new Error('Private asset route changed; reconcile before applying.');
asset = replace(asset, 'export async function GET(_request: Request,', 'export async function GET(request: Request,');
asset = replace(asset, '    const revisionId = (detail?.item as { currentRevisionId?: string } | undefined)?.currentRevisionId;', `    const query = new URL(request.url).searchParams;
    const forChat = query.has("forChat") || query.has("revision");
    const requestedRevision = query.get("revision");
    if (forChat && (query.get("forChat") !== "1" || !requestedRevision || !SAFE_KNOWLEDGE_ID.test(requestedRevision)
      || [...query.keys()].some(key => !["forChat", "revision"].includes(key))
      || detail?.item.status !== "active" || detail.item.activeRevisionId !== requestedRevision
      || detail.item.currentRevisionId !== requestedRevision)) return privateJson({ error: "知识图片不存在或版本已失效。" }, { status: 404 });
    const revisionId = forChat ? requestedRevision : (detail?.item as { currentRevisionId?: string } | undefined)?.currentRevisionId;`);
await write('app/api/knowledge/[id]/assets/[...assetPath]/route.ts', asset);

let css = await read('app/oa-workspace.css');
css += `
/* Chat parity: no frame, no inset card, and no dead space after collapsing. */
.oa-workspace .sidebar-shell { padding-top:8px; }
.oa-workspace .brand-lockup { min-height:44px; margin:0 0 4px; padding-top:6px; padding-bottom:6px; }
.oa-workspace .sidebar-section-label { margin:6px 0; }
.oa-workspace .sidebar-group-toggle { display:flex; align-items:center; justify-content:space-between; width:100%; min-height:36px; padding:6px 12px; background:none; text-align:left; }
.oa-workspace .sidebar-group-toggle[aria-expanded="true"] svg { transform:rotate(90deg); }
.oa-workspace .sidebar-divider { margin:8px 0; }
.oa-workspace.oa-chat-open > .main-shell { display:flex; flex-direction:column; height:100dvh; padding:0; overflow:hidden; }
.oa-workspace.oa-chat-open .topbar { position:relative; display:flex; align-items:center; flex:0 0 64px; min-height:64px; margin:0; padding:0 12px; border-bottom:1px solid #eee; background:#fff; }
.oa-workspace.oa-chat-open .breadcrumbs { display:none; }
.oa-workspace.oa-chat-open .topbar-actions { margin-left:auto; }
.oa-workspace.oa-chat-open .topbar-actions > :not(.oa-topbar-user) { display:none; }
.oa-workspace.oa-chat-open .oa-topbar-user { max-width:120px; font-size:14px; padding:8px; }
.oa-workspace.oa-chat-open .workspace-sidebar-toggle, .oa-workspace.oa-chat-open .mobile-menu-button { border:0; border-radius:50%; width:44px; height:44px; background:#f7f7f7; }
.oa-workspace.oa-chat-open .oa-knowledge-pane { flex:1 1 0; min-height:0; display:flex; overflow:hidden; margin:0; }
.oa-workspace.oa-chat-open .knowledge-view { height:100%; min-height:0; display:flex; flex-direction:column; margin:0; padding:0; gap:0; }
.oa-workspace.oa-chat-open .knowledge-tabs { display:flex; flex-direction:column; flex:1 1 0; min-height:0; gap:0; margin:0; }
.oa-workspace.oa-chat-open .knowledge-tabs > [role="tabpanel"] { flex:1 1 0; min-height:0; height:100%; padding:0; margin:0; }
.oa-workspace.oa-chat-open .knowledge-tabs > [data-slot="tabs-content"] { flex:1 1 0; min-height:0; height:100%; margin:0; }
@media(max-width:560px) { .oa-workspace.oa-chat-open .oa-topbar-user { max-width:88px; font-size:12px; } }
`;
await write('app/oa-workspace.css', css);

// Retain the original timing tests while pointing their mock at the shared client.
let timingTests = await read('tests/lab-ai-ask-timing.test.mjs');
timingTests = replace(timingTests, 'lib\\/lab-ai-client', 'lib\\/oa-chat-client');
timingTests = replace(timingTests, 'export async function answerLabQuestion(question, ranked)', 'export async function answerOaChatQuestion(question, ranked)');
await write('tests/lab-ai-ask-timing.test.mjs', timingTests);
let uiTests = await read('tests/ui-components.test.mjs');
const oldWaitTest = section(uiTests, 'test("labels the internal laboratory AI wait as retrieval and answer generation",', 'test("makes the official Feishu QR');
uiTests = replace(uiTests, oldWaitTest, `test("labels the internal laboratory AI wait and supports Chat-style send and stop", async () => {
  const source = await readFile(path.join(root, "components/knowledge/oa-chat-panel.tsx"), "utf8");
  assert.match(source, /knowledge-answer-loading" role="status"/u);
  assert.match(source, /正在检索并生成回答…/u);
  assert.match(source, /aria-label="发送问题"/u);
  assert.match(source, /aria-label="停止等待回答"/u);
  assert.match(source, /!event\\.nativeEvent\\.isComposing/u);
  assert.match(source, /renderAnswerBody\\(userFacingAnswer\\(answer\\)\\)/u);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|localStorage|conversationToken/u);
});

`);
await write('tests/ui-components.test.mjs', uiTests);

execFileSync(process.execPath, ['scripts/sync-oa-chat-shared.mjs'], { cwd:root, stdio:'inherit' });
console.log('OA Chat parity integrated. Tests and visual acceptance must pass before merge.');
