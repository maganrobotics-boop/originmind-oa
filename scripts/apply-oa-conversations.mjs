// One-time integration against the exact reviewed main. No production writes.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const read = file => readFile(file, 'utf8');
const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
function one(text, before, after) {
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`Expected one source anchor: ${before.slice(0,90)}`);
  return text.replace(before, after);
}
function cut(text, begin, end) {
  const start = text.indexOf(begin), finish = text.indexOf(end, start + begin.length);
  if (start < 0 || finish < start) throw new Error(`Missing section: ${begin}`);
  return text.slice(start, finish);
}
let page = await read('app/page.tsx');
if (page.includes('<OaConversationProvider ')) { console.log('Conversation integration already materialized.'); process.exit(0); }
if (blob(page) !== '0cf4df39bce2c7a1ec2ce35295b9ed48e3699431') throw new Error('OA page changed; reconcile before integration.');
page = one(page, 'import { OaChatStatus } from "@/components/knowledge/oa-chat-panel";', 'import { OaChatStatus } from "@/components/knowledge/oa-chat-panel";\nimport { OaConversationProvider, OaConversationMenu, OaConversationTitle, OaNewChatButton, useOaConversation } from "@/components/knowledge/oa-conversation-context";');
page = one(page, '  const [userMenuOpen, setUserMenuOpen] = useState(false);', '  const conversation = useOaConversation();\n  const [userMenuOpen, setUserMenuOpen] = useState(false);');
page = one(page, '<div className="brand-name">{officialBrand}</div><div className="brand-subtitle">联合研发 OA</div>', '<div className="brand-name">联合研发 OA</div><div className="brand-subtitle">{officialBrand}</div>');
page = one(page, '    <button type="button" data-sidebar-section="office"', '    <div className="oa-sidebar-scroll">\n    <button type="button" data-sidebar-section="office"');
page = one(page, 'onClick={() => onKnowledgeTab(tab)}', 'onClick={() => { if (tab === "ask") conversation.showAi(); onKnowledgeTab(tab); }}');
const footer = cut(page, '    <a className="sidebar-nav-item" href="/guide">', '  </aside>;');
page = one(page, footer, `    </div>
    <div className="oa-sidebar-bottom">
      <div className="oa-sidebar-links"><a href="https://omindos.ai" target="_blank" rel="noreferrer">官网 ↗</a>{isAdmin && <a href="https://chat.omindos.ai/manage" target="_blank" rel="noreferrer">管理</a>}<a href="/guide">使用指南</a></div>
      <div className="oa-sidebar-bottom-row"><OaNewChatButton /><div className="sidebar-user-control">
        <button type="button" className="oa-sidebar-account" onClick={() => setUserMenuOpen(open => !open)} aria-expanded={userMenuOpen} aria-haspopup="menu" aria-label="打开个人账户菜单" title={userName}>{userAvatarDataUrl ? <img src={userAvatarDataUrl} alt="" /> : userName.slice(0, 1)}</button>
        {userMenuOpen && <div className="sidebar-user-popover" role="menu"><div className="oa-sidebar-account-copy"><strong>{userName}</strong><div className="sidebar-user-role">{sessionRoleLabel(currentRole, isAdmin)}</div></div><button type="button" role="menuitem" onClick={openProfile}><Settings2 className="size-3.5" />个人设置</button><button type="button" role="menuitem" className="logout-action" onClick={logout}><LogOut className="size-3.5" />退出登录</button></div>}
      </div></div>
    </div>
`);
page = one(page, '    <div className={`oa-app oa-workspace ', '    <OaConversationProvider key={session.user?.email || "oa-member"} currentUser={session.user} visible={activeView === "knowledge" && knowledgeTab === "ask"} onOpenChat={() => { setKnowledgeTab("ask"); navigate("knowledge"); }}>\n    <div className={`oa-app oa-workspace ');
page = one(page, '{activeView === "knowledge" && knowledgeTab === "ask" && <OaChatStatus />}', '{activeView === "knowledge" && knowledgeTab === "ask" && <OaConversationTitle><OaChatStatus /></OaConversationTitle>}');
const userButton = '<button type="button" className="oa-topbar-user" onClick={() => navigate("profile")} aria-label="打开个人设置"><UserRound className="size-4" />{session.user?.displayName || "成员"}</button>';
page = one(page, userButton, `{activeView === "knowledge" && knowledgeTab === "ask" ? <OaConversationMenu /> : ${userButton}}`);
const banner = cut(page, '          <button type="button" className="dashboard-ai-entry"', '          <section className="stats-grid">');
page = one(page, banner, '');
const end = '    </div>\n  );\n}\n';
if (!page.endsWith(end)) throw new Error('OA root wrapper terminator changed');
page = page.slice(0,-end.length) + '    </div>\n    </OaConversationProvider>\n  );\n}\n';
await writeFile('app/page.tsx',page);

let panel = await read('components/knowledge/oa-chat-panel.tsx');
if (blob(panel) !== '120393461e0f8e636586af8e94665334d52e4b18') throw new Error('AI panel changed; reconcile before integration.');
panel = one(panel, 'ArrowUp, Copy, Plus, RotateCcw, Square', 'ArrowUp, Copy, Forward, RotateCcw, Square');
panel = one(panel, "import './oa-chat-panel.css';", "import './oa-chat-panel.css';\nimport { useOaConversation } from './oa-conversation-context';\nimport { OaMemberChat } from './oa-member-chat';");
panel = one(panel, 'export function OaChatPanel() {', `export function OaChatPanel() {
  const { peer, aiEpoch } = useOaConversation();
  return <><div className="oa-conversation-ai" hidden={Boolean(peer)}><OaAiChatPanel key={aiEpoch} /></div>{peer && <OaMemberChat key={peer.email} peer={peer} />}</>;
}

function OaAiChatPanel() {
  const { forward, setLastAnswer } = useOaConversation();`);
