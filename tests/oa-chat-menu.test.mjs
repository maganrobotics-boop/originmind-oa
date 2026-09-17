import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('chat header replaces duplicate identity with a scoped menu host while keeping the sidebar account', async () => {
  const page = await read('app/page.tsx');
  assert.match(page, /activeView === "knowledge" && knowledgeTab === "ask" \? <div className="oa-chat-menu-host" ref=\{setChatActionsTarget\} \/> : <button/u);
  assert.match(page, /className="sidebar-user-name">\{userName\}/u);
  assert.match(page, /aria-label="打开个人账户菜单"/u);
  assert.match(page, /chatActionsTarget=\{chatActionsTarget\}/u);
});

test('approval dashboard has no AI shortcut while the knowledge sidebar and admission gates remain', async () => {
  const page = await read('app/page.tsx');
  assert.doesNotMatch(page, /dashboard-ai-entry|进入 OA 内部实验室 AI/u);
  assert.match(page, /tab: "ask", label: "AI 聊天"/u);
  assert.match(page, /className="stats-grid"/u);
  assert.match(page, /if \(needsNda\) return/u);
  assert.match(page, /if \(!session\.registered\) return/u);
});

test('clear is a confirmed local action that invalidates pending answers before aborting', async () => {
  const panel = await read('components/knowledge/oa-chat-panel.tsx');
  const start = panel.indexOf('  const clearChat = () => {');
  const end = panel.indexOf('  const copy =',start);
  assert.ok(start>=0 && end>start);
  const clear = panel.slice(start,end);
  assert.match(clear, /if \(!window\.confirm\(/u);
  assert.ok(clear.indexOf('requestSequence.current++') < clear.indexOf('requestRef.current?.abort()'));
  for (const reset of ["setTurns([])","setQuestion('')","setAsking(false)","setError('')","setCopied('')"]) assert.ok(clear.includes(reset));
  assert.doesNotMatch(clear,/fetch\(|localStorage|DELETE|knowledge\/|approvals\//u);
  assert.doesNotMatch(panel,/oa-conversation-tools|aria-label="开始新聊天"/u);
});

test('the header uses an accessible menu without global cross-page clear events', async () => {
  const [panel,knowledge] = await Promise.all([read('components/knowledge/oa-chat-panel.tsx'),read('components/knowledge/knowledge-view.tsx')]);
  assert.match(panel,/createPortal\(<DropdownMenu modal=\{false\}>/u);
  assert.match(panel,/aria-label="聊天选项"/u);
  assert.match(panel,/onSelect=\{clearChat\}/u);
  assert.match(panel,/onCloseAutoFocus=/u);
  assert.match(knowledge,/KnowledgeAskPanel actionsTarget=\{chatActionsTarget\}/u);
  assert.doesNotMatch(panel,/dispatchEvent|addEventListener\(['"]clear/u);
});
