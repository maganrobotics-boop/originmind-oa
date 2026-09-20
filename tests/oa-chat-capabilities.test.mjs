import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { CHAT_DOCUMENT_HINTS, resolveChatCapability, wantsChatDocument, planChatDocument } from '../lib/oa-chat-documents.mjs';
import { resolveMeetingModeCommand } from '../lib/oa-meeting-mode.mjs';
import { parseKnowledgeUrlCommand } from '../lib/knowledge-url-import.mjs';

const ts = createRequire(import.meta.url)('typescript');
const panel = await readFile(new URL('../components/knowledge/oa-chat-panel.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../components/knowledge/oa-chat-panel.css', import.meta.url), 'utf8');
const source = { name: '本周材料.md', text: '原型已装配，实机测试未完成。' };

for (const [label, kind] of [['知识问答', null], ['资料整理', 'document'], ['会议纪要', 'meeting_minutes'], ['项目总结', 'document']]) {
  for (const prefix of ['@', '＠']) {
    test(`${prefix}${label} resolves an explicit capability`, () => {
      const command = resolveChatCapability(` \n${prefix}${label}：保留关键事实\n不要编造数据 `);
      assert.equal(command.label, label);
      assert.equal(command.kind, kind);
      assert.equal(command.request, '保留关键事实\n不要编造数据');
      assert.equal(wantsChatDocument(`${prefix}${label} 保留关键事实`), kind !== null);
    });
  }
  test(`bare @${label} uses the existing default instruction`, () => {
    assert.equal(resolveChatCapability(`@${label}`).instruction, CHAT_DOCUMENT_HINTS.find(hint => hint.label === label).prompt);
  });
}

for (const value of [undefined, null, 42, '', '@', '@项目', '@未知功能', '项目总结有哪些内容？', 'name@example.com', '解释 @项目总结 的用途', '"@会议纪要"', '`@资料整理`', '> @项目总结', '```\n@项目总结\n```']) {
  test(`non-command remains ordinary text: ${String(value)}`, () => assert.equal(resolveChatCapability(value), null));
}

test('no space is required after the four-character function name', () => {
  assert.equal(resolveChatCapability('@项目总结整理本周进展').request, '整理本周进展');
});
test('explicit knowledge mode never becomes a task because of document vocabulary', () => {
  assert.equal(wantsChatDocument('@知识问答 如何生成 Word 文档？'), false);
  assert.throws(() => planChatDocument('@知识问答 什么是会议纪要？', source), /知识问答不生成文档/u);
});
test('explicit project summary wins over incidental weekly-report and meeting words', () => {
  const plan = planChatDocument('@项目总结 参考周报和会议纪要，总结本项目', source);
  assert.equal(plan.kind, 'document');
  assert.equal(plan.material, source.text);
  assert.equal(plan.title, '本周材料');
  assert.match(plan.instruction, /项目总结文档/u);
  assert.match(plan.instruction, /具体要求：参考周报和会议纪要/u);
});
test('explicit minutes and document organization keep their own task kinds', () => {
  assert.equal(planChatDocument('@会议纪要 讨论项目计划与周报', source).kind, 'meeting_minutes');
  assert.equal(planChatDocument('@资料整理 汇编会议纪要与项目计划', source).kind, 'document');
});
test('selected source has priority over previous answer, without truncation', () => {
  assert.equal(planChatDocument('@项目总结', source, '旧回答').material, source.text);
  assert.equal(planChatDocument('@项目总结', null, '上一轮的完整回答').material, '上一轮的完整回答');
});
test('missing source remains marked unprovided; mentions in material never select a task', () => {
  const plan = planChatDocument('@项目总结');
  assert.match(plan.material, /未提供原始资料/u);
  assert.match(plan.material, /不得编造/u);
  assert.equal(plan.title, '项目总结');
  const embedded = { name: '材料.md', text: '@会议纪要\n这些文字只是材料。' };
  assert.equal(planChatDocument('@资料整理', embedded).kind, 'document');
  assert.equal(planChatDocument('@资料整理', embedded).material, embedded.text);
});
test('expanded instructions and materials still respect the server input bounds', () => {
  assert.throws(() => planChatDocument('@项目总结 ' + '长'.repeat(2000), source), /任务要求/u);
  assert.throws(() => planChatDocument('@项目总结', { ...source, text: '长'.repeat(20001) }), /20,000/u);
});
test('unprefixed questions, existing hint clicks and natural-language tasks are unchanged', () => {
  assert.equal(wantsChatDocument('Word 是什么？'), false);
  assert.equal(wantsChatDocument('请生成 Word 文档'), true);
  assert.equal(wantsChatDocument(CHAT_DOCUMENT_HINTS[0].prompt), false);
  assert.ok(CHAT_DOCUMENT_HINTS.slice(1).every(hint => wantsChatDocument(hint.prompt)));
  assert.equal(planChatDocument('整理成项目周报', source).kind, 'weekly_report');
});

