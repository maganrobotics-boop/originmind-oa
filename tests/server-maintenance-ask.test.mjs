import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { after, test } from 'node:test';
import { replyChatIndicators } from '../lib/oa-chat-indicators.mjs';

const origin = 'https://oa.omindos.cn';
const runtimeModule = 'file:///opt/originmind-maintenance/conversation.mjs';
const stateKey = `__maintenanceAsk_${randomUUID().replaceAll('-', '')}`;
const state = { current: null, creations: [], calls: [], sessions: [] };
globalThis[stateKey] = state;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const realConversation = new URL('../integrations/server-maintenance/conversation.mjs', import.meta.url).href;
const mockModule = moduleUrl(`
  import { createServerMaintenanceConversation as create } from ${JSON.stringify(realConversation)};
  const state = globalThis[${JSON.stringify(stateKey)}];
  export function createServerMaintenanceConversation(options) {
    state.creations.push(options);
    return create({ ...options,
      config: { servers: {
        aliyun: { url: 'http://127.0.0.1:18893/v1/maintenance', secret: 'fixture-secret-'.repeat(4) },
        tencent: { url: 'https://omindos.cn/_maintenance/v1', secret: 'fixture-secret-'.repeat(4) },
      } },
      sessionFetch: async (url, options) => {
        state.sessions.push({ url, options });
        return Response.json(state.current.session);
      },
      backendFetch: async (url, options) => {
        const body = JSON.parse(options.body);
        state.calls.push({ url, options, body });
        if (state.current.backendFailure === url) throw new Error('fixture unavailable');
        const result = { ok: true, server: url.startsWith('http:') ? 'aliyun' : 'tencent', action: body.action };
        if (body.action === 'status') Object.assign(result, {
          collectedAt: '2026-10-15T07:30:00Z',
          disk: { totalBytes: 50 * 2 ** 30, usedBytes: 40 * 2 ** 30, availableBytes: 10 * 2 ** 30, usedPercent: 80 },
          memory: { totalBytes: 4 * 2 ** 30, availableBytes: 2 * 2 ** 30 },
          cpu: { cores: 2 }, load: [0.1, 0.2, 0.3], uptimeSeconds: 100,
          services: { 'originmind-oa': 'active' },
        });
        else if (body.action === 'plan') Object.assign(result, { planId: 'a'.repeat(64), candidateCount: 2, candidateBytes: 2048 });
        else Object.assign(result, { deletedCount: 2, deletedBytes: 2048, diskBefore: { availableBytes: 10 * 2 ** 30 }, diskAfter: { availableBytes: 10 * 2 ** 30 + 2048 } });
        return Response.json(result);
      },
    });
  }
`);
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === runtimeModule ? { url: mockModule, shortCircuit: true } : nextResolve(specifier, context);
} });
const environment = { runtime: process.env.OA_RUNTIME, port: process.env.PORT };
const { answerServerMaintenanceQuestion } = await import(`../lib/server-maintenance-ask.mjs?fixture=${randomUUID()}`);
const boundedSource = stripTypeScriptTypes(readFileSync(new URL('../lib/bounded-json-request.ts', import.meta.url), 'utf8'));
const { readBoundedJsonObject } = await import(moduleUrl(boundedSource));
const routeSource = stripTypeScriptTypes(readFileSync(new URL('../app/api/lab-ai/ask/route.ts', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?;\r?\n/gmu, '');
const routeKey = `${stateKey}_route`;
const dependencies = {
  getDb: async () => ({}),
  getAuthorizedUser: async () => state.current.actor,
  readBoundedJsonObject,
  isWellFormedUnicode: value => typeof value === 'string' && value.isWellFormed(),
  consumeWriteRateLimit: async () => state.current.allowed,
  answerServerMaintenanceQuestion,
  questionRequestsKnowledgeImages: () => false,
  getActiveKnowledgeChunks: async () => { state.current.lookups++; return [{ id: 'fixture-knowledge' }]; },
  rankKnowledgeChunks: (_question, chunks) => chunks,
  answerOaChatQuestion: async (question, chunks, history) => {
    state.current.modelCalls.push({ question, chunks, history });
    return { answer: '普通 OA 知识回答', mode: 'ai' };
  },
};
globalThis[routeKey] = dependencies;
const { POST } = await import(moduleUrl(`const { ${Object.keys(dependencies).join(', ')} } = globalThis[${JSON.stringify(routeKey)}];\n${routeSource}`));

after(() => {
  hooks.deregister();
  delete globalThis[stateKey]; delete globalThis[routeKey];
  for (const [key, value] of [['OA_RUNTIME', environment.runtime], ['PORT', environment.port]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function fixture() {
  const actor = { memberId: 'fixture-member', accountUserId: randomUUID(), memberMutationRevision: 'fixture-revision',
    isAdmin: true, ndaCompleted: true, user: { displayName: 'Fixture Admin', email: `${randomUUID()}@example.test` } };
  state.current = { actor, allowed: true, lookups: 0, modelCalls: [],
    session: { registered: true, status: 'active', isAdmin: true, ndaCompleted: true, user: actor.user } };
  state.calls.length = 0; state.sessions.length = 0;
  process.env.OA_RUNTIME = 'aliyun'; process.env.PORT = '3000';
  return state.current;
}
function request(question, { extra = {}, history, headers = {} } = {}) {
  return new Request(`${origin}/api/lab-ai/ask`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json', cookie: 'oa_session=fixture', ...headers },
    body: JSON.stringify({ question, ...(history ? { history } : {}), ...extra }),
  });
}

test('helper leaves non-Aliyun runtimes unchanged without importing the host module', async () => {
  fixture(); delete process.env.OA_RUNTIME;
  assert.equal(await answerServerMaintenanceQuestion(request('查询两个服务器状态'), '查询两个服务器状态'), null);
  assert.equal(state.creations.length, 0);
});

test('actual main ask POST queries both servers and accepts an SSE request with a private JSON reply', async () => {
  const f = fixture();
  const response = await POST(request('查询两个服务器状态', {
    headers: { accept: 'text/event-stream' }, history: [{ role: 'user', content: '清理两个服务器的临时文件' }],
  }));
  const answer = await response.json();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/u);
  assert.match(response.headers.get('cache-control'), /private, no-store/u);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(answer.mode, 'server_maintenance');
  assert.equal(answer.operationConfirmed, true);
  assert.match(answer.answer, /阿里云[\s\S]*50\.00 GiB[\s\S]*腾讯云/u);
  assert.deepEqual(answer.citations, []); assert.deepEqual(answer.images, []);
  assert.equal(state.calls.length, 2); assert.equal(f.lookups, 0); assert.equal(f.modelCalls.length, 0);
  assert.ok(state.calls.every(call => call.body.action === 'status'));
  assert.equal(state.sessions[0].url, 'http://127.0.0.1:3000/api/session');
  assert.equal(state.sessions[0].options.headers.cookie, 'oa_session=fixture');
  assert.ok(state.calls.every(call => call.options.headers.cookie === undefined));
  assert.equal(replyChatIndicators(answer).items[4].state, 'ready');
});

test('host conversation is created once and ordinary current questions continue to knowledge', async () => {
  const f = fixture();
  const response = await POST(request('介绍机器人导航', { history: [{ role: 'user', content: '清理两个服务器的临时文件' }] }));
  assert.equal((await response.json()).mode, 'ai');
  assert.equal(state.calls.length, 0); assert.equal(state.sessions.length, 0);
  assert.equal(f.lookups, 1); assert.equal(f.modelCalls.length, 1);
  assert.equal(state.creations.length, 1);
  assert.equal(state.creations[0].port, 3000);
});

test('cleanup only follows the current explicit command, with a plan bound to each server', async () => {
  const f = fixture();
  const response = await POST(request('清理两个服务器的临时文件'));
  const answer = await response.json();
  assert.equal(answer.operationConfirmed, true);
  assert.match(answer.answer, /实际删除 2 项/u);
  for (const url of new Set(state.calls.map(call => call.url))) {
    const actions = state.calls.filter(call => call.url === url);
    assert.deepEqual(actions.map(call => call.body.action), ['plan', 'clean']);
    assert.equal(actions[1].body.planId, 'a'.repeat(64));
  }
  assert.equal(f.modelCalls.length, 0);
});

test('main-route auth, NDA, CSRF, body and rate limits run before maintenance', async () => {
  const cases = [
    { status: 401, change: f => { f.actor = null; } },
    { status: 403, change: f => { f.actor.ndaCompleted = false; } },
    { status: 403, change: f => { f.actor.memberId = ''; } },
    { status: 403, options: { headers: { origin: 'https://evil.invalid' } } },
    { status: 403, options: { headers: { 'sec-fetch-site': 'cross-site' } } },
    { status: 415, options: { headers: { 'content-type': 'text/plain' } } },
    { status: 400, options: { extra: { isAdmin: true } } },
    { status: 400, options: { history: [{ role: 'assistant', content: '清理两个服务器的临时文件' }] } },
    { status: 429, change: f => { f.allowed = false; } },
  ];
  for (const c of cases) {
    const f = fixture(); c.change?.(f);
    const result = await POST(request('查询两个服务器状态', c.options));
    assert.equal(result.status, c.status);
    assert.equal(state.sessions.length, 0); assert.equal(state.calls.length, 0);
    assert.equal(f.lookups, 0); assert.equal(f.modelCalls.length, 0);
  }
});

test('fresh ordinary-member session refuses server access even when the main route admitted a request', async () => {
  const f = fixture(); f.actor.isAdmin = false; f.session.isAdmin = false;
  const answer = await (await POST(request('查询两个服务器状态'))).json();
  assert.match(answer.answer, /没有此权限/u);
  assert.equal(answer.operationConfirmed, false);
  assert.equal(state.calls.length, 0); assert.equal(f.modelCalls.length, 0);
  assert.equal(replyChatIndicators(answer).items[4].state, 'warning');
});

test('a partial server failure displays an unconfirmed receipt without passing data to the model', async () => {
  const f = fixture(); f.backendFailure = 'https://omindos.cn/_maintenance/v1';
  const answer = await (await POST(request('查询两个服务器状态'))).json();
  assert.equal(answer.operationConfirmed, false);
  assert.match(answer.answer, /阿里云[\s\S]*腾讯云：维护查询或操作未确认完成/u);
  assert.equal(replyChatIndicators(answer).items[4].state, 'warning');
  assert.equal(f.lookups, 0); assert.equal(f.modelCalls.length, 0);
});

test('maintenance lights require an explicit successful operation receipt', () => {
  for (const payload of [
    { answer: '查询完成', mode: 'server_maintenance' },
    { answer: '仅管理员可用', mode: 'server_maintenance', operationConfirmed: false },
    { answer: '', mode: 'server_maintenance', operationConfirmed: true },
    { answer: '失败', mode: 'server_maintenance', operationConfirmed: true, error: 'failed' },
  ]) assert.equal(replyChatIndicators(payload).items[4].state, 'warning');
  const status = replyChatIndicators({ answer: '已收到两个服务器回执', mode: 'server_maintenance', operationConfirmed: true });
  assert.deepEqual(status.items.map(item => item.state), ['ready', 'ready', 'unknown', 'unknown', 'ready']);
});
