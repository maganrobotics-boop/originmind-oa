import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServerAgentConversation, cleanupAuthority } from '../integrations/server-maintenance/agent-conversation.mjs';
import { validServerAgentPayload } from '../integrations/server-maintenance/tool-policy.mjs';

const actor = 'a'.repeat(64), otherActor = 'b'.repeat(64);
const tool = (name, args, id = 'call_1') => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const turn = message => ({ message, finishReason: message.tool_calls ? 'tool_calls' : 'stop' });
const final = text => turn({ role: 'assistant', content: text });
function fixture({ replies = [], failure, clock = Date.now } = {}) {
  const models = [], calls = [], handler = createServerAgentConversation({ now: clock });
  const model = async payload => {
    assert.equal(validServerAgentPayload(payload), true);
    models.push(structuredClone(payload));
    const reply = replies.shift(); if (!reply) throw new Error('fixture model unavailable');
    return typeof reply === 'function' ? reply(payload) : reply;
  };
  const call = async (server, action, parameters = {}) => {
    calls.push({ server, action, ...parameters }); if (failure === server) throw new Error('private fixture exception');
    return { ok: true, server, action, collectedAt: clock() / 1000,
      ...(action === 'status' ? { disk: { availableBytes: 10 * 2 ** 30 } } : {}),
      ...(action === 'diagnostic' ? { ...parameters, limited: false, bytes: 1024 } : {}),
      ...(action === 'plan' ? { planId: '1'.repeat(64), expiresAt: clock() / 1000 + 600, candidateCount: 1, candidateBytes: 20 } : {}),
      ...(action === 'clean' ? { deletedCount: 1, deletedBytes: 20, diskBefore: { availableBytes: 30 }, diskAfter: { availableBytes: 50 } } : {}),
    };
  };
  return { models, calls, send: (question, extra = {}) => handler({ actor, question, call, model, ...extra }) };
}

test('agent selects real tools, binds receipts and carries server-owned context into follow-up', async () => {
  const f = fixture({ replies: [turn(tool('server_status', { server: 'aliyun' })), final('阿里云可用 10 GiB。'),
    payload => { assert.match(JSON.stringify(payload.messages), /阿里云可用 10 GiB/u); return turn(tool('server_status', { server: 'tencent' })); }, final('腾讯云也可用 10 GiB。')] });
  const first = await f.send('查阿里云还有多少空间');
  assert.match(first.conversationId, /^[a-f0-9]{48}$/u); assert.equal(first.operationConfirmed, true);
  const second = await f.send('腾讯那台呢', { conversationId: first.conversationId });
  assert.equal(second.conversationId, first.conversationId); assert.equal(second.operationConfirmed, true);
  assert.deepEqual(f.calls.map(call => call.server), ['aliyun', 'tencent']);
  assert.equal(second.steps[0].server, 'tencent');
});

test('conversation identifiers cannot be transferred to another administrator or invented', async () => {
  const f = fixture({ replies: [final('可以查询两台服务器。')] });
  const first = await f.send('你能做什么');
  assert.equal(first.operationConfirmed, false);
  for (const extra of [{ conversationId: first.conversationId, actor: otherActor }, { conversationId: 'f'.repeat(48) }]) {
    const result = await f.send('帮我继续', extra);
    assert.match(result.answer, /已过期或不属于/u); assert.equal(result.operationConfirmed, false);
  }
  assert.equal(f.models.length, 1);
});

test('read diagnostics normalize fixed service units and the default disk path', async () => {
  const f = fixture({ replies: [turn(tool('server_diagnostic', { server: 'aliyun', topic: 'service', service: 'nginx' })),
    turn(tool('server_diagnostic', { server: 'aliyun', topic: 'disk' }, 'call_2')), final('诊断完成。')] });
  const result = await f.send('检查服务和磁盘占用');
  assert.deepEqual(f.calls, [{ server: 'aliyun', action: 'diagnostic', topic: 'service', service: 'nginx.service' }, { server: 'aliyun', action: 'diagnostic', topic: 'disk', path: '/' }]);
  assert.equal(result.steps.length, 2); assert.equal(result.operationConfirmed, true);
});