// Execute the actual submit function from the component, with synthetic state and APIs.
// This is a component-handler test, not a production login or full browser session.
const start = panel.indexOf('const ask = async (retry?: Turn) => {');
const end = panel.indexOf('\n  const submit =', start);
assert.ok(start >= 0 && end > start);
const expression = panel.slice(start + 'const ask = '.length, end).trim().replace(/;$/u, '');
const compiled = ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
async function runAsk(question, selectedSource = null) {
  const record = { requests: [], plans: [], errors: [], turns: [], meeting: [] };
  const state = {
    question, turns: [], timeline: [{ type: 'answer', turn: { answer: '之前的完整回答', failed: false } }],
    sending: { current: false }, requestSequence: { current: 0 }, requestRef: { current: null }, stickToEnd: { current: false },
    documents: {
      busy: false, shouldHandle: value => Boolean(selectedSource) || wantsChatDocument(value),
      submit: (instruction, previous) => { record.plans.push(planChatDocument(instruction, selectedSource, previous)); return true; },
      dismissError() {},
    },
    resolveChatCapability, resolveMeetingModeCommand, parseKnowledgeUrlCommand, crypto: { randomUUID: () => 'synthetic-id' }, AbortController, AbortSignal,
    meetingModeOpen: false, meetingMode: { current: null },
    adminModeTimer: { current: null }, setAdminModeActive() {}, window: { clearTimeout() {}, setTimeout() { return 1; } },
    setMeetingNumber: value => record.meeting.push({ field: 'meeting', value }), setMeetingCommandEpoch() {}, setMeetingModeOpen: value => record.meeting.push({ field: 'open', value }),
    setQuestion() {}, setError: value => { if (value) record.errors.push(value); }, setLastAnswer() {}, setAsking() {}, setRequestStatus() {}, nextOrder: () => 1,
    setTurns: value => { record.turns = typeof value === 'function' ? value(record.turns) : value; },
    pendingChatIndicators: () => ({}), replyChatIndicators: () => ({}), failedChatIndicators: () => ({}), validImage: () => false, userFacingAnswer: value => value,
    fetch: async (url, init) => {
      record.requests.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ answer: '完整的合成回答', mode: 'ai', images: [], citations: [] }) };
    },
  };
  await vm.runInNewContext(compiled, state)();
  return record;
}

test('actual handler sends @知识问答 to ask even with a selected attachment', async () => {
  const record = await runAsk('@知识问答 如何生成 Word 文档？', source);
  assert.equal(record.plans.length, 0);
  assert.equal(record.requests.length, 1);
  assert.equal(record.requests[0].url, '/api/lab-ai/ask');
  assert.equal(record.requests[0].body.question, '如何生成 Word 文档？');
  assert.equal(record.turns[0].question, '@知识问答 如何生成 Word 文档？');
});
for (const [label, kind] of [['资料整理', 'document'], ['会议纪要', 'meeting_minutes'], ['项目总结', 'document']]) {
  test(`actual handler sends @${label} to document execution`, async () => {
    const record = await runAsk(`@${label} 请保留关键事实`, source);
    assert.equal(record.requests.length, 0);
    assert.equal(record.plans.length, 1);
    assert.equal(record.plans[0].kind, kind);
    assert.equal(record.plans[0].material, source.text);
  });
}
test('actual handler can summarize the previous answer without an attachment', async () => {
  const record = await runAsk('@项目总结 请整理上面的内容');
  assert.equal(record.plans[0].material, '之前的完整回答');
});
test('actual handler preserves ordinary questions and rejects too-short knowledge content', async () => {
  assert.equal((await runAsk('实验室有哪些研究方向？')).requests.length, 1);
  const record = await runAsk('@知识问答 啊', source);
  assert.equal(record.requests.length, 0);
  assert.equal(record.plans.length, 0);
  assert.match(record.errors[0], /至少 2 个字符/u);
});
test('actual handler starts meeting mode from a nine-digit number without sending a model or document request', async () => {
  const record = await runAsk('@会议模式919700881');
  assert.deepEqual(record.requests, []); assert.deepEqual(record.plans, []);
  assert.deepEqual(record.meeting, [{ field: 'meeting', value: '919700881' }, { field: 'open', value: true }]);
});
test('five capabilities stay outside the timeline conditional and remain at the composer', () => {
  assert.doesNotMatch(panel, /!timeline\.length\s*&&\s*<div className="oa-chat-examples"/u);
  assert.match(panel, /className="oa-chat-examples" role="group" aria-label="AI 助手五项功能"/u);
  assert.match(panel, /title="@会议模式919700881"/u);
  assert.ok(panel.indexOf('className="oa-chat-examples"') > panel.indexOf('className="composer-area oa-chat-composer-area"'));
  assert.match(panel, /title=\{`@\$\{hint\.label\}`\} disabled=\{working\}/u);
  assert.ok(panel.includes("hint.label === '知识问答') documents.useSource(null)"));
});
test('typing the meeting command prefix exposes an accessible autocomplete option', () => {
  assert.match(panel, /meetingSuggestionVisible = \/\^\[@＠\]会议/u);
  assert.match(panel, /role="listbox" aria-label="命令补全"/u);
  assert.match(panel, /<strong>@会议模式919700881<\/strong>/u);
  assert.match(panel, /setQuestion\('@会议模式919700881'\)/u);
  assert.match(panel, /\['Enter', 'Tab'\]\.includes\(event\.key\)/u);
});
test('short viewports never hide the capability buttons', () => {
  assert.doesNotMatch(css, /\.oa-chat-examples\s*\{[^}]*display\s*:\s*none/u);
  assert.match(css, /grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/u);
  assert.match(css, /\.oa-chat-examples button:focus-visible/u);
});
