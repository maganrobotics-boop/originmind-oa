import assert from 'node:assert/strict';
import test from 'node:test';
import { executeTaskTools, TASK_TOOLS, parseTaskTable, taskTableStatistics } from '../lib/ai-workbench-tools.mjs';
import { taskDocx } from '../lib/ai-workbench-docx.mjs';
import { createTaskToolModel } from '../chat-cloudflare/src/task-tool-model.mjs';

// Synthetic model/HTTP responses; all source tools, decimal arithmetic, OOXML
// production, request serialization and response validation below are real code.
const input = { kind: 'weekly_report', title: '工具执行测试', instruction: '整理本周材料并说明待补充内容', material: '完成底盘联调。\n定位测试尚未完成。' };
const markdown = '# 工具执行测试\n\n## 本周进展\n已完成底盘联调。\n\n## 待完成\n定位测试尚未完成，负责人和日期待补充。';
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (...calls) => ({ finishReason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls } });
const read = id => call('read_material', { from_line: 1, count: 40 }, id);
const finish = (id, value = markdown) => call('prepare_document', { markdown: value }, id);
function scripted(...responses) { let i = 0; return async () => { assert.ok(i < responses.length, 'unexpected extra model call'); return responses[i++]; }; }
const run = (...responses) => executeTaskTools(input, scripted(...responses));