panel = one(panel, '      setTurns(current => current.map(turn => turn.id === id ? { ...turn, answer: data.answer!, citations: data.citations || [], images } : turn));', '      setTurns(current => current.map(turn => turn.id === id ? { ...turn, answer: data.answer!, citations: data.citations || [], images } : turn));\n      setLastAnswer({ body: userFacingAnswer(data.answer!), omittedImages: images.length });');
panel = one(panel, '  }, [question, turns]);', '  }, [question, turns, setLastAnswer]);');
panel = one(panel, cut(panel, '  const newChat = () => {', '  const copy = async'), '');
panel = one(panel, '      <div className="oa-conversation-tools"><button type="button" onClick={newChat} aria-label="开始新聊天" title="开始新聊天"><Plus size={18} /></button></div>\n', '');
panel = one(panel, '{copied === turn.id ? \'已复制\' : \'复制\'}</button>', `{copied === turn.id ? '已复制' : '复制'}</button><button type="button" aria-label="转发回答给成员" onClick={() => forward({ body: userFacingAnswer(turn.answer), omittedImages: turn.images.length })}><Forward size={15} />转发</button>`);
await writeFile('components/knowledge/oa-chat-panel.tsx', panel);

let route = await read('app/api/direct-messages/route.ts');
if (blob(route) !== '558a67d29dad7b74ac76a09b349dfd6bb6a8d7c9') throw new Error('Direct-message API changed; reconcile before integration.');
route = 'import { DIRECT_MESSAGE_REQUEST_BYTES, parseDirectMessageInput, sameDirectMessage } from "../../../lib/direct-message-contract.mjs";\n' + route;
route = one(route, 'const MAX_MESSAGE_LENGTH = 1000;\nconst MAX_REQUEST_LENGTH = 8_192;', 'const MAX_REQUEST_LENGTH = DIRECT_MESSAGE_REQUEST_BYTES;');
route = one(route, cut(route, 'async function parseMessageRequest(', 'async function getConversationSummaries('), `async function parseMessageRequest(request: Request) {
  const parsed = await readBoundedJsonObject(request, MAX_REQUEST_LENGTH);
  return parsed.ok ? parseDirectMessageInput(parsed.value) : null;
}

`);
route = one(route, '  if (!isJsonRequest(request))', '  const origin = request.headers.get("origin");\n  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") return privateJson({ error: "请在 OA 内发送私聊。" }, { status: 403 });\n  if (!isJsonRequest(request))');
route = one(route, '请输入 1–1000 字的私聊内容。', '请输入 1–16000 字的私聊内容；发送者由当前登录身份确定。');
route = one(route, '    const messageId = crypto.randomUUID();', `    const messageId = parsed.clientMessageId || crypto.randomUUID();
    const findExisting = async () => (await db.select().from(directMessages).where(eq(directMessages.id, messageId)).limit(1))[0];
    if (parsed.clientMessageId) {
      const existing = await findExisting();
      if (existing) return sameDirectMessage(existing, senderEmail, parsed.recipientEmail, parsed.messageBody)
        ? privateJson({ message: serializeMessage(existing) })
        : privateJson({ error: "消息标识已被使用，请重新确认发送内容。" }, { status: 409 });
    }`);
route = one(route, '.where(authorizedMemberGuard(authorized))).returning();', '.where(authorizedMemberGuard(authorized))).onConflictDoNothing().returning();');
route = one(route, '    if (!created) return privateJson({ error: "成员状态或权限刚刚发生变化，消息未发送，请刷新后重试。" }, { status: 409 });', `    if (!created) {
      const existing = parsed.clientMessageId ? await findExisting() : null;
      if (sameDirectMessage(existing, senderEmail, parsed.recipientEmail, parsed.messageBody)) return privateJson({ message: serializeMessage(existing!) });
      return privateJson({ error: "成员状态、权限或消息标识刚刚发生变化，请刷新核对后重试。" }, { status: 409 });
    }`);
await writeFile('app/api/direct-messages/route.ts',route);

let css = await read('app/oa-workspace.css');
css = one(css, '.topbar-actions > :not(.oa-topbar-user)', '.topbar-actions > :not(.oa-topbar-user):not(.oa-conversation-menu)');
await writeFile('app/oa-workspace.css',css);
let tests = await read('tests/ui-components.test.mjs');
for (const old of [
  '  assert.match(pageSource, /className="dashboard-ai-entry"/u);\n',
  '  assert.match(pageSource, /onClick=\\{\\(\\) => navigate\\("knowledge"\\)\\}/u);\n',
  '  assert.match(pageSource, /进入内部 AI/u);\n',
]) tests = one(tests,old,'');
tests = one(tests, '  assert.match(pageSource, /实验室 AI（内部）/u);', '  assert.match(pageSource, /实验室 AI（内部）/u);\n  assert.doesNotMatch(pageSource, /className="dashboard-ai-entry"/u);\n  assert.match(pageSource, /<OaConversationProvider/u);');
await writeFile('tests/ui-components.test.mjs',tests);
let browser = await read('scripts/check-oa-chat-browser.mjs');
browser = one(browser, "      assert.equal(await page.locator('.oa-topbar-user').innerText(), '测试成员');", "      assert.equal(await page.locator('.topbar .oa-topbar-user').count(), 0);\n      assert.equal(await page.getByRole('button', {name:'聊天更多操作'}).isVisible(), true);");
await writeFile('scripts/check-oa-chat-browser.mjs',browser);
console.log('OA member conversations, explicit full-text forwarding, single account entry and menu integrated.');
