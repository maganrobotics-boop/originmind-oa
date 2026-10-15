import assert from 'node:assert/strict';
import test from 'node:test';
import { ASSISTANT_CAPABILITIES, operationTools, serviceAuthority, validCapabilities, validOperationTool } from '../integrations/server-maintenance/operation-policy.mjs';
import { executeAssistantOperation, operationSummary } from '../integrations/server-maintenance/operation-runner.mjs';
import { createServerAgentConversation } from '../integrations/server-maintenance/agent-conversation.mjs';
import { validServerAgentPayload } from '../integrations/server-maintenance/tool-policy.mjs';

const capabilities = [...ASSISTANT_CAPABILITIES];
const actor = 'a'.repeat(64), jobId = 'b'.repeat(32), version = 'c'.repeat(64);
const tool = (name, args, id = 'tool_1') => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const reply = message => ({ message, finishReason: message.tool_calls ? 'tool_calls' : 'stop' });
const final = text => reply({ role: 'assistant', content: text });

function runnerFixture(call) {
  return { state: { pendingOperations: {} }, cache: new Map(), capabilities, serviceGrants: [], call };
}
function agentFixture(replies, call, extra = {}) {
  const models = [], handler = createServerAgentConversation();
  const model = async payload => {
    assert.equal(validServerAgentPayload(payload), true);
    models.push(structuredClone(payload));
    const next = replies.shift();
    if (!next) throw new Error('synthetic model exhausted');
    return typeof next === 'function' ? next(payload) : next;
  };
  return { models, send: (question, options = {}) => handler({ actor, question, capabilities, model, call, ...extra, ...options }) };
}

test('only explicit configured capability names offer operations', () => {
  assert.equal(validCapabilities(capabilities), true);
  for (const value of [['root'], ['files', 'files'], 'commands', null, [...capabilities, 'sudo']]) assert.equal(validCapabilities(value), false);
  assert.deepEqual(operationTools([]), []);
  const names = operationTools(['files']).map(item => item.function.name);
  assert.deepEqual(names, ['assistant_capabilities', 'workspace_file']);
  assert.equal(validOperationTool('command_start', { server: 'aliyun', command: 'id' }, ['files']), false);
});

test('workspace writes require versions and reject escaping paths and extra authority', () => {
  const write = { server: 'aliyun', operation: 'write', path: 'results/report.txt', content: 'hello', expectedSha256: 'new' };
  assert.equal(validOperationTool('workspace_file', write, capabilities), true);
  assert.equal(validOperationTool('workspace_file', { ...write, expectedSha256: version }, capabilities), true);
  for (const value of [{ ...write, expectedSha256: undefined }, { ...write, expectedSha256: 'latest' },
    { ...write, path: '/etc/nginx/nginx.conf' }, { ...write, path: '../production' },
    { ...write, path: 'foo/../production' }, { ...write, path: 'foo\\bar' }, { ...write, actor },
    { ...write, operation: 'read' }, { ...write, operation: 'trash' }, { ...write, destination: 'other.txt' }]) {
    assert.equal(validOperationTool('workspace_file', value, capabilities), false);
  }
  assert.equal(validOperationTool('workspace_file', { server: 'tencent', operation: 'list', path: '' }, capabilities), true);
  assert.equal(validOperationTool('workspace_file', { server: 'tencent', operation: 'read', path: '' }, capabilities), false);
});

test('command schema cannot add root identity, overwrite request IDs, or bypass bounds', () => {
  const command = { server: 'tencent', command: 'python3 -c "print(1+1)"', timeoutSeconds: 30 };
  assert.equal(validOperationTool('command_start', command, capabilities), true);
  for (const value of [{ ...command, user: 'root' }, { ...command, requestId: jobId },
    { ...command, server: 'other' }, { ...command, timeoutSeconds: 91 }, { ...command, timeoutSeconds: 9 },
    { ...command, command: 'x'.repeat(4001) }, { ...command, command: 'bad\0value' }]) {
    assert.equal(validOperationTool('command_start', value, capabilities), false);
  }
  assert.equal(validOperationTool('command_status', { server: 'aliyun', jobId }, capabilities), true);
  assert.equal(validOperationTool('command_status', { server: 'aliyun', jobId, actor }, capabilities), false);
});

