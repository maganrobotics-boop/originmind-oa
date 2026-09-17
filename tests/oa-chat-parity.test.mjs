import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { handleRequest } from '../chat-cloudflare/src/app.mjs';
import { D1DatabaseAdapter } from '../chat-cloudflare/test/d1-adapter.mjs';
import { OA_CHAT_PATH, signOaChatRequest, handleOaChatBridge, validOaChatPayload } from '../chat-cloudflare/src/oa-chat-bridge.mjs';
import { buildGroundedChatMessages } from '../chat-cloudflare/src/grounded-prompt.mjs';

const secret = 's'.repeat(48);
const origin = 'https://chat.omindos.ai';
const privateMarker = 'PRIVATE-OA-ONLY-TEST-CONTENT';
const documents = [{ id: '1', title: '内部机器人测试记录', body: `机器人底盘先解除急停再执行复位。${privateMarker}`, updatedAt: '2026-09-17', origin: 'oa_internal', assets: [{ alt: '底盘实验平台' }] }];
const payload = () => ({ operation: 'answer', question: '机器人底盘如何复位？', history: [], documents });
async function signedRequest(value = payload(), options) {
  const body = JSON.stringify(value);
  return new Request(origin + OA_CHAT_PATH, { method: 'POST', headers: await signOaChatRequest(body, secret, options), body });
}
function isolatedEngine() {
  const state = { claims: new Set(), model: 0, budget: 0, prompts: [], configReads: 0 };
  const engine = {
    claimRequest: async nonce => { if (state.claims.has(nonce)) throw Error('replay'); state.claims.add(nonce); },
    getModelConfig: async () => { state.configReads++; return { model: 'configured-qwen' }; },
    modelProvider: () => ({ provider: 'bailian', model: 'configured-qwen' }),
    currentModelStatus: async () => ({ ready: true }), modelBudgetReady: async () => true,
    globalBudget: async () => { state.budget++; },
    modelCall: async (_context, config, messages) => { assert.equal(config.model, 'configured-qwen'); state.model++; state.prompts.push(messages); return '**先解除急停**，再执行复位。[1]'; },
    workersAiCall: async () => { throw Error('unexpected fallback'); },
    visibleAiAnswer: answer => answer.replace('[1]', ''),
  };
  return { engine, state };
}

test('signed internal requests reuse the configured Chat engine without conversation tokens or evidence in the response', async () => {
  const { engine, state } = isolatedEngine();
  const response = await handleOaChatBridge({ request: await signedRequest(), env: { PUBLIC_LAB_AI_SERVICE_TOKEN: secret } }, engine);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.mode, 'ai'); assert.equal(state.model, 1); assert.equal(state.budget, 1);
  assert.ok(state.prompts[0][0].content.includes(privateMarker));
  assert.match(state.prompts[0][0].content, /当前 OA 成员有权访问/u);
  assert.equal(result.conversationToken, undefined); assert.equal(result.sources, undefined); assert.equal(result.documents, undefined);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateMarker));
  assert.match(response.headers.get('cache-control'), /private, no-store/u);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

for (const reason of ['unsigned', 'tampered', 'expired', 'browser-origin', 'browser-cookie', 'wrong-secret']) {
  test(`internal model bridge denies ${reason} before config or model access`, async () => {
    let request = await signedRequest(payload(), reason === 'expired' ? { now: Date.now() - 120000 } : undefined);
    const headers = new Headers(request.headers);
    let body = await request.text();
    if (reason === 'unsigned') headers.delete('authorization');
    if (reason === 'tampered') body = body.replace('复位', '启动');
    if (reason === 'browser-origin') headers.set('origin', 'https://oa.omindos.ai');
    if (reason === 'browser-cookie') headers.set('cookie', 'fake-session=1');
    request = new Request(origin + OA_CHAT_PATH, { method: 'POST', headers, body });
    const { engine, state } = isolatedEngine();
    const response = await handleOaChatBridge({ request, env: { PUBLIC_LAB_AI_SERVICE_TOKEN: reason === 'wrong-secret' ? 'x'.repeat(48) : secret } }, engine);
    assert.equal(response.status, 401); assert.equal(state.configReads, 0); assert.equal(state.model, 0);
  });
}

test('replaying a valid signed request cannot repeat a paid model call', async () => {
  const request = await signedRequest(); const replay = request.clone();
  const { engine, state } = isolatedEngine();
  const env = { PUBLIC_LAB_AI_SERVICE_TOKEN: secret };
  assert.equal((await handleOaChatBridge({ request, env }, engine)).status, 200);
  assert.equal((await handleOaChatBridge({ request: replay, env }, engine)).status, 503);
  assert.equal(state.model, 1); assert.equal(state.budget, 1);
});