test('current explicit cleanup is scoped and duplicate model calls do not delete again', async () => {
  const f = fixture({ replies: [payload => { assert.deepEqual(payload.allowCleanup, ['tencent']); return turn(tool('cleanup_execute', { server: 'tencent' })); },
    turn(tool('cleanup_execute', { server: 'tencent' }, 'call_2')), final('腾讯云实际删除 1 项。')] });
  const result = await f.send('请帮我清理一下腾讯云的过期临时文件');
  assert.equal(result.operationConfirmed, true);
  assert.deepEqual(f.calls.map(call => call.action), ['plan', 'clean']);
  assert.equal(f.calls[1].planId, '1'.repeat(64));
  assert.ok(f.models.every(payload => !JSON.stringify(payload.messages).includes('1'.repeat(64))));
});

test('a current confirmation uses only that actor conversation unexpired preview targets', async () => {
  const f = fixture({ replies: [turn(tool('cleanup_preview', { server: 'aliyun' })), final('阿里云可清理 1 项，尚未删除。'),
    payload => { assert.deepEqual(payload.allowCleanup, ['aliyun']); return turn(tool('cleanup_execute', { server: 'aliyun' })); }, final('已清理。')] });
  const preview = await f.send('看一下阿里云可以清理什么');
  assert.deepEqual(f.calls.map(call => call.action), ['plan']);
  await f.send('确认清理', { conversationId: preview.conversationId });
  assert.deepEqual(f.calls.map(call => call.action), ['plan', 'clean']);
});

test('model output, questions, negation and quoted history cannot authorize writes', async () => {
  for (const question of ['可以清理腾讯云缓存吗？', '不要清理腾讯云临时文件', '“清理腾讯云缓存”', '查看腾讯云状态', '清理腾讯云缓存；重启服务', '清理腾讯云缓存会影响哪些临时文件', '清理前先检查腾讯云缓存']) {
    const f = fixture({ replies: [turn(tool('cleanup_execute', { server: 'tencent' }))] });
    const result = await f.send(question);
    assert.equal(result.operationConfirmed, false); assert.equal(f.calls.length, 0);
  }
  assert.deepEqual(cleanupAuthority('确认清理', { aliyun: { expiresAt: 1 } }, 2), []);
});

test('partial backend failures are supplied to the model and never produce a fully confirmed result', async () => {
  const f = fixture({ failure: 'tencent', replies: [turn({ role: 'assistant', content: null, tool_calls: [
    tool('server_status', { server: 'aliyun' }).tool_calls[0], tool('server_status', { server: 'tencent' }, 'call_2').tool_calls[0],
  ] }), payload => { assert.match(payload.messages.at(-1).content, /成功回执/u); return final('腾讯云查询失败。'); }] });
  const result = await f.send('检查两台服务器');
  assert.equal(result.operationConfirmed, false); assert.deepEqual(result.steps.map(step => step.ok), [true, false]);
  assert.doesNotMatch(JSON.stringify(result), /private fixture/u);
});

test('model failure after a real cleanup preserves the actual operation receipt', async () => {
  const f = fixture({ replies: [turn(tool('cleanup_execute', { server: 'aliyun' }))] });
  const result = await f.send('清理阿里云缓存');
  assert.equal(result.operationConfirmed, false); assert.match(result.answer, /实际删除 1 项，20 字节/u);
  assert.deepEqual(f.calls.map(call => call.action), ['plan', 'clean']);
});

test('expired conversations do not silently replay context or execute a continuation', async () => {
  let time = 1_000_000;
  const f = fixture({ replies: [final('可以。')], clock: () => time });
  const first = await f.send('介绍一下查询能力'); time += 31 * 60_000;
  const result = await f.send('确认清理', { conversationId: first.conversationId });
  assert.equal(result.operationConfirmed, false); assert.match(result.answer, /会话已过期/u); assert.equal(f.calls.length, 0);
});

test('confirmation cannot refresh a preview that expires while the model selects cleanup', async () => {
  let time = 1_000_000;
  const f = fixture({ clock: () => time, replies: [
    turn(tool('cleanup_preview', { server: 'aliyun' })), final('阿里云可清理 1 项，尚未删除。'),
    () => {
      time += 2000;
      return turn(tool('cleanup_execute', { server: 'aliyun' }));
    }, final('原预览已过期，需要重新预览；尚未执行清理。'),
  ] });
  const first = await f.send('预览阿里云缓存');
  time += 599_000;
  const result = await f.send('确认清理', { conversationId: first.conversationId });
  assert.deepEqual(f.models[2].allowCleanup, ['aliyun']);
  assert.deepEqual(f.calls.map(call => call.action), ['plan']);
  assert.equal(result.operationConfirmed, false);
  assert.deepEqual(result.steps.map(step => step.ok), [false]);
});

