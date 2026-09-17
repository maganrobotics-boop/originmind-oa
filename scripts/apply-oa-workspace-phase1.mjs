// One-time, exact-base migration. Removed from the PR after the materialized source is verified.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const expected = {
  'app/page.tsx': 'cd7bacdafa61a0be0f615206c227e2a5fc170663',
  'components/knowledge/knowledge-view.tsx': '53bbe6e1057bf3516a6a3109882ba95b80ac8c16',
  'app/api/knowledge/import-chat/route.ts': '237a87944bc918372eed525d630b501674e3157f',
  'app/api/knowledge/assets/route.ts': '77f52b657a6a5d0bf0005e44f9d3094319963c16',
  'app/api/knowledge/assets/finalize/route.ts': '7dcaf6dff0e49bbe7076362ac960534707fed6e9',
};
const output = new Map();
for (const [path, sha] of Object.entries(expected)) {
  const bytes = await readFile(path);
  const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (actual !== sha) throw new Error(`${path}: exact-base verification failed; no files written`);
  output.set(path, bytes.toString('utf8'));
}
function once(source, from, to) {
  if (!from || source.split(from).length !== 2) throw new Error(`Expected one source anchor: ${from.slice(0, 100)}`);
  return source.replace(from, to);
}
let page = output.get('app/page.tsx');
page = once(page, 'import { KnowledgeView } from "@/components/knowledge/knowledge-view";', 'import { KnowledgeView, type KnowledgeTab } from "@/components/knowledge/knowledge-view";\nimport "./oa-workspace.css";');
page = once(page, 'canReviewKnowledge = false }: { activeView: ViewKey;', 'canReviewKnowledge = false, selectedKnowledgeTab = "ask", onKnowledgeTab, onMyPending }: { activeView: ViewKey;');
page = once(page, 'canReviewKnowledge?: boolean }) {', 'canReviewKnowledge?: boolean; selectedKnowledgeTab?: KnowledgeTab; onKnowledgeTab: (tab: KnowledgeTab) => void; onMyPending: () => void }) {');
page = once(page, '    { key: "knowledge", label: "实验室 AI（内部）", icon: Bot },\n', '');
page = once(page, '<div className="sidebar-section-label">工作空间</div>', '<div className="sidebar-section-label">审批办公</div>');
const start = page.indexOf('    <div className="sidebar-divider" />');
const end = page.indexOf('    <div className="sidebar-footer-card">', start);
if (start < 0 || end < start) throw new Error('Sidebar section anchors missing');
page = page.slice(0, start) + `    <button type="button" className="sidebar-nav-item" onClick={onMyPending}><Clock3 className="size-[17px]" /><span>待我审批</span></button>
    <button type="button" className="sidebar-nav-item" onClick={onNew}><Plus className="size-[17px]" /><span>新建审核申请</span></button>
    <div className="sidebar-divider" />
    <div className="sidebar-section-label">大模型与资料</div>
    <nav className="oa-knowledge-nav" aria-label="大模型后台">
      {([{ tab: "ask", label: "AI 聊天", icon: Bot }, { tab: "submit", label: "上传资料", icon: Plus }, { tab: "mine", label: "我的资料", icon: FolderKanban }, ...(canReviewKnowledge ? [{ tab: "review", label: "资料审核", icon: ShieldCheck }, { tab: "manage", label: "知识资料管理", icon: BookOpen }] : [])] as { tab: KnowledgeTab; label: string; icon: typeof Bot }[]).map(({ tab, label, icon: Icon }) => <button type="button" key={tab} className={\`sidebar-nav-item \${activeView === "knowledge" && selectedKnowledgeTab === tab ? "active" : ""}\`} onClick={() => onKnowledgeTab(tab)}><Icon className="size-[17px]" /><span>{label}</span>{tab === "review" && pendingKnowledgeCount > 0 && <span className="nav-count nav-count-alert">{pendingKnowledgeCount > 99 ? "99+" : pendingKnowledgeCount}</span>}</button>)}
      {isAdmin && <a className="sidebar-nav-item" href="https://chat.omindos.ai/manage" target="_blank" rel="noreferrer"><Settings2 className="size-[17px]" /><span>Chat 后台（原入口）</span></a>}
    </nav>
    <a className="sidebar-nav-item" href="/guide"><BookOpen className="size-[17px]" /><span>项目章程与使用指南</span></a>
` + page.slice(end);
page = once(page, '  const [activeView, setActiveView] = useState<ViewKey>("dashboard");', `  const [activeView, setActiveView] = useState<ViewKey>("knowledge");
  const [knowledgeTab, setKnowledgeTab] = useState<KnowledgeTab>("ask");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => { try { setSidebarCollapsed(localStorage.getItem("oa.sidebar.collapsed") === "true"); } catch { /* optional preference */ } }, []);
  const toggleSidebar = () => setSidebarCollapsed(current => {
    const next = !current;
    try { localStorage.setItem("oa.sidebar.collapsed", String(next)); } catch { /* storage may be blocked */ }
    return next;
  });`);
