// One-time exact-source edit; removed after the tested changes are committed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const expected = {
  'app/page.tsx': '0cf4df39bce2c7a1ec2ce35295b9ed48e3699431',
  'components/knowledge/knowledge-view.tsx': '0f0cb205a352ff444101a678b0f32f12fdcdd6bc',
  'components/knowledge/oa-chat-panel.tsx': '120393461e0f8e636586af8e94665334d52e4b18',
  'tests/ui-components.test.mjs': '40da3e406125a9e3c42d7f16c85fcb607245fcf6',
  'scripts/check-oa-chat-browser.mjs': '7e641ffd590159df84f7c7a5a0231cf4794299ba',
};
const files = new Map();
for (const [path, sha] of Object.entries(expected)) {
  const source = await readFile(path, 'utf8');
  const actual = createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
  assert.equal(actual, sha, `${path} changed; reconcile before editing`);
  files.set(path, source);
}
function replace(path, before, after) {
  const source = files.get(path);
  assert.ok(source.includes(before) && source.indexOf(before) === source.lastIndexOf(before), `Expected one exact anchor in ${path}: ${before.slice(0, 75)}`);
  files.set(path, source.replace(before, after));
}
const page = 'app/page.tsx';
replace(page, '  const [knowledgeTab, setKnowledgeTab] = useState<KnowledgeTab>("ask");', '  const [knowledgeTab, setKnowledgeTab] = useState<KnowledgeTab>("ask");\n  const [chatActionsTarget, setChatActionsTarget] = useState<HTMLDivElement | null>(null);');
replace(page,
  '            <button type="button" className="oa-topbar-user" onClick={() => navigate("profile")} aria-label="打开个人设置"><UserRound className="size-4" />{session.user?.displayName || "成员"}</button>',
  '            {activeView === "knowledge" && knowledgeTab === "ask" ? <div className="oa-chat-menu-host" ref={setChatActionsTarget} /> : <button type="button" className="oa-topbar-user" onClick={() => navigate("profile")} aria-label="打开个人设置"><UserRound className="size-4" />{session.user?.displayName || "成员"}</button>}');
replace(page, 'activeSection={knowledgeTab} onSectionChange={setKnowledgeTab} />', 'activeSection={knowledgeTab} onSectionChange={setKnowledgeTab} chatActionsTarget={chatActionsTarget} />');
replace(page, `          <button type="button" className="dashboard-ai-entry" onClick={() => navigate("knowledge")} aria-label="进入 OA 内部实验室 AI">
            <span className="dashboard-ai-entry-icon"><Bot className="size-5" /></span>
            <span className="dashboard-ai-entry-copy">
              <span className="dashboard-ai-entry-kicker">OA 内部知识问答</span>
              <strong>实验室 AI（内部）</strong>
              <span>在 OA 内提问、提交知识，并由审核人选择对内或对外公开。</span>
            </span>
            <span className="dashboard-ai-entry-action">进入内部 AI <ArrowUpRight className="size-4" /></span>
          </button>
`, '');
const knowledge = 'components/knowledge/knowledge-view.tsx';
replace(knowledge, 'function KnowledgeAskPanel() { return <OaChatPanel />; }', 'function KnowledgeAskPanel({ actionsTarget }: { actionsTarget?: HTMLElement | null }) { return <OaChatPanel actionsTarget={actionsTarget} />; }');
replace(knowledge,
  'export function KnowledgeView({ canReviewKnowledge, activeSection, onSectionChange }: { canReviewKnowledge: boolean; activeSection?: KnowledgeTab; onSectionChange?: (tab: KnowledgeTab) => void }) {',
  'export function KnowledgeView({ canReviewKnowledge, activeSection, onSectionChange, chatActionsTarget }: { canReviewKnowledge: boolean; activeSection?: KnowledgeTab; onSectionChange?: (tab: KnowledgeTab) => void; chatActionsTarget?: HTMLElement | null }) {');
