import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { answerLengthInstruction, answerMode, answerStructureInstruction } from '../chat-cloudflare/src/answer-mode.mjs';

test('routes ordinary questions fast and complex document work deep', () => {
  assert.equal(answerMode('什么是机器人？'), 'fast');
  assert.equal(answerMode('请对这份长文档做项目总结和深度分析'), 'deep');
});

test('applies default, short and deep answer length policies', () => {
  assert.match(answerLengthInstruction('介绍研究成果'), /300–600/u);
  assert.match(answerLengthInstruction('请简短回答'), /150–250/u);
  assert.match(answerLengthInstruction('做一份项目总结'), /500–900/u);
  assert.match(answerStructureInstruction(), /说明 \/ 依据 \/ 下一步/u);
});

test('OA reveals completed validated answers progressively while Chat preserves immediate durable history', async () => {
  const oa = await readFile(new URL('../components/knowledge/oa-chat-panel.tsx', import.meta.url), 'utf8');
  const chat = await readFile(new URL('../chat-cloudflare/frontend/app.js', import.meta.url), 'utf8');
  assert.match(oa, /fullAnswer\.slice\(0, length\)/u);
  assert.match(chat, /content:\s*userFacingAnswer\(payload\.answer\)/u);
});