// Login still validates identity/NDA using the original gates; only the landing view changes.
page = page.replaceAll('      setActiveView("dashboard");\n      setShowMineOnly(false);', '      setActiveView("knowledge");\n      setShowMineOnly(false);');
page = once(page, '    <div className="oa-app">', '    <div className={`oa-app oa-workspace ${sidebarCollapsed ? "oa-sidebar-collapsed" : ""}`}>');
const sidebarProps = 'canReviewKnowledge={Boolean(session.canReviewKnowledge)} />';
const enhanced = 'canReviewKnowledge={Boolean(session.canReviewKnowledge)} selectedKnowledgeTab={knowledgeTab} onKnowledgeTab={(tab) => { setKnowledgeTab(tab); navigate("knowledge"); }} onMyPending={openMyPending} />';
// Target Sidebar lines only, not KnowledgeView.
page = page.split('\n').map(line => line.includes('<Sidebar activeView=') ? once(line, sidebarProps, enhanced) : line).join('\n');
const desktopLine = page.split('\n').find(line => line.startsWith('      <Sidebar ') && line.includes('onNew={openNewRequest}'));
if (!desktopLine) throw new Error('Desktop sidebar not found');
page = once(page, desktopLine, `      <div id="oa-desktop-navigation" className="oa-desktop-navigation">${desktopLine.trim()}</div>`);
page = once(page, '        <header className="topbar">', `        <header className="topbar">
          <button type="button" className="workspace-sidebar-toggle" onClick={toggleSidebar} aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} aria-expanded={!sidebarCollapsed} aria-controls="oa-desktop-navigation"><Menu className="size-5" /></button>`);
page = once(page, '            <div className="topbar-date">{todayLabel}</div>', '            <div className="topbar-date">{todayLabel}</div>\n            <button type="button" className="oa-topbar-user" onClick={() => navigate("profile")} aria-label="打开个人设置"><UserRound className="size-4" />{session.user?.displayName || "成员"}</button>');
const knowledge = '<KnowledgeView canReviewKnowledge={Boolean(session.canReviewKnowledge)} />';
page = once(page, 'activeView === "knowledge" ? ' + knowledge, 'activeView === "knowledge" ? null');
page = once(page, '        {activeView === "notifications" ?', `        <div className="oa-knowledge-pane" hidden={activeView !== "knowledge"}><KnowledgeView canReviewKnowledge={Boolean(session.canReviewKnowledge)} activeSection={knowledgeTab} onSectionChange={setKnowledgeTab} /></div>
        {activeView === "notifications" ?`);
output.set('app/page.tsx', page);

let view = output.get('components/knowledge/knowledge-view.tsx');
view = once(view, 'import { toast } from "sonner";', 'import { toast } from "sonner";\nimport { KnowledgePackageImport } from "./package-import";');
view = once(view, 'type KnowledgeTab =', 'export type KnowledgeTab =');
view = once(view, 'export function KnowledgeView({ canReviewKnowledge }: { canReviewKnowledge: boolean }) {\n  const [activeTab, setActiveTab] = useState<KnowledgeTab>("ask");', `export function KnowledgeView({ canReviewKnowledge, activeSection, onSectionChange }: { canReviewKnowledge: boolean; activeSection?: KnowledgeTab; onSectionChange?: (tab: KnowledgeTab) => void }) {
  const [internalTab, setInternalTab] = useState<KnowledgeTab>("ask");
  const activeTab = activeSection ?? internalTab;
  const setActiveTab = (tab: KnowledgeTab) => { setInternalTab(tab); onSectionChange?.(tab); };
  const [returnedPackageItem, setReturnedPackageItem] = useState<KnowledgeItem | null>(null);`);
