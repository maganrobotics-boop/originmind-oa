import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { register } from 'node:module';
register(new URL('./helpers/ai-workbench-loader.mjs', import.meta.url));
const { handleOaChatBridge, signOaChatRequest, OA_CHAT_PATH } = await import('../chat-cloudflare/src/oa-chat-bridge.mjs');
const secret = 'synthetic-test-secret-not-a-live-key'.repeat(2);
const input = { kind: 'document', title: '合成测试报告', instruction: '整理材料为报告', material: '本周完成接口联调，实机验收尚未进行。' };
let calls, budget, fallback, engine, seen;
beforeEach(() => {
  calls = 0; budget = 0; fallback = 0; seen = new Set();
  engine = {
    claimRequest: async nonce => { if (seen.has(nonce)) throw new Error('replay'); seen.add(nonce); },
    getModelConfig: async () => ({ model: 'synthetic-test-model' }),
    modelProvider: () => ({ provider: 'bailian' }),
    globalBudget: async () => { budget++; },
    modelCall: async (_context, _config, messages, maximum) => {
      calls++; assert.equal(maximum, 6000); assert.equal(JSON.parse(messages[1].content).sourceMaterial, input.material);
      return '# 合成测试报告\n\n已完成接口联调，实机验收待补充。';
    },
    workersAiCall: async () => { fallback++; throw new Error('unexpected provider switch'); },
  };
});
async function send(payload = { operation: 'task', task: input }, overrides = {}, options = {}) {
  const body = JSON.stringify(payload), headers = { ...await signOaChatRequest(body, secret, options), ...overrides };
  return handleOaChatBridge({ request: new Request(`https://chat.omindos.ai${OA_CHAT_PATH}`, { method: 'POST', headers, body }), env: { PUBLIC_LAB_AI_SERVICE_TOKEN: secret, AI: { run() {} } } }, engine);
}
test('signed private task uses the configured Bailian path and its budget check', async () => {
  const response = await send(); assert.equal(response.status, 200); assert.equal((await response.json()).provider, 'bailian');
  assert.equal(calls, 1); assert.equal(budget, 1); assert.equal(fallback, 0);
});
test('task route rejects tools, browser-origin requests and bad signatures before generation', async () => {
  assert.equal((await send({ operation: 'task', task: { ...input, tools: ['send'] } })).status, 400);
  for (const headers of [{ authorization: 'bad' }, { origin: 'https://oa.omindos.ai' }, { cookie: 'session=synthetic' }]) assert.equal((await send(undefined, headers)).status, 401);
  assert.equal(calls, 0); assert.equal(budget, 0);
});
test('neither an unconfigured provider nor a Bailian failure silently switches providers', async () => {
  engine.modelProvider = () => ({ provider: 'workers-ai' }); assert.equal((await send()).status, 503); assert.equal(calls, 0);
  engine.modelProvider = () => ({ provider: 'bailian' }); engine.modelCall = async () => { calls++; throw new Error('synthetic upstream failure'); };
  assert.equal((await send()).status, 503); assert.equal(fallback, 0); assert.equal(calls, 1);
});
test('truncated output and repeated nonces cannot be accepted as fresh successful tasks', async () => {
  const nonce = crypto.randomUUID(); assert.equal((await send(undefined, {}, { nonce })).status, 200);
  assert.equal((await send(undefined, {}, { nonce })).status, 503); assert.equal(calls, 1);
  engine.modelCall = async () => '本次回答尚未完整生成，请继续。'; assert.equal((await send()).status, 502);
});
test('budget rejection stops the task before a model call', async () => {
  engine.globalBudget = async () => { throw new Error('synthetic budget limit'); };
  assert.equal((await send()).status, 503); assert.equal(calls, 0); assert.equal(fallback, 0);
});
