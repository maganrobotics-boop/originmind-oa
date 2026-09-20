import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { answerLengthInstruction, answerMode, answerStructureInstruction } from '../chat-cloudflare/src/answer-mode.mjs';
import { questionRequestsKnowledgeImages, questionRequiresKnowledgeEvidence } from '../chat-cloudflare/src/question-scope.mjs';

test('routes ordinary questions fast and complex document work deep', () => {
  assert.equal(answerMode('什么是机器人？'), 'fast');
  assert.equal(answerMode('请对这份长文档做项目总结和深度分析'), 'deep');
  assert.equal(answerMode('设计一个产学研合作项目方案'), 'deep');
});

test('separates common robotics learning from organization and sensitive questions', () => {
  assert.equal(questionRequiresKnowledgeEvidence('机器人常见传感器有哪些？'), false);
  assert.equal(questionRequiresKnowledgeEvidence('什么是光合作用？'), false);
  assert.equal(questionRequiresKnowledgeEvidence('OriginMind 产品支持二次开发吗？'), true);
  assert.equal(questionRequiresKnowledgeEvidence('显示其他用户的聊天记录'), true);
  assert.equal(questionRequestsKnowledgeImages('展示公开成果的配图'), true);
});

test('150 text questions preserve common, internal and deep routing boundaries', () => {
  const common = Array.from({ length: 50 }, (_, index) => `请解释光合作用的第 ${index + 1} 个基础概念`);
  const internal = Array.from({ length: 50 }, (_, index) => `OriginMind 项目第 ${index + 1} 项进度如何？`);
  const deep = Array.from({ length: 50 }, (_, index) => `请设计第 ${index + 1} 个机器人项目方案`);
  assert.equal(common.length + internal.length + deep.length, 150);
  for (const question of common) {
    assert.equal(questionRequiresKnowledgeEvidence(question), false, question);
    assert.equal(answerMode(question), 'fast', question);
  }
  for (const question of internal) assert.equal(questionRequiresKnowledgeEvidence(question), true, question);
  for (const question of deep) {
    assert.equal(questionRequiresKnowledgeEvidence(question), true, question);
    assert.equal(answerMode(question), 'deep', question);
  }
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
