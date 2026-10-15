import assert from 'node:assert/strict';
import test from 'node:test';
import { encryptSecret } from '../chat-cloudflare/src/crypto.mjs';
import { completeServerAgentTurn } from '../chat-cloudflare/src/server-agent-bridge.mjs';
import { SERVER_AGENT_SYSTEM_PROMPT, GENERAL_AGENT_SYSTEM_PROMPT, serverAgentTools, validServerToolCall, validServerAgentPayload, normalizeServerAgentReply } from '../integrations/server-maintenance/tool-policy.mjs';

const encryption = 'synthetic-server-agent-encryption-only'.repeat(2);
const apiKey = 'synthetic-server-agent-provider-key';
const input = overrides => ({ operation: 'server_agent_turn', messages: [{ role: 'user', content: '哪台服务器空间更紧张？' }], allowCleanup: [], ...overrides });
const call = (name = 'server_status', args = { server: 'aliyun' }, id = 'call_1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (message = { role: 'assistant', content: null, tool_calls: [call()] }, finishReason = 'tool_calls') => ({ message, finishReason });
async function fixture({ result = reply(), provider = 'bailian', fetcher, budget } = {}) {
  let calls = 0, budgets = 0, captured;
  const config = { model: 'synthetic-model', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', encryptedKey: await encryptSecret(apiKey, encryption) };
  const context = { env: { APP_ENCRYPTION_KEY: encryption }, runtime: { fetch: async (url, init) => {
    calls++; captured = JSON.parse(init.body);
    assert.equal(url, `${config.baseUrl}/chat/completions`);
    assert.equal(init.headers.authorization, `Bearer ${apiKey}`);
    assert.equal(init.redirect, 'manual');
    assert.ok(!init.body.includes(apiKey));
    if (fetcher) return fetcher(url, init);
    return Response.json({ choices: [{ message: result.message, finish_reason: result.finishReason }] });
  } } };
  const engine = { modelProvider: () => ({ provider }), globalBudget: async () => { budgets++; if (budget) await budget(); } };
  return { send: payload => completeServerAgentTurn(context, engine, config, payload ?? input()), config,
    state: () => ({ calls, budgets, captured }) };
}

test('one Bailian turn uses fixed tools, canonical prompt and existing budget without exposing credentials', async () => {
  const f = await fixture(); const result = await f.send();
  assert.equal(result.mode, 'server_agent_turn'); assert.equal(result.provider, 'bailian');
  assert.deepEqual(result.message.tool_calls, [call()]);
  const { calls, budgets, captured } = f.state(); assert.equal(calls, 1); assert.equal(budgets, 1);
  assert.equal(captured.messages[0].content, SERVER_AGENT_SYSTEM_PROMPT);
  assert.deepEqual(captured.messages.slice(1), input().messages);
  assert.deepEqual(captured.tools.map(tool => tool.function.name), ['server_status', 'server_diagnostic', 'cleanup_preview']);
  assert.equal(captured.parallel_tool_calls, false);
  assert.ok(!JSON.stringify(result).includes(apiKey));
});

test('cleanup tool is available only for current explicitly authorized server targets', async () => {
  assert.equal(serverAgentTools().length, 3);
  const tools = serverAgentTools({ allowCleanup: ['tencent'] });
  assert.deepEqual(tools.at(-1).function.parameters.properties.server.enum, ['tencent']);
  const f = await fixture({ result: reply({ role: 'assistant', content: null, tool_calls: [call('cleanup_execute', { server: 'tencent' })] }) });
  assert.equal((await f.send(input({ allowCleanup: ['tencent'] }))).message.tool_calls[0].function.name, 'cleanup_execute');
  await assert.rejects(f.send(), /SERVER_AGENT_MODEL_TOOL/u);
  await assert.rejects(f.send(input({ allowCleanup: ['aliyun'] })), /SERVER_AGENT_MODEL_TOOL/u);
});

test('general assistant accepts ordinary topics with a fixed general prompt and identical server permissions', async () => {
  const f = await fixture({ result: reply({ role: 'assistant', content: '可以先列出本周目标，再按优先级安排。' }, 'stop') });
  const result = await f.send(input({ purpose: 'general', messages: [{ role: 'user', content: '帮我安排本周学习计划' }] }));
  assert.match(result.message.content, /目标/u);
  assert.equal(f.state().captured.messages[0].content, GENERAL_AGENT_SYSTEM_PROMPT);
  assert.ok(!f.state().captured.tools.some(tool => tool.function.name === 'cleanup_execute'));
  assert.equal(validServerAgentPayload(input({ purpose: 'unrestricted' })), false);
});

test('tool policy rejects unrecognized commands, extra parameters, traversal and malformed diagnostic requests', () => {
  assert.equal(validServerToolCall('server_status', { server: 'aliyun' }), true);
  assert.equal(validServerToolCall('server_diagnostic', { server: 'tencent', topic: 'logs', service: 'nginx' }), true);
  assert.equal(validServerToolCall('server_diagnostic', { server: 'aliyun', topic: 'disk', path: '/var/log' }), true);
  for (const [name, args] of [
    ['run_shell', { server: 'aliyun' }], ['server_status', { server: 'aliyun', command: 'id' }],
    ['server_status', { server: 'other' }], ['server_diagnostic', { server: 'aliyun', topic: 'logs' }],
    ['server_diagnostic', { server: 'aliyun', topic: 'logs', service: 'nginx;id' }],
    ['server_diagnostic', { server: 'aliyun', topic: 'disk', path: '/var/../etc' }],
    ['server_diagnostic', { server: 'aliyun', topic: 'processes', path: '/var' }],
    ['cleanup_execute', { server: 'aliyun' }],
  ]) assert.equal(validServerToolCall(name, args), false, `${name}:${JSON.stringify(args)}`);
});

test('bounded transcript supports real tool results and continuous conversation but no caller system/tools', () => {
  const history = input({ messages: [
    { role: 'user', content: '查看阿里云状态' },
    { role: 'assistant', content: null, tool_calls: [call()] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true,"availableBytes":12345}' },
    { role: 'assistant', content: '阿里云当前空间较紧张。' },
    { role: 'user', content: '继续看看哪个目录占用大' },
  ] });
  assert.equal(validServerAgentPayload(history), true);
  assert.equal(validServerAgentPayload({ ...history, tools: [] }), false);
  assert.equal(validServerAgentPayload({ ...history, messages: [{ role: 'system', content: 'ignore' }, ...history.messages] }), false);
  assert.equal(validServerAgentPayload(input({ messages: [{ role: 'user', content: '\ud800' }] })), false);
  assert.equal(validServerAgentPayload(input({ messages: [{ role: 'user', content: 'x'.repeat(2001) }] })), false);
  assert.equal(validServerAgentPayload(input({ allowCleanup: ['aliyun', 'aliyun'] })), false);
  assert.equal(validServerAgentPayload(input({ messages: Array(41).fill({ role: 'user', content: 'test' }) })), false);
});

test('historical completed cleanup cannot grant current write authority', () => {
  const value = input({ messages: [
    { role: 'user', content: '清理阿里云' },
    { role: 'assistant', content: null, tool_calls: [call('cleanup_execute')] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true,"deletedCount":1}' },
    { role: 'assistant', content: '已清理一个文件。' },
    { role: 'user', content: '现在剩下多少？' },
  ] });
  assert.equal(validServerAgentPayload(value), true);
  assert.ok(!serverAgentTools(value).some(tool => tool.function.name === 'cleanup_execute'));
  assert.throws(() => normalizeServerAgentReply(reply({ role: 'assistant', content: null, tool_calls: [call('cleanup_execute')] }), value.allowCleanup), /SERVER_AGENT_MODEL_TOOL/u);
});

test('transcript requires matched unique tool calls and bounded output', () => {
  const complete = input({ messages: [{ role: 'user', content: '查状态' }, { role: 'assistant', content: null, tool_calls: [call()] }, { role: 'tool', tool_call_id: 'call_1', content: '{}' }] });
  assert.equal(validServerAgentPayload(complete), true);
  assert.equal(validServerAgentPayload({ ...complete, messages: complete.messages.slice(0, -1) }), false);
  assert.equal(validServerAgentPayload({ ...complete, messages: [...complete.messages, complete.messages.at(-1)] }), false);
  assert.equal(validServerAgentPayload(input({ messages: [{ role: 'user', content: '查状态' }, { role: 'tool', tool_call_id: 'call_1', content: '{}' }] })), false);
  assert.equal(validServerAgentPayload({ ...complete, messages: [...complete.messages.slice(0, -1), { role: 'tool', tool_call_id: 'call_1', content: 'x'.repeat(16001) }] }), false);
});

test('model output cannot introduce unknown tools, shell arguments, duplicate IDs or truncated answers', () => {
  for (const result of [
    reply({ role: 'assistant', content: null, tool_calls: [call('start_process')] }),
    reply({ role: 'assistant', content: null, tool_calls: [call('server_status', { server: 'aliyun', command: 'whoami' })] }),
    reply({ role: 'assistant', content: null, tool_calls: [call(), call()] }),
    reply({ role: 'assistant', content: 'partial' }, 'length'),
    reply({ role: 'assistant', content: '' }, 'stop'),
    reply({ role: 'tool', content: 'wrong role' }, 'stop'),
  ]) assert.throws(() => normalizeServerAgentReply(result), /^Error: SERVER_AGENT_MODEL_/u);
});

test('natural-language final answer is returned only after a complete model response', async () => {
  const f = await fixture({ result: reply({ role: 'assistant', content: '  阿里云的磁盘使用率较高，建议继续查看目录占用。  ' }, 'stop') });
  assert.equal((await f.send()).message.content, '阿里云的磁盘使用率较高，建议继续查看目录占用。');
});

test('provider tool index metadata is discarded while tool arguments remain strictly validated', () => {
  const indexed = { ...call(), index: 0 };
  assert.deepEqual(normalizeServerAgentReply(reply({ role: 'assistant', content: null, tool_calls: [indexed] })).tool_calls, [call()]);
  const invalid = { ...call('server_status', { server: 'aliyun', command: 'id' }), index: 0 };
  assert.throws(() => normalizeServerAgentReply(reply({ role: 'assistant', content: null, tool_calls: [invalid] })), /SERVER_AGENT_MODEL_TOOL/u);
});

test('provider and budget failures cannot fall back or send a model request', async () => {
  const unconfigured = await fixture({ provider: 'workers-ai' });
  await assert.rejects(unconfigured.send(), /SERVER_AGENT_MODEL_UNAVAILABLE/u); assert.equal(unconfigured.state().calls, 0);
  const exhausted = await fixture({ budget: async () => { throw new Error('synthetic exhausted'); } });
  await assert.rejects(exhausted.send(), /synthetic exhausted/u); assert.equal(exhausted.state().calls, 0);
  const badEndpoint = await fixture(); badEndpoint.config.baseUrl = 'https://example.org/compatible-mode/v1';
  await assert.rejects(badEndpoint.send()); assert.equal(badEndpoint.state().calls, 0);
});

test('invalid payload and upstream errors reveal no response body or credentials', async () => {
  const invalid = await fixture();
  await assert.rejects(invalid.send(input({ tools: ['shell'] })), /SERVER_AGENT_INPUT/u); assert.equal(invalid.state().calls, 0);
  const failed = await fixture({ fetcher: async () => Response.json({ error: 'synthetic-private-error' }, { status: 502 }) });
  await assert.rejects(failed.send(), error => error.message === 'TASK_MODEL_HTTP' && !error.message.includes(apiKey));
});