view = once(view, '  return <div className="knowledge-view">', '  return <div className="knowledge-view" data-section={visibleTab}>');
view = once(view, '<TabsContent value="ask"><KnowledgeAskPanel /></TabsContent>', '<div hidden={visibleTab !== "ask"}><KnowledgeAskPanel /></div>');
const submitPanel = '<TabsContent value="submit"><KnowledgeSubmitPanel draft={draft} setDraft={setDraft} editingItem={editingItem} submitting={submitting} onSubmit={submitKnowledge} onCancelEdit={cancelEditing} /></TabsContent>';
view = once(view, submitPanel, `<div hidden={visibleTab !== "submit"}><KnowledgePackageImport key={returnedPackageItem?.id || "new-package"} returnedItem={returnedPackageItem} onCancelReturn={() => setReturnedPackageItem(null)} onSubmitted={() => { void loadMine(); void loadReview(); void loadManage(debouncedManageQuery, manageSort); }} />{!returnedPackageItem && <KnowledgeSubmitPanel draft={draft} setDraft={setDraft} editingItem={editingItem} submitting={submitting} onSubmit={submitKnowledge} onCancelEdit={cancelEditing} />}</div>`);
const link = '<small>大文档请从 <a href={`https://chat.omindos.ai/manage?returnedKnowledgeItem=${encodeURIComponent(item.id)}`} target="_blank" rel="noreferrer">Chat 管理页面</a>重新导入；成功后会更新当前条目和审计记录</small>';
view = once(view, link, '<Button type="button" variant="outline" size="sm" onClick={() => onEdit?.(item)} disabled={!onEdit}><Pencil className="size-3.5" />在 OA 重新上传</Button>');
view = once(view, '  const startEditing = async (item: KnowledgeItem) => {\n    setEditingLoadingId(item.id);', '  const startEditing = async (item: KnowledgeItem) => {\n    if (item.contentPartCount && item.contentPartCount > 1) { setReturnedPackageItem(item); setActiveTab("submit"); return; }\n    setReturnedPackageItem(null);\n    setEditingLoadingId(item.id);');
output.set('components/knowledge/knowledge-view.tsx', view);

let route = output.get('app/api/knowledge/import-chat/route.ts');
route = 'import { isKnowledgeUploadOrigin } from "../../../../lib/knowledge-upload-origin";\n' + route;
route = once(route, 'function allowedOrigin(request: Request) { return request.headers.get("origin") === CHAT_ORIGIN; }', 'function allowedOrigin(request: Request) { return isKnowledgeUploadOrigin(request); }');
route = route.replaceAll('请从 Chat 管理页面提交。', '请从 OA 或 Chat 管理页面提交。');
route = once(route, '  const actor: KnowledgeActor =', '  if (request.headers.get("origin") === new URL(request.url).origin) imported.submissions[0] = { ...imported.submissions[0], sourceLabel: `OA 资料导入 · ${imported.submissions[0].title}` };\n  const actor: KnowledgeActor =');
output.set('app/api/knowledge/import-chat/route.ts', route);
for (const [path, depth] of [['app/api/knowledge/assets/route.ts', '../../../../'], ['app/api/knowledge/assets/finalize/route.ts', '../../../../../']]) {
  let source = output.get(path);
  source = `import { isKnowledgeUploadOrigin } from "${depth}lib/knowledge-upload-origin";\n` + source;
  source = once(source, 'request.headers.get("origin") !== CHAT_ORIGIN', '!isKnowledgeUploadOrigin(request)');
  source = source.replaceAll('请从 Chat 管理页面上传。', '请从 OA 或 Chat 管理页面上传。').replaceAll('请从 Chat 管理页面提交。', '请从 OA 或 Chat 管理页面提交。');
  output.set(path, source);
}
for (const [path, source] of output) await writeFile(path, source);
console.log('Materialized phase-one OA source only; no Chat files, data, secrets, DNS, or release gates changed.');
