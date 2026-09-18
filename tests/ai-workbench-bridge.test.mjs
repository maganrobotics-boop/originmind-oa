import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { handleOaChatBridge, signOaChatRequest, OA_CHAT_PATH } from '../chat-cloudflare/src/oa-chat-bridge.mjs';
import { encryptSecret } from '../chat-cloudflare/src/crypto.mjs';

// All upstream HTTP replies, keys and model decisions in this suite are synthetic.
// HMAC validation, key decryption, tool execution and document construction are real.
const secret = 'synthetic-test-secret-not-a-live-key'.repeat(2);
const encryption = 'synthetic-app-encryption-not-a-live-secret'.repeat(2);
const apiKey = 'synthetic-bailian-test-key';
const input = { kind: 'document', title: '合成测试报告', instruction: '整理材料为报告', material: '本周完成接口联调，实机验收尚未进行。' };
const markdown = '# 合成测试报告\n\n已完成接口联调，实机验收待补充。这是合成测试材料，不代表真实项目进展。';
let calls, budget, fallback, engine, seen, runtime, mode;
beforeEach(async () => {
  calls = 0; budget = 0; fallback = 0; seen = new Set(); mode = 'ok';
  const config = { model: 'synthetic-test-model', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', encryptedKey: await encryptSecret(apiKey, encryption) };
  engine = {
    claimRequest: async nonce => { if (seen.has(nonce)) throw new Error('replay'); seen.add(nonce); },
    getModelConfig: async () => config,
    modelProvider: () => ({ provider: 'bailian' }),
    globalBudget: async () => { budget++; },
    modelCall: async () => { throw new Error('legacy text-only task path must not be called'); },
    workersAiCall: async () => { fallback++; throw new Error('unexpected provider switch'); },
  };
  runtime = { fetch: async (url, init) => {
    calls++;
    assert.equal(url, config.baseUrl + '/chat/completions');
    assert.equal(init.headers.authorization, `Bearer ${apiKey}`);
    const body = JSON.parse(init.body);
    assert.equal(body.model, config.model); assert.equal(body.max_tokens, 6000);
    assert.equal(body.tools.length, 4); assert.equal(body.tool_choice, 'auto');
    assert.equal(JSON.parse(body.messages[1].content).sourceMaterial, input.material);
    assert.ok(!init.body.includes(apiKey));
    if (mode === 'http_failure') return Response.json({ error: 'synthetic upstream failure' }, { status: 502 });
    if (mode === 'truncated') return Response.json({ choices: [{ message: { role: 'assistant', content: '本次回答尚未完整生成，请继续。' }, finish_reason: 'length' }] });
    if (mode === 'narrative') return Response.json({ choices: [{ message: { role: 'assistant', content: '我已经保存并交付了文件。' }, finish_reason: 'stop' }] });
    const read = !body.messages.some(message => message.role === 'tool');
    const fn = read ? { name: 'read_material', arguments: JSON.stringify({ from_line: 1, count: 10 }) }
      : { name: 'prepare_document', arguments: JSON.stringify({ markdown }) };
    if (!read) {
      const receipt = JSON.parse(body.messages.at(-1).content);
      assert.equal(receipt.ok, true); assert.equal(receipt.data.text, input.material);
    }
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${calls}`, type: 'function', function: fn }] }, finish_reason: 'tool_calls' }] });
  } };
});
async function send(payload = { operation: 'task', task: input }, overrides = {}, options = {}) {
  const body = JSON.stringify(payload), headers = { ...await signOaChatRequest(body, secret, options), ...overrides };
  return handleOaChatBridge({ request: new Request(`https://chat.omindos.ai${OA_CHAT_PATH}`, { method: 'POST', headers, body }),
    env: { PUBLIC_LAB_AI_SERVICE_TOKEN: secret, APP_ENCRYPTION_KEY: encryption, AI: { run() {} } }, runtime }, engine);
}
test('signed private task executes Bailian tool calls and budgets each model turn', async () => {
  const response = await send(); assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.provider, 'bailian'); assert.equal(result.mode, 'task'); assert.equal(result.answer, markdown);
  assert.equal(result.execution.state, 'prepared'); assert.equal(result.execution.modelCalls, 2);
  assert.deepEqual(result.execution.steps.map(step => step.tool), ['read_material', 'prepare_document']);
  assert.match(result.execution.artifact.docxSha256, /^[a-f0-9]{64}$/u); assert.ok(result.execution.artifact.docxBytes > 500);
  assert.ok(!JSON.stringify(result).includes(apiKey));
  assert.equal(calls, 2); assert.equal(budget, 2); assert.equal(fallback, 0);
});
test('task route rejects client-supplied tools, browser origins, cookies and bad signatures before generation', async () => {
  assert.equal((await send({ operation: 'task', task: { ...input, tools: ['send'] } })).status, 400);
  for (const headers of [{ authorization: 'bad' }, { origin: 'https://oa.omindos.ai' }, { cookie: 'session=synthetic' }]) assert.equal((await send(undefined, headers)).status, 401);
  assert.equal(calls, 0); assert.equal(budget, 0);
});
test('neither an unconfigured provider nor a Bailian failure silently switches providers', async () => {
  engine.modelProvider = () => ({ provider: 'workers-ai' }); assert.equal((await send()).status, 503); assert.equal(calls, 0);
  engine.modelProvider = () => ({ provider: 'bailian' }); mode = 'http_failure';
  assert.equal((await send()).status, 503); assert.equal(fallback, 0); assert.equal(calls, 1); assert.equal(budget, 1);
});
test('truncated output and repeated nonces cannot become fresh successful tasks', async () => {
  const nonce = crypto.randomUUID(); assert.equal((await send(undefined, {}, { nonce })).status, 200);
  assert.equal((await send(undefined, {}, { nonce })).status, 503); assert.equal(calls, 2);
  mode = 'truncated'; assert.equal((await send()).status, 503); assert.equal(calls, 3);
});
test('budget rejection stops the task before an upstream model call', async () => {
  engine.globalBudget = async () => { throw new Error('synthetic budget limit'); };
  assert.equal((await send()).status, 503); assert.equal(calls, 0); assert.equal(fallback, 0);
});
test('model narrative claiming completion cannot replace actual artifact tool execution', async () => {
  mode = 'narrative'; assert.equal((await send()).status, 503); assert.equal(calls, 1); assert.equal(budget, 1);
});