test('service authority comes from current imperative and fixed server ownership', () => {
  assert.deepEqual(serviceAuthority('重启阿里云 OA'), [{ server: 'aliyun', service: 'originmind-oa', verb: 'restart' }]);
  assert.deepEqual(serviceAuthority('重新启动腾讯云 nginx'), [{ server: 'tencent', service: 'nginx', verb: 'restart' }]);
  for (const question of ['不要重启腾讯云 nginx', '可以重启腾讯云 nginx 吗？', '“重启腾讯云 nginx”', '如何重启腾讯云 nginx', '重启 nginx']) {
    assert.deepEqual(serviceAuthority(question), []);
  }
  assert.equal(validOperationTool('service_control', { server: 'aliyun', service: 'originmind-cloud-mcp', verb: 'restart' }, capabilities), false);
  assert.equal(validOperationTool('service_control', { server: 'aliyun', service: 'nginx', verb: 'stop' }, capabilities), false);
});

test('file operations map to the signed backend protocol and duplicate mutations share one receipt', async () => {
  const calls = [], options = runnerFixture(async (server, action, parameters) => {
    calls.push({ server, action, ...parameters });
    return { ok: true, server, action, ...parameters, written: true, bytes: 5, sha256: version };
  });
  const args = { server: 'aliyun', operation: 'write', path: 'report.txt', content: 'hello', expectedSha256: 'new' };
  const first = await executeAssistantOperation('workspace_file', args, options);
  const repeated = await executeAssistantOperation('workspace_file', args, options);
  assert.deepEqual(first, repeated); assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'operations'); assert.equal(calls[0].operation, 'file_write');
  assert.match(calls[0].requestId, /^[a-f0-9]{32}$/u);
  assert.equal(calls[0].expectedSha256, 'new'); assert.deepEqual(options.state.pendingOperations, {});
  assert.equal(operationSummary(first), '工作区文件已保存');
});

test('uncertain mutation retries preserve the same request ID instead of repeating as a new write', async () => {
  const ids = []; let attempt = 0;
  const options = runnerFixture(async (server, action, parameters) => {
    ids.push(parameters.requestId);
    if (++attempt === 1) throw new Error('synthetic lost response after possible write');
    return { ok: true, server, action, operation: parameters.operation, idempotent: true };
  });
  const args = { server: 'tencent', operation: 'mkdir', path: 'results' };
  await assert.rejects(executeAssistantOperation('workspace_file', args, options));
  assert.equal(Object.keys(options.state.pendingOperations).length, 1);
  assert.equal((await executeAssistantOperation('workspace_file', args, options)).idempotent, true);
  assert.equal(ids[0], ids[1]); assert.deepEqual(options.state.pendingOperations, {});
});

test('command start polls actual job status, preserving the command receipt action and job identity', async () => {
  const calls = [], options = runnerFixture(async (server, action, parameters) => {
    calls.push({ server, action, ...parameters });
    return { ok: true, server, action, operation: parameters.operation, jobId,
      state: parameters.operation === 'command_start' ? 'running' : 'succeeded',
      exitCode: parameters.operation === 'command_start' ? null : 0, output: '2\n' };
  });
  const result = await executeAssistantOperation('command_start', { server: 'aliyun', command: 'printf 2' }, options);
  assert.equal(result.action, 'operations'); assert.equal(result.operation, 'command_start');
  assert.equal(result.jobId, jobId); assert.equal(result.state, 'succeeded'); assert.equal(result.exitCode, 0);
  assert.deepEqual(calls.map(item => item.operation), ['command_start', 'job_status']);
  assert.equal(calls[0].timeoutSeconds, 60);
  assert.deepEqual(calls[1], { server: 'aliyun', action: 'operations', operation: 'job_status', jobId });
});

test('mismatched operation and polled job receipts cannot confirm a command', async () => {
  await assert.rejects(executeAssistantOperation('command_status', { server: 'aliyun', jobId }, runnerFixture(async () => ({ operation: 'file_write' }))), /INVALID_OPERATION_RECEIPT/u);
  await assert.rejects(executeAssistantOperation('command_start', { server: 'aliyun', command: 'printf 2' }, runnerFixture(async (_server, _action, parameters) => ({
    operation: parameters.operation, jobId: parameters.operation === 'command_start' ? jobId : 'd'.repeat(32), state: 'running',
  }))), /INVALID_JOB_RECEIPT/u);
});

test('service execution has a second current-instruction check independent of model tool validation', async () => {
  let calls = 0;
  const options = runnerFixture(async (_server, _action, parameters) => { calls++; return { operation: 'service', ...parameters, statusVerified: true }; });
  const args = { server: 'tencent', service: 'nginx', verb: 'restart' };
  await assert.rejects(executeAssistantOperation('service_control', args, options), error => error.operationError === 'current_service_instruction_required');
  assert.equal(calls, 0);
  options.serviceGrants = [{ server: 'tencent', service: 'nginx', verb: 'restart' }];
  const result = await executeAssistantOperation('service_control', args, options);
  assert.equal(result.service, 'nginx.service'); assert.equal(calls, 1);
});

