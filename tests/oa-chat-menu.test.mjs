import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('chat header replaces duplicate identity with the conversation menu and keeps one sidebar account', async () => {
  const page = await read('app/page.tsx');
  assert.match(page, /activeView === "knowledge" && knowledgeTab === "ask" \? <OaConversationMenu \/> : <button/u);
  assert.match(page, /aria-label="打开个人账户菜单"/u);
  assert.match(page, /className="oa-sidebar-account"/u);
  assert.match(page, /<OaConversationProvider/u);
  assert.match(page, /<OaConversationTitle><OaChatStatus \/><\/OaConversationTitle>/u);
});

test('approval dashboard has no AI shortcut while the knowledge sidebar and admission gates remain', async () => {
  const page = await read('app/page.tsx');
  assert.doesNotMatch(page, /dashboard-ai-entry|进入 OA 内部实验室 AI/u);
  assert.match(page, /tab: "ask", label: "AI 助手"/u);
  assert.match(page, /className="stats-grid"/u);
  assert.match(page, /if \(needsNda\) return/u);
  assert.match(page, /if \(!session\.registered\) return/u);
});

test('confirmed AI clearing remounts fresh local state and invalidates pending requests before aborting', async () => {
  const [panel, context] = await Promise.all([read('components/knowledge/oa-chat-panel.tsx'),read('components/knowledge/oa-conversation-context.tsx')]);
  assert.match(context,/window\.confirm\('清空当前 AI 聊天/u);
  assert.match(context,/setAiEpoch\(value => value \+ 1\)/u);
  assert.match(panel, /<OaAiChatPanel key=\{aiEpoch\} \/>/u);
  assert.match(panel, /useEffect\(\(\) => \(\) => \{ requestSequence\.current\+\+; requestRef\.current\?\.abort\(\); \}, \[\]\)/u);
  assert.match(panel,/if \(sequence !== requestSequence\.current\) return/u);
  for (const initial of ["useState('')","useState<Turn[]>([])","useState(false)"]) assert.ok(panel.includes(initial));
  const clear=context.slice(context.indexOf('  const resetAi ='),context.indexOf('  return <Context.Provider'));
  assert.doesNotMatch(clear,/fetch\(|localStorage|DELETE|knowledge\/|approvals\//u);
  assert.doesNotMatch(panel,/oa-conversation-tools|aria-label="开始新聊天"/u);
});

test('accessible header controls use a right-side drawer and never use global cross-page clear events', async () => {
  const [panel,context] = await Promise.all([read('components/knowledge/oa-chat-panel.tsx'),read('components/knowledge/oa-conversation-context.tsx')]);
  const drawer = context.match(/<Sheet\s[^>]*>/u)?.[0];
  assert.ok(drawer, 'the conversation selector must use a Sheet');
  assert.match(drawer,/\bopen=\{open\}/u);
  assert.match(drawer,/\bonOpenChange=\{changeOpen\}/u);
  assert.match(context,/<SheetContent side="right"/u);
  assert.match(context,/aria-label="聊天选项"/u);
  assert.match(context,/const focus = chat\.clearCurrent\(\)/u);
  assert.match(context,/disabled=\{!chat\.peer && !chat\.aiDirty\}/u);
  assert.match(context,/requestAnimationFrame/u);
  assert.doesNotMatch(panel+context,/dispatchEvent|addEventListener\(['"]clear/u);
});

test('sidebar uses laboratory model and AI assistant names without changing destinations', async () => {
  const page = await read('app/page.tsx');
  assert.ok(page.includes('<span>实验室大模型</span>'));
  assert.ok(page.includes('aria-label="实验室大模型"'));
  assert.doesNotMatch(page, /大模型与资料|label: "AI 聊天"/u);
  assert.ok(page.includes('if (tab === "ask") conversation.showAi(); onKnowledgeTab(tab);'));
});