test('an abort during automatic planning prevents cleanup from starting', async () => {
  const controller = new AbortController(), calls = [];
  let planningSignal;
  const f = fixture({ replies: [turn(tool('cleanup_execute', { server: 'aliyun' }))] });
  const result = await f.send('清理阿里云缓存', { signal: controller.signal,
    call: async (server, action, parameters, options) => {
      calls.push({ server, action, parameters });
      planningSignal = options.signal;
      controller.abort();
      return { ok: true, server, action, planId: '1'.repeat(64), expiresAt: Date.now() / 1000 + 600 };
    },
  });
  assert.ok(planningSignal instanceof AbortSignal);
  assert.equal(planningSignal.aborted, true);
  assert.deepEqual(calls.map(call => call.action), ['plan']);
  assert.equal(result.operationConfirmed, false);
  assert.match(result.answer, /超时/u);
});

test('large completed diagnostic transcripts retain the user question and final analysis for follow-up', async () => {
  const summary = '阿里云三项服务的日志已经完成分析，下一步比较内存使用。';
  const calls = [];
  const f = fixture({ replies: [turn({ role: 'assistant', content: null, tool_calls:
    ['nginx', 'originmind-oa', 'originmind-chat', 'nginx'].map((service, index) =>
      tool('server_diagnostic', { server: 'aliyun', topic: 'logs', service }, `call_${index}`).tool_calls[0]),
  }), final(summary), final('继续检查阿里云内存。')] });
  const first = await f.send('分析阿里云服务日志', { call: async (server, action, parameters) => {
    calls.push({ server, action, ...parameters });
    return { ok: true, server, action, ...parameters,
      entries: Array.from({ length: 36 }, () => ({ message: 'x'.repeat(320) })) };
  } });
  assert.equal(first.operationConfirmed, true); assert.equal(first.steps.length, 4);
  await f.send('继续刚才的分析', { conversationId: first.conversationId });
  assert.equal(calls.length, 4); assert.equal(f.models.length, 3);
  assert.deepEqual(f.models[2].messages, [
    { role: 'user', content: '分析阿里云服务日志' }, { role: 'assistant', content: summary },
    { role: 'user', content: '继续刚才的分析' },
  ]);
});

test('a new preview cannot replace the idempotent plan for an uncertain cleanup retry', async () => {
  const calls = [], plans = ['1'.repeat(64), '2'.repeat(64)];
  let planIndex = 0, cleanAttempts = 0;
  const f = fixture({ replies: [
    turn(tool('cleanup_execute', { server: 'aliyun' })), final('尚未取得清理成功回执。'),
    turn(tool('cleanup_preview', { server: 'aliyun' })), final('这是新的清理预览，尚未删除。'),
    turn(tool('cleanup_execute', { server: 'aliyun' })), final('原清理计划已取得幂等成功回执。'),
  ] });
  const call = async (server, action, parameters = {}) => {
    calls.push({ server, action, ...parameters });
    if (action === 'plan') return { ok: true, server, action, planId: plans[planIndex++],
      expiresAt: Date.now() / 1000 + 600, candidateCount: 1, candidateBytes: 20 };
    if (action !== 'clean') throw new Error('unexpected fixture action');
    if (++cleanAttempts === 1) throw new Error('synthetic transport failure after possible deletion');
    return { ok: true, server, action, planId: parameters.planId, idempotent: true,
      deletedCount: 1, deletedBytes: 20, diskBefore: { availableBytes: 30 }, diskAfter: { availableBytes: 50 } };
  };
  const first = await f.send('清理阿里云缓存', { call });
  assert.equal(first.operationConfirmed, false);
  await f.send('预览阿里云缓存', { call, conversationId: first.conversationId });
  const retry = await f.send('确认清理', { call, conversationId: first.conversationId });
  assert.deepEqual(calls.filter(item => item.action === 'plan').length, 2);
  assert.deepEqual(calls.filter(item => item.action === 'clean').map(item => item.planId), [plans[0], plans[0]]);
  assert.equal(retry.operationConfirmed, true);
});