test('registry is deeply immutable and only contains four bounded tools', () => {
  assert.equal(TASK_TOOLS.length, 4);
  assert.throws(() => { TASK_TOOLS[0].function.name = 'shell'; }, TypeError);
  assert.ok(TASK_TOOLS.every(t => t.function.parameters.additionalProperties === false));
});
test('actual source tool -> tool response -> real Word artifact, not narrative success', async () => {
  let turns = 0;
  const result = await executeTaskTools(input, async request => {
    turns++;
    assert.equal(request.tools.length, 4);
    assert.equal(JSON.parse(request.messages[1].content).sourceMaterial, input.material);
    assert.match(request.messages[0].content, /不可信数据/);
    if (turns === 1) return reply(read('read1'));
    const output = JSON.parse(request.messages.at(-1).content);
    assert.equal(request.messages.at(-1).tool_call_id, 'read1');
    assert.equal(output.data.text, input.material);
    return reply(finish('finish1'));
  });
  assert.equal(result.answer, markdown);
  assert.equal(result.execution.state, 'prepared');
  assert.equal(result.execution.modelCalls, 2);
  const actual = taskDocx(input.title, markdown);
  assert.equal(result.execution.artifact.docxBytes, actual.length);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', actual)), n => n.toString(16).padStart(2, '0')).join('');
  assert.equal(result.execution.artifact.docxSha256, digest);
  assert.equal(result.execution.steps.length, 2);
  assert.ok(!JSON.stringify(result.execution).includes(input.material));
});
test('same-round multiple calls are handled sequentially through terminal tool', async () => {
  const result = await run(reply(read('a'), call('search_material', { query: '定位' }, 'b'), finish('c')));
  assert.deepEqual(result.execution.steps.map(s => s.tool), ['read_material', 'search_material', 'prepare_document']);
});
test('repeated read calls use cached results, with truthful trace', async () => {
  const result = await run(reply(read('a')), reply(read('b')), reply(finish('c')));
  assert.equal(result.execution.steps[1].reused, true);
});
test('literal search handles regex-looking text without executing regex', async () => {
  const source = { ...input, material: '安全材料。\n特殊查询 (a+)+$ 仍为文字。' };
  let i = 0;
  await executeTaskTools(source, async ({ messages }) => {
    if (!i++) return reply(call('search_material', { query: '(a+)+$' }, 'a'));
    const output = JSON.parse(messages.at(-1).content);
    assert.equal(output.data.matches[0].line, 2);
    return reply(finish('b'));
  });
});
test('document preparation before a source tool is rejected and may be corrected', async () => {
  const result = await run(reply(finish('a')), reply(read('b')), reply(finish('c')));
  assert.equal(result.execution.steps[0].code, 'TASK_SOURCE_REQUIRED');
});
test('extra tool arguments cannot select a file, owner, URL or outside data', async () => {
  const result = await run(reply(call('read_material', { from_line: 1, count: 40, owner: 'another-member' }, 'a')), reply(read('b')), reply(finish('c')));
  assert.equal(result.execution.steps[0].code, 'TASK_TOOL_ARGUMENTS');
});
test('source range errors are explicit and may be corrected', async () => {
  const result = await run(reply(call('read_material', { from_line: 500, count: 40 }, 'a')), reply(read('b')), reply(finish('c')));
  assert.equal(result.execution.steps[0].code, 'TASK_SOURCE_RANGE');
});
test('invalid JSON arguments are tool errors, not evaluated code', async () => {
  const bad = read('a'); bad.function.arguments = '{not JSON}';
  const result = await run(reply(bad), reply(read('b')), reply(finish('c')));
  assert.equal(result.execution.steps[0].status, 'error');
});
for (const name of ['shell', 'send_mail', 'delete_file', 'constructor', '__proto__']) {
  test(`unregistered tool ${name} is rejected before executing the batch`, async () => {
    await assert.rejects(run(reply(read('a'), call(name, {}, 'b'))), /TASK_MODEL_PROTOCOL/);
  });
}
test('terminal tool must be last, preventing unfinished side operations', async () => {
  await assert.rejects(run(reply(finish('a'), read('b'))), /TASK_TOOL_ORDER/);
});
test('duplicate tool IDs are rejected within and across rounds', async () => {
  await assert.rejects(run(reply(read('a'), read('a'))), /TASK_MODEL_PROTOCOL/);
  await assert.rejects(run(reply(read('a')), reply(finish('a'))), /TASK_MODEL_PROTOCOL/);
});
test('a model saying done without an artifact fails closed', async () => {
  await assert.rejects(run({ finishReason: 'stop', message: { role: 'assistant', content: '已保存文档并发给所有成员。' } }), /TASK_NO_ARTIFACT/);
});
test('token-truncated tool requests cannot create an artifact', async () => {
  const value = reply(read('a'), finish('b')); value.finishReason = 'length';
  await assert.rejects(run(value), /TASK_NO_ARTIFACT/);
});
test('unsafe or incomplete document arguments cannot produce success', async () => {
  for (const value of ['<script>alert(1)</script>', '本次回答尚未完整生成，稍后继续处理。', '![图片](https://example.invalid/private.png)']) {
    const result = await run(reply(read('a')), reply(finish('b', value)), reply(finish('c')));
    assert.equal(result.execution.steps[1].code, 'TASK_TOOL_ARGUMENTS');
  }
});
test('six model rounds and twelve tool steps bound repeated work', async () => {
  let counter = 0;
  await assert.rejects(executeTaskTools(input, async () => reply(read(`r${counter++}`))), /TASK_TOOL_LIMIT/);
  assert.equal(counter, 6);
  counter = 0;
  await assert.rejects(executeTaskTools(input, async () => reply(...Array.from({ length: 4 }, () => read(`r${counter++}`)))), /TASK_TOOL_LIMIT/);
});
test('deadline is checked before and after a model call', async () => {
  let calls = 0, now = 0;
  await assert.rejects(executeTaskTools(input, async () => { calls++; }, { deadline: 0, now: () => 0 }), /TASK_TOOL_TIMEOUT/);
  assert.equal(calls, 0);
  await assert.rejects(executeTaskTools(input, async () => { now = 2; return reply(read('a'), finish('b')); }, { deadline: 1, now: () => now }), /TASK_TOOL_TIMEOUT/);
});
test('caller cannot inject capabilities in task input', async () => {
  await assert.rejects(executeTaskTools({ ...input, tools: ['shell'] }, scripted()), /TASK_INVALID_INPUT/);
});
test('CSV parser supports CRLF, quotes, commas and quoted newlines', () => {
  assert.deepEqual(parseTaskTable('名称,数值\r\n"A, B",1\r\n"C\nD",2\r\n', ','), [['名称', '数值'], ['A, B', '1'], ['C\nD', '2']]);
  assert.deepEqual(parseTaskTable('名字,值\n"a""b",2', ','), [['名字', '值'], ['a"b', '2']]);
});
test('decimal statistics use source data with exact sum, min, max', () => {
  const result = taskTableStatistics('项目,值\nA,0.1\nB,0.2', '值', 'comma');
  assert.deepEqual([result.count, result.sum, result.mean, result.min, result.max], [2, '0.3', '0.15', '0.1', '0.2']);
});
test('mean rounding is explicit, including negative half-way values', () => {
  const result = taskTableStatistics('v\n-0.000001\n0', 'v', 'comma');
  assert.equal(result.mean, '-0.000001'); assert.match(result.precision, /half-away/);
});
test('TSV statistics are accepted and no rows are dropped', () => {
  const result = taskTableStatistics('x\tv\na\t2\nb\t4\nc\t6', 'v', 'tab');
  assert.equal(result.sum, '12'); assert.equal(result.count, 3);
});
for (const bad of ['x,x\n1,2', 'x,y\n1', 'x\n"bad', 'x\n"1"garbage']) {
  test(`malformed table is rejected: ${JSON.stringify(bad)}`, () => assert.throws(() => parseTaskTable(bad, ','), /TASK_TABLE_INVALID/));
}
for (const value of ['', 'abc', 'NaN', '1e6', '=2+2', '2%', '1.0000001', '9999999999999']) {
  test(`non-numeric or unsupported cell is never silently ignored: ${JSON.stringify(value)}`, () => {
    assert.throws(() => taskTableStatistics(`name,value\na,${value}\nb,2`, 'value', 'comma'), /TASK_TABLE_NON_NUMERIC/);
  });
}
test('unknown column is explicit', () => assert.throws(() => taskTableStatistics('x\n1', 'missing', 'comma'), /TASK_TABLE_COLUMN_MISSING/));
test('table row and column limits reject oversized data', () => {
  assert.throws(() => parseTaskTable('x\n' + '1\n'.repeat(1001), ','), /TASK_TABLE_LIMIT/);
  assert.throws(() => parseTaskTable(Array.from({ length: 65 }, (_, i) => `v${i}`).join(',') + '\n1', ','), /TASK_TABLE_LIMIT/);
});
test('model table tool operates on the original source, then returns actual statistics', async () => {
  let turn = 0;
  await executeTaskTools({ ...input, material: '项目,数值\nA,1.2\nB,2.3' }, async ({ messages }) => {
    if (!turn++) return reply(call('table_statistics', { column: '数值', delimiter: 'comma' }, 'a'));
    assert.equal(JSON.parse(messages.at(-1).content).data.sum, '3.5');
    return reply(finish('b'));
  });
});
const response = value => Response.json(value);
const modelReply = { choices: [{ message: reply(read('a')).message, finish_reason: 'tool_calls' }] };
function transport(options = {}) {
  return createTaskToolModel({ endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'synthetic-test-key', model: 'qwen-plus', fetcher: async () => response(modelReply), consumeBudget: async () => {}, ...options });
}
const request = () => ({ messages: [{ role: 'user', content: '合成测试，不是真实材料' }], tools: TASK_TOOLS, deadline: Date.now() + 5000 });
test('Bailian transport sends actual tools and charges each request separately', async () => {
  let budget = 0, fetches = 0;
  const model = transport({ consumeBudget: async () => { budget++; }, fetcher: async (url, options) => {
    fetches++; assert.equal(url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.tools.length, 4); assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.enable_thinking, false); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, 'Bearer synthetic-test-key');
    assert.ok(!options.body.includes('synthetic-test-key'));
    return response(modelReply);
  } });
  assert.equal((await model(request())).finishReason, 'tool_calls');
  await model(request()); assert.equal(budget, 2); assert.equal(fetches, 2);
});
for (const endpoint of ['http://dashscope.aliyuncs.com/compatible-mode/v1', 'https://example.invalid/compatible-mode/v1', 'https://dashscope.aliyuncs.com/compatible-mode/v1?key=x', 'https://dashscope.aliyuncs.com/other']) {
  test('transport rejects unapproved endpoint ' + endpoint, () => assert.throws(() => transport({ endpoint }), /TASK_MODEL_CONFIG/));
}
test('verified Beijing workspace endpoint is accepted', () => assert.doesNotThrow(() => transport({ endpoint: 'https://workspace-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' })));
test('budget exhaustion prevents the HTTP call', async () => {
  let fetches = 0;
  const model = transport({ consumeBudget: async () => { throw new Error('BUDGET'); }, fetcher: async () => { fetches++; } });
  await assert.rejects(model(request()), /BUDGET/); assert.equal(fetches, 0);
});
for (const status of [302, 401, 429, 500]) {
  test(`HTTP ${status} fails without retries, redirects or provider fallback`, async () => {
    let count = 0;
    const model = transport({ fetcher: async () => { count++; return new Response('not exposed', { status, headers: { location: 'https://example.invalid' } }); } });
    await assert.rejects(model(request()), /TASK_MODEL_HTTP/); assert.equal(count, 1);
  });
}
test('transport rejects HTML and invalid JSON', async () => {
  await assert.rejects(transport({ fetcher: async () => new Response('<html>') })(request()), /TASK_MODEL_PROTOCOL/);
  await assert.rejects(transport({ fetcher: async () => new Response('{bad', { headers: { 'content-type': 'application/json' } }) })(request()), /TASK_MODEL_PROTOCOL/);
});
test('transport bounds declared and actual response bytes', async () => {
  for (const big of [new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '262145' } }), new Response('x'.repeat(262145), { headers: { 'content-type': 'application/json' } })]) {
    await assert.rejects(transport({ fetcher: async () => big })(request()), /TASK_MODEL_RESPONSE_LIMIT/);
  }
});
test('transport rejects missing or ambiguous completion choices', async () => {
  for (const value of [{}, { choices: [] }, { choices: [modelReply.choices[0], modelReply.choices[0]] }]) {
    await assert.rejects(transport({ fetcher: async () => response(value) })(request()), /TASK_MODEL_PROTOCOL/);
  }
});
test('oversized model request is rejected before budget use', async () => {
  let budget = 0;
  await assert.rejects(transport({ consumeBudget: async () => { budget++; } })({ ...request(), messages: [{ role: 'user', content: 'x'.repeat(205000) }] }), /TASK_TOOL_CONTEXT_LIMIT/);
  assert.equal(budget, 0);
});
test('transport deadline prevents a request and rechecks after budget wait', async () => {
  let now = 0, count = 0;
  const model = transport({ now: () => now, consumeBudget: async () => { now = 2; }, fetcher: async () => { count++; } });
  await assert.rejects(model({ ...request(), deadline: 0 }), /TASK_TOOL_TIMEOUT/);
  await assert.rejects(model({ ...request(), deadline: 1 }), /TASK_TOOL_TIMEOUT/);
  assert.equal(count, 0);
});

test('blank table rows are retained, and numeric statistics reject them instead of treating them as zero', () => {
  assert.equal(parseTaskTable('x\n1\n\n', ',').length, 3);
  assert.throws(() => taskTableStatistics('x\n1\n\n', 'x', 'comma'), /TASK_TABLE_NON_NUMERIC/);
});
test('non-string tool call identifiers are rejected', async () => {
  const value = read('a'); value.id = 1;
  await assert.rejects(run(reply(value)), /TASK_MODEL_PROTOCOL/);
});
test('document table expansion and excessive lines are bounded before Word generation', async () => {
  for (const value of ['# test\n' + '|c'.repeat(25) + '|\n|---|---|', '# test\n' + 'a\n'.repeat(1501)]) {
    const result = await run(reply(read('a')), reply(finish('b', value)), reply(finish('c')));
    assert.equal(result.execution.steps[1].code, 'TASK_TOOL_ARGUMENTS');
  }
});
