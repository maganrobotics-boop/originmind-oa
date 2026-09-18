import test from 'node:test';
import assert from 'node:assert/strict';
import { initialChatIndicators, probeChatIndicators, pendingChatIndicators, replyChatIndicators, failedChatIndicators } from '../lib/oa-chat-indicators.mjs';
const states = snapshot => snapshot.items.map(item => item.state);
test('five named indicators start unknown', () => {
  const value = initialChatIndicators();
  assert.equal(value.items.length, 5);
  assert.equal(new Set(value.items.map(item => item.label)).size, 5);
  assert.deepEqual(states(value), Array(5).fill('unknown'));
});
test('healthy probes cannot report that an answer was generated', () => {
  const value = probeChatIndicators(200, { authorized: true, bridgeReady: true, budgetReady: true, modelReady: true, retrievalReady: true, knowledgeReady: true });
  assert.deepEqual(states(value), ['ready', 'ready', 'ready', 'ready', 'unknown']);
  assert.match(value.summary, /不代表/);
});
test('probe 429 and 5xx do not misreport a logged-out member', () => {
  for (const code of [400, 429, 500, 502, 503]) assert.deepEqual(states(probeChatIndicators(code)), ['ready', 'unknown', 'unknown', 'unknown', 'unknown']);
  for (const code of [401, 403]) assert.equal(probeChatIndicators(code).items[1].state, 'unavailable');
  assert.equal(probeChatIndicators(null).items[0].state, 'warning');
});
test('unavailable bridge and exhausted budget cannot be green', () => {
  for (const override of [{ bridgeReady: false }, { budgetReady: false }]) {
    assert.equal(probeChatIndicators(200, { modelReady: true, ...override }).items[2].state, 'unavailable');
  }
  assert.equal(probeChatIndicators(200, {}).items[2].state, 'unknown');
});
test('pending and generated answers have distinct evidence', () => {
  assert.equal(pendingChatIndicators().items[4].state, 'pending');
  assert.deepEqual(states(replyChatIndicators({ mode: 'ai', answer: '完整回答' })), Array(5).fill('ready'));
});
test('HTTP-200 retrieval fallback lights agree with the displayed failure', () => {
  for (const fallbackReason of ['shared_model_unavailable', 'model_unavailable', 'generation_failed', 'answer_validation_failed', undefined]) {
    const value = replyChatIndicators({ mode: 'retrieval', answer: '已检索到相关资料，但未能生成完整答复', fallbackReason });
    assert.deepEqual(states(value), ['ready', 'ready', 'unavailable', 'ready', 'unavailable']);
    assert.match(value.summary, /检索成功，回答生成失败/);
  }
});
test('no evidence is not a model outage or generated answer', () => {
  assert.deepEqual(states(replyChatIndicators({ mode: 'no_evidence', answer: '没有资料' })), ['ready', 'ready', 'unknown', 'warning', 'unknown']);
});
test('missing mode and empty AI answers never produce five green lights', () => {
  for (const value of [{ answer: '提示' }, { mode: 'ai', answer: '' }, null, [], { mode: 'unknown' }]) assert.notEqual(replyChatIndicators(value).items[4].state, 'ready');
});
test('transport failure, 401, 429, and cancellation remain distinct', () => {
  assert.equal(failedChatIndicators().items[0].state, 'warning');
  assert.equal(failedChatIndicators(401).items[1].state, 'unavailable');
  assert.equal(failedChatIndicators(429).items[1].state, 'unknown');
  assert.equal(failedChatIndicators(null, true).items[4].state, 'unknown');
});