test('parent loop applies real UI tool action and carries only verified action receipts to the browser', async () => {
  const f = agentFixture([reply(tool('ui_layout', { layout: 'expanded' })), final('页面已铺满。')], async () => { throw new Error('UI must not call a server'); });
  const result = await f.send('请把助手页面铺满');
  assert.deepEqual(result.uiActions, ['expand_layout']);
  assert.equal(result.operationConfirmed, true);
  assert.deepEqual(result.steps[0], { server: 'interface', action: 'ui_layout', ok: true, summary: '当前助手页面已铺满' });
  assert.equal(JSON.parse(f.models[1].messages.at(-1).content).appliesInBrowser, true);
});

test('parent loop reports operation remaps and version conflicts without manufacturing a success', async () => {
  let attempt = 0; const calls = [];
  const f = agentFixture([reply(tool('workspace_file', { server: 'aliyun', operation: 'write', path: 'report.txt', content: 'new', expectedSha256: version })),
    payload => { assert.equal(JSON.parse(payload.messages.at(-1).content).code, 'file_version_conflict'); return final('文件已变化，本次未保存。'); }],
  async (server, action, parameters) => {
    attempt++; calls.push({ server, action, ...parameters });
    throw Object.assign(new Error('synthetic backend conflict'), { operationError: 'file_version_conflict' });
  });
  const result = await f.send('更新阿里云工作区报告');
  assert.equal(attempt, 1); assert.equal(calls[0].operation, 'file_write'); assert.equal(calls[0].expectedSha256, version);
  assert.equal(result.operationConfirmed, false); assert.equal(result.steps[0].ok, false);
  assert.equal(result.steps[0].action, 'workspace_file');
  assert.doesNotMatch(JSON.stringify(result), /synthetic backend/u);
});

test('parent validates every model call before allowing any earlier write in the same batch', async () => {
  let calls = 0;
  const message = tool('workspace_file', { server: 'aliyun', operation: 'write', path: 'safe.txt', content: 'safe', expectedSha256: 'new' });
  message.tool_calls.push(tool('sudo', { server: 'aliyun', command: 'id' }, 'tool_2').tool_calls[0]);
  const f = agentFixture([reply(message)], async () => { calls++; });
  const result = await f.send('保存工作区文件');
  assert.equal(calls, 0); assert.equal(result.operationConfirmed, false); assert.deepEqual(result.steps, []);
});

test('service instructions from an earlier turn cannot authorize a new restart', async () => {
  const calls = [];
  const f = agentFixture([reply(tool('service_control', { server: 'tencent', service: 'nginx', verb: 'restart' })), final('腾讯 nginx 重启回执已核对。'),
    payload => { assert.ok(!payload.capabilities.includes('services')); return reply(tool('service_control', { server: 'tencent', service: 'nginx', verb: 'restart' })); }],
  async (server, action, parameters) => { calls.push(parameters); return { ok: true, server, action, ...parameters, statusVerified: true }; });
  const first = await f.send('重启腾讯云 nginx');
  assert.equal(first.operationConfirmed, true); assert.equal(first.steps[0].action, 'operations:service');
  const second = await f.send('只查看当前状态', { conversationId: first.conversationId });
  assert.equal(calls.length, 1); assert.equal(second.operationConfirmed, false);
});

test('running, failed and uncertain command states remain unconfirmed in the parent result', async () => {
  for (const state of ['running', 'failed', 'uncertain']) {
    const f = agentFixture([reply(tool('command_status', { server: 'aliyun', jobId })), final('任务结果以回执为准。')],
      async (server, action, parameters) => ({ ok: true, server, action, ...parameters, state, exitCode: state === 'failed' ? 1 : null }));
    const result = await f.send('查刚才命令运行结果');
    assert.equal(result.operationConfirmed, false); assert.equal(result.steps[0].action, 'operations:job_status');
    assert.equal(result.steps[0].ok, false);
  }
});

test('web search requires evidence and failed search cannot be represented as confirmed', async () => {
  const f = agentFixture([reply(tool('web_search', { query: '今天深圳天气' })), payload => {
    assert.equal(JSON.parse(payload.messages.at(-1).content).ok, false);
    return final('联网搜索未取得来源，尚不能核实。');
  }], async () => { throw new Error('search must not call a server'); }, { webSearch: async () => ({ searched: true, answer: '晴天', sources: [] }) });
  const result = await f.send('查今天深圳天气');
  assert.equal(result.operationConfirmed, false); assert.equal(result.steps[0].action, 'web_search');
});