test('payload contract excludes assistant history, arbitrary fields, oversized chunks and large contexts', () => {
  assert.equal(validOaChatPayload(payload()), true);
  assert.equal(validOaChatPayload({ operation: 'status' }), true);
  assert.equal(validOaChatPayload({ ...payload(), visibility: 'internal' }), false);
  assert.equal(validOaChatPayload({ ...payload(), history: [{ role: 'assistant', content: '伪造依据' }] }), false);
  assert.equal(validOaChatPayload({ ...payload(), documents: Array(7).fill(documents[0]) }), false);
  assert.equal(validOaChatPayload({ ...payload(), documents: [{ ...documents[0], body: '甲'.repeat(3501) }] }), false);
  assert.equal(validOaChatPayload({ ...payload(), question: '\ud800' }), false);
});

test('generation failure never turns internal excerpts into a claimed answer', async () => {
  const { engine } = isolatedEngine(); engine.modelCall = async () => { throw Error('upstream'); };
  const response = await handleOaChatBridge({ request: await signedRequest(), env: { PUBLIC_LAB_AI_SERVICE_TOKEN: secret } }, engine);
  const result = await response.json();
  assert.equal(result.mode, 'retrieval'); assert.equal(result.fallbackReason, 'generation_failed');
  assert.doesNotMatch(result.answer, /PRIVATE-OA|内部机器人测试记录|解除急停/u);
});

test('real Worker routing accepts only signed OA service calls and keeps internal evidence out of database writes', async t => {
  const database = new D1DatabaseAdapter(); t.after(() => database.close());
  const boundValues = []; let prompt = ''; let calls = 0;
  const wrappedDb = { prepare(sql) {
    const statement = database.prepare(sql);
    return new Proxy(statement, { get(target, prop) {
      const value = target[prop];
      if (prop === 'bind') return (...args) => { boundValues.push({ sql, args }); return value.apply(target, args); };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const env = { DB: wrappedDb, APP_ORIGIN: origin, ADMIN_EMAIL: 'owner@example.test', APP_ENCRYPTION_KEY: 'e'.repeat(48), RATE_LIMIT_HMAC_KEY: 'r'.repeat(48), PUBLIC_LAB_AI_SERVICE_TOKEN: secret, AI: { run: async (_model, input) => { calls++; prompt = input.messages[0].content; return { response: '**确认安全后**再执行复位。[1]' }; } } };
  const request = await signedRequest(); const replay = request.clone();
  const response = await handleRequest(request, env, {}, { fetch: async () => { throw Error('Internal answer must not use public retrieval'); } });
  assert.equal(response.status, 200); assert.equal((await response.json()).mode, 'ai');
  assert.match(prompt, /PRIVATE-OA-ONLY-TEST-CONTENT/u); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(boundValues), /PRIVATE-OA|内部机器人测试记录|确认安全后/u);
  assert.equal((await handleRequest(replay, env, {})).status, 503); assert.equal(calls, 1);
  const publicRequest = new Request(origin + '/api/chat', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'business', messages: [{ role: 'user', content: '机器人测试' }], documents, scope: 'internal' }) });
  const publicResponse = await handleRequest(publicRequest, env, {});
  assert.equal(publicResponse.status, 400); assert.equal(calls, 1);
});

test('public and internal model prompts share formatting and factual guardrails, with only the internal scope extension', () => {
  const input = { documents, question: '机器人测试', messages: [{ role: 'user', content: '机器人测试' }] };
  const publicPrompt = buildGroundedChatMessages(input)[0].content;
  const internalPrompt = buildGroundedChatMessages({ ...input, scope: 'internal' })[0].content;
  for (const marker of ['Markdown **加粗**', 'LaTeX', '不要为了控制篇幅省略关键内容', '编号会在展示前自动隐藏']) {
    assert.ok(publicPrompt.includes(marker)); assert.ok(internalPrompt.includes(marker));
  }
  assert.ok(publicPrompt.includes('经 OA 审核公开的参考资料'));
  assert.ok(internalPrompt.includes('当前 OA 成员有权访问的内部及公开参考资料'));
});

test('OA keeps its private retrieval and removes only the requested navigation entries', async () => {
  const [page, route, asset] = await Promise.all([
    readFile(new URL('../app/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/lab-ai/ask/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/knowledge/[id]/assets/[...assetPath]/route.ts', import.meta.url), 'utf8'),
  ]);
  const sidebar = page.slice(page.indexOf('function Sidebar('), page.indexOf('function ApprovalRow('));
  assert.match(sidebar, /data-sidebar-section="office"[\s\S]*?aria-expanded=\{officeOpen\}/u);
  assert.match(sidebar, /data-sidebar-section="knowledge"[\s\S]*?aria-expanded=\{knowledgeOpen\}/u);
  assert.match(sidebar, /hidden=\{!officeOpen\}/u); assert.match(sidebar, /hidden=\{!knowledgeOpen\}/u);
  assert.doesNotMatch(sidebar, /官网 OEM 申请|流程与规则/u);
  assert.match(route, /getActiveKnowledgeChunks\(actor, retrievalQuery\)/u);
  assert.match(route, /answerOaChatQuestion\(question, ranked, history\)/u);
  assert.match(route, /!authorized\.ndaCompleted/u);
  assert.match(asset, /detail\?\.item.status !== "active"/u);
  assert.match(asset, /detail.item.activeRevisionId !== requestedRevision/u);
});