replace(knowledge, '<KnowledgeAskPanel /></div>', '<KnowledgeAskPanel actionsTarget={chatActionsTarget} /></div>');
const panel = 'components/knowledge/oa-chat-panel.tsx';
replace(panel, "import { ArrowUp, Copy, Plus, RotateCcw, Square } from 'lucide-react';", "import { createPortal } from 'react-dom';\nimport { ArrowUp, Copy, MoreHorizontal, RotateCcw, Square, Trash2 } from 'lucide-react';\nimport { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';");
replace(panel, "import './oa-chat-panel.css';", "import './oa-chat-panel.css';\nimport './oa-chat-menu.css';");
replace(panel, 'export function OaChatPanel() {', 'export function OaChatPanel({ actionsTarget }: { actionsTarget?: HTMLElement | null }) {');
replace(panel, '  const stickToEnd = useRef(true);', '  const stickToEnd = useRef(true);\n  const focusComposerAfterMenu = useRef(false);');
replace(panel, `  const newChat = () => {
    if (turns.length && !window.confirm('开始新聊天将清除当前页面的对话，是否继续？')) return;
    requestSequence.current++; requestRef.current?.abort(); requestRef.current = null; sending.current = false;
    setTurns([]); setQuestion(''); setAsking(false); setError(''); input.current?.focus();
  };`, `  const clearChat = () => {
    if (!window.confirm('清空当前聊天？只清除本页对话和未发送的问题，不会删除知识资料或审批记录。')) return;
    // Invalidate the old request before aborting, so its late reply cannot restore cleared content.
    requestSequence.current++; requestRef.current?.abort(); requestRef.current = null; sending.current = false;
    stickToEnd.current = true; focusComposerAfterMenu.current = true;
    setTurns([]); setQuestion(''); setAsking(false); setError(''); setCopied('');
  };`);
replace(panel, '      <div className="oa-conversation-tools"><button type="button" onClick={newChat} aria-label="开始新聊天" title="开始新聊天"><Plus size={18} /></button></div>', `      {actionsTarget && createPortal(<DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild><button type="button" className="oa-chat-more-button" aria-label="聊天选项" title="聊天选项"><MoreHorizontal size={24} aria-hidden="true" /></button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="oa-chat-clear-menu" onCloseAutoFocus={event => {
          if (focusComposerAfterMenu.current) { event.preventDefault(); focusComposerAfterMenu.current = false; input.current?.focus(); }
        }}>
          <DropdownMenuItem disabled={!turns.length && !question && !asking && !error} onSelect={clearChat}><Trash2 size={16} aria-hidden="true" />清空聊天</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>, actionsTarget)}`);
const tests = 'tests/ui-components.test.mjs';
replace(tests, `  assert.match(pageSource, /className="dashboard-ai-entry"/u);
  assert.match(pageSource, /onClick=\{\(\) => navigate\("knowledge"\)\}/u);
  assert.match(pageSource, /实验室 AI（内部）/u);
  assert.match(pageSource, /进入内部 AI/u);`, `  assert.doesNotMatch(pageSource, /className="dashboard-ai-entry"|进入内部 AI/u);
  assert.match(pageSource, /aria-label="大模型后台"/u);
  assert.match(pageSource, /tab: "ask", label: "AI 聊天"/u);`);
const browser = 'scripts/check-oa-chat-browser.mjs';
replace(browser, "      assert.equal(await page.locator('.oa-topbar-user').innerText(), '测试成员');", `      assert.equal(await page.locator('.topbar .oa-topbar-user').count(), 0, 'chat identity belongs in the lower-left account area');
      const more = page.getByRole('button', {name:'聊天选项',exact:true});
      await more.waitFor();
      assert.equal(await page.locator('.oa-conversation-tools').count(),0);
      const moreBox = await more.boundingBox();
      assert.ok(moreBox.width >= 44 && moreBox.height >= 44 && moreBox.x >= width-70, 'three-dot control belongs at the top right');
      await more.click();
      assert.equal(await page.getByRole('menuitem',{name:'清空聊天',exact:true}).getAttribute('data-disabled'), '');
      await page.keyboard.press('Escape');
      await page.getByRole('menu').waitFor({state:'hidden'});
      assert.equal(await more.evaluate(element=>element===document.activeElement),true);`);
