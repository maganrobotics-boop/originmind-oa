import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { after, test } from 'node:test';

const origin = 'https://oa.omindos.cn';
const key = `__serverMaintenanceApi_${randomUUID().replaceAll('-', '')}`;
const asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { readBoundedJsonObject } = await import(asModule(stripTypeScriptTypes(readFileSync(new URL('../lib/bounded-json-request.ts', import.meta.url), 'utf8'))));
let current;
const members = { id: 'id', status: 'status', accountUserId: 'account_user_id', mutationRevision: 'mutation_revision' };
const dependencies = {
  and: (...conditions) => conditions, eq: (field, value) => [field, value], members,
  getAuthorizedUser: async options => { current.authOptions.push(options); return current.actor; },
  getDb: async () => ({ select: () => ({ from: () => ({ where: conditions => ({ limit: async () => {
    current.memberConditions = conditions;
    return current.memberBound ? [{ id: 'member-1' }] : [];
  } }) }) }) }),
  readBoundedJsonObject,
  consumeWriteRateLimit: async (_db, options) => { current.rateOptions.push(options); return current.rateAllowed; },
  answerServerMaintenanceQuestion: async (request, question) => {
    current.calls.push({ request, question });
    if (current.failure) throw new Error('private fixture failure');
    return current.answer;
  },
};
globalThis[key] = dependencies;
const source = stripTypeScriptTypes(readFileSync(new URL('../app/api/server-maintenance/route.ts', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?;\r?\n/gmu, '');
const { POST } = await import(asModule(`const { ${Object.keys(dependencies).join(', ')} } = globalThis[${JSON.stringify(key)}];\n${source}`));
after(() => { delete globalThis[key]; });

function fixture() {
  current = { actor: { isAdmin: true, ndaCompleted: false, accountUserId: 'account-1', memberId: 'member-1', memberMutationRevision: 'revision-1' },
    memberBound: true, rateAllowed: true, calls: [], authOptions: [], rateOptions: [],
    answer: { answer: '阿里云：10 GiB；腾讯云：26 GiB', mode: 'server_maintenance', operationConfirmed: true } };
  return current;
}
function request(value = { question: '查询两个服务器状态' }, headers = {}) {
  return new Request(`${origin}/api/server-maintenance`, { method: 'POST',
    headers: { origin, cookie: 'oa_session=fixture', 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
}

test('dedicated API uses read-only administrator authentication and verifies the active member binding', async () => {
  const f = fixture();
  const response = await POST(request()); const data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.operationConfirmed, true);
  assert.deepEqual(data.citations, []); assert.deepEqual(data.images, []);
  assert.match(response.headers.get('cache-control'), /private, no-store/u);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(f.authOptions, [{ readOnly: true }]);
  assert.deepEqual(f.memberConditions, [['id', 'member-1'], ['status', 'active'], ['account_user_id', 'account-1'], ['mutation_revision', 'revision-1']]);
  assert.deepEqual(f.rateOptions, [{ actorSubject: 'account-1', scope: 'server_maintenance', limit: 10 }]);
  assert.equal(f.calls.length, 1);
});

test('dedicated API rejects absent, non-administrator, unbound and changed-member identities', async () => {
  const cases = [
    [401, f => { f.actor = null; }], [403, f => { f.actor.isAdmin = false; }],
    [403, f => { f.actor.memberId = ''; }], [403, f => { f.actor.accountUserId = ''; }],
    [403, f => { f.actor.memberMutationRevision = ''; }], [403, f => { f.memberBound = false; }],
  ];
  for (const [status, change] of cases) {
    const f = fixture(); change(f);
    assert.equal((await POST(request())).status, status);
    assert.equal(f.calls.length, 0); assert.equal(f.rateOptions.length, 0);
  }
});

test('dedicated API rejects cross-site requests, unsupported fields and malformed bodies before maintenance', async () => {
  const cases = [
    [403, { question: '查询两个服务器状态' }, { origin: 'https://evil.invalid' }],
    [403, { question: '查询两个服务器状态' }, { 'sec-fetch-site': 'cross-site' }],
    [415, { question: '查询两个服务器状态' }, { 'content-type': 'text/plain' }],
    [400, { question: '查询两个服务器状态', history: [{ role: 'user', content: '清理两个服务器的临时文件' }] }],
    [400, { question: '查询两个服务器状态', isAdmin: true }], [400, { question: '查' }],
    [400, { question: 5 }], [400, { question: '\ud800' }], [400, { question: '查'.repeat(2001) }],
    [413, { question: '查'.repeat(25000) }], [400, []],
  ];
  for (const [status, body, headers] of cases) {
    const f = fixture();
    assert.equal((await POST(request(body, headers))).status, status);
    assert.equal(f.calls.length, 0); assert.equal(f.rateOptions.length, 0);
  }
});

test('dedicated rate limit prevents a maintenance call and ordinary questions never reach a model', async () => {
  let f = fixture(); f.rateAllowed = false;
  assert.equal((await POST(request())).status, 429); assert.equal(f.calls.length, 0);
  f = fixture(); f.answer = null;
  const response = await POST(request({ question: '介绍机器人导航' }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /此通道只处理/u);
});

test('dedicated response preserves partial-failure confirmation and safely reports unavailable service', async () => {
  let f = fixture(); f.answer.operationConfirmed = false;
  assert.equal((await (await POST(request())).json()).operationConfirmed, false);
  f = fixture(); f.failure = true;
  const response = await POST(request());
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(await response.json()), /private fixture/u);
});