replace(browser, "      assert.doesNotMatch(await nav.innerText(), /官网 OEM 申请|流程与规则/u);", "      assert.doesNotMatch(await nav.innerText(), /官网 OEM 申请|流程与规则/u);\n      assert.equal(await nav.locator('.sidebar-user-name').innerText(), '测试成员');\n      assert.equal(await nav.getByRole('button',{name:'打开个人账户菜单',exact:true}).isVisible(),true);");
replace(browser, "      await nav.getByRole('button',{name:'审批工作台',exact:true}).click();", `      await nav.getByRole('button',{name:'审批工作台',exact:true}).click();
      assert.equal(await page.locator('.main-shell .dashboard-ai-entry').count(),0);
      assert.equal(await page.getByRole('button',{name:'进入 OA 内部实验室 AI',exact:true}).count(),0);
      assert.equal(await page.getByRole('button',{name:'聊天选项',exact:true}).count(),0);
      assert.equal(await page.locator('.main-shell .stats-grid').isVisible(),true);`);
replace(browser, "      assert.deepEqual(errors,[]);", `      // Cancelling a clear operation retains the current messages and draft.
      await input.fill('尚未发送的问题');
      await more.click();
      await page.screenshot({path:resolve(output,\`\${name}-chat-menu.png\`),fullPage:true});
      page.once('dialog',dialog=>dialog.dismiss());
      await page.getByRole('menuitem',{name:'清空聊天',exact:true}).click();
      assert.equal(await input.inputValue(),'尚未发送的问题');
      assert.equal(await page.locator('.message.assistant math').count(),8);
      await more.click();
      page.once('dialog',dialog=>dialog.accept());
      await page.getByRole('menuitem',{name:'清空聊天',exact:true}).click();
      await page.locator('.empty-hero').waitFor();
      assert.equal(await input.inputValue(),'');
      assert.equal(await page.locator('.message').count(),0);
      await page.waitForFunction(()=>document.activeElement?.getAttribute('placeholder')==='询问实验室大数据');
      // Clearing an in-flight answer cannot reinsert its late response or issue a deletion API request.
      held.length=0; holdAnswer=true;
      await input.fill('清空正在生成的回答'); await input.press('Enter');
      await page.getByRole('button',{name:'停止等待回答',exact:true}).waitFor();
      await more.click(); page.once('dialog',dialog=>dialog.accept());
      await page.getByRole('menuitem',{name:'清空聊天',exact:true}).click();
      await page.locator('.empty-hero').waitFor();
      holdAnswer=false;
      for (const route of held) { try { await route.fulfill({json:responseBody}); } catch { /* the client already aborted */ } }
      await page.waitForTimeout(100);
      assert.equal(await page.locator('.message').count(),0);
      assert.equal(await page.getByRole('button',{name:'停止等待回答',exact:true}).count(),0);
      assert.equal(await page.locator('.oa-chat-error').count(),0);
      // The next question starts with no previous private chat history.
      await input.fill('清空后重新开始'); await input.press('Enter');
      await page.waitForFunction(()=>document.querySelectorAll('.message.assistant math').length===4);
      assert.deepEqual(JSON.parse(requests.filter(request=>request.path==='/api/lab-ai/ask').at(-1).body).history,[]);
      assert.deepEqual(errors,[]);`);
replace(browser, 'stopAndRetry:true,errors});', 'stopAndRetry:true,clearMenu:true,clearCancellation:true,clearPendingAnswer:true,sidebarIdentityOnly:true,approvalDashboardSeparated:true,errors});');
for (const [path, source] of files) await writeFile(path, source);
console.log('Chat header menu and approval dashboard separation integrated; source guards matched.');
