import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { handleBotRequest } from '../lib/feishu-meeting-bot.mjs';

// All upstream calls are replaced. These are synthetic values, never production credentials.
const env = {
  OA_PUBLIC_ORIGIN: 'https://oa.example.test', OA_MEETING_BOT_ENABLED: 'true',
  FEISHU_LOGIN_APP_ID: 'cli_offline123', FEISHU_LOGIN_APP_SECRET: 'offline_test_secret',
  FEISHU_LOGIN_TENANT_KEY: 'tenant_offline',
};
async function check(second, extra = {}) {
  const calls = [];
  const request = new Request(`${env.OA_PUBLIC_ORIGIN}/api/admin/meeting-bot`, {
    method: 'POST', headers: { origin: env.OA_PUBLIC_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'check' }),
  });
  const response = await handleBotRequest(request, {
    env, actorKey: 'offline-admin', checkAdmission: async () => true, claimWrite: async () => true,
    ...extra,
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      if (calls.length === 1) return Response.json({ code: 0, tenant_access_token: 'offline_tenant_token' });
      if (second instanceof Error) throw second;
      return second;
    },
  });
  return { response, data: await response.json(), calls };
}

for (const status of [201, 202, 404, 405, 408, 418, 429, 500, 502, 503, 504]) {
  test(`probe HTTP ${status} must not be reported as a successful connection`, async () => {
    const result = await check(Response.json({ code: 99991668, msg: 'PRIVATE_UPSTREAM' }, { status }));
    assert.equal(result.response.status, 502);
    assert.equal(result.data.diagnostic, 'PROBE_HTTP');
    assert.equal(result.data.upstreamStatus, status);
    assert.equal(result.data.credentialsVerified, true);
    assert.equal(result.data.joinTransportVerified, false);
    assert.equal(result.data.permissionVerified, false);
    assert.equal(result.data.outcomeUnknown, false);
    assert.equal(result.calls.length, 2, 'never retry a probe');
    assert.ok(!JSON.stringify(result.data).includes('PRIVATE_UPSTREAM'));
  });
}
for (const status of [200, 400, 401, 403]) {
  test(`probe HTTP ${status} rejection only verifies transport, never scope or membership`, async () => {
    const result = await check(Response.json({ code: 99991668 }, { status }));
    assert.equal(result.response.status, 200);
    assert.equal(result.data.credentialsVerified, true);
    assert.equal(result.data.joinTransportVerified, true);
    assert.equal(result.data.permissionVerified, false);
    assert.deepEqual(result.data.transportProbe, { upstreamStatus: status, code: 99991668 });
    assert.match(result.data.message, /仅连接诊断/u);
    assert.equal(result.calls.length, 2);
    const probe = result.calls[1];
    assert.equal(probe.headers.authorization, 'Bearer invalid_transport_probe');
    assert.equal(probe.redirect, 'manual');
    assert.deepEqual(JSON.parse(probe.body), { join_type: 0, join_identify: { meeting_no: '000000000' } });
    assert.ok(!JSON.stringify(probe).includes('offline_tenant_token'));
    assert.ok(!JSON.stringify(probe).includes('offline_test_secret'));
  });
}
for (const code of [0, -1, 1.5, '99991668', null]) {
  test(`probe does not accept malformed/success code ${JSON.stringify(code)}`, async () => {
    const result = await check(Response.json({ code }));
    assert.equal(result.response.status, 502);
    assert.equal(result.data.diagnostic, 'PROBE_RESPONSE_INVALID');
    assert.equal(result.data.outcomeUnknown, false);
    assert.equal(result.data.joinTransportVerified, false);
  });
}
for (const [label, factory, diagnostic] of [
  ['network', () => new Error('PRIVATE_EXCEPTION'), 'PROBE_NETWORK'],
  ['timeout', () => Object.assign(new Error('PRIVATE_EXCEPTION'), { name: 'TimeoutError' }), 'PROBE_TIMEOUT'],
  ['redirect', () => new Response(null, { status: 302 }), 'PROBE_REDIRECT'],
  ['HTML', () => new Response('<html>PRIVATE_BODY</html>', { headers: { 'content-type': 'text/html' } }), 'PROBE_CONTENT_TYPE'],
  ['invalid JSON', () => new Response('PRIVATE_BODY', { headers: { 'content-type': 'application/json' } }), 'PROBE_RESPONSE_INVALID'],
  ['fake JSON type', () => new Response('{"code":99991668}', { headers: { 'content-type': 'text/application/json-fake' } }), 'PROBE_CONTENT_TYPE'],
  ['oversize', () => Response.json({ code: 99991668, msg: 'x'.repeat(262144) }), 'PROBE_RESPONSE_INVALID'],
]) {
  test(`probe ${label} preserves the successful credential stage without leaking details`, async () => {
    const result = await check(factory());
    assert.equal(result.response.status, 502);
    assert.equal(result.data.diagnostic, diagnostic);
    assert.equal(result.data.credentialsVerified, true);
    assert.equal(result.data.joinTransportVerified, false);
    assert.equal(result.data.permissionVerified, false);
    assert.equal(result.data.outcomeUnknown, false);
    assert.match(result.data.error, /应用凭据验证通过/u);
    assert.ok(!JSON.stringify(result.data).includes('PRIVATE_'));
    assert.equal(result.calls.length, 2);
  });
}

test('revoking admission after token acquisition prevents even the invalid probe', async () => {
  let admission = 0;
  const result = await check(Response.json({ code: 99991668 }), { checkAdmission: async () => ++admission === 1 });
  assert.equal(result.response.status, 403);
  assert.equal(result.calls.length, 1);
});
test('rate limiting prevents all outbound requests', async () => {
  const result = await check(Response.json({ code: 99991668 }), { claimWrite: async () => false });
  assert.equal(result.response.status, 429);
  assert.equal(result.calls.length, 0);
});

// Execute the real component handler, not a copied state machine. No browser or live session.
const page = readFileSync(new URL('../app/admin/meeting-bot/page.tsx', import.meta.url), 'utf8');
const start = page.indexOf('  async function perform(');
const end = page.indexOf('  function clearAfterHostCheck()', start);
assert.ok(start >= 0 && end > start, 'locate the real component handler');
const compiled = ts.transpileModule(page.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  reportDiagnostics: true,
});
assert.equal((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
async function perform(action, uncertain, reply) {
  const record = uncertain ? { meetingId: null, meetingNumber: '123456789', requestedAt: 'offline' } : null;
  const writes = [], calls = [];
  const state = { uncertain, last: record, busy: false, notice: '', password: 'offline-password', leaveId: '7512345678901234567' };
  const context = {
    ...state, status: { configured: true, enabled: true }, meeting: '123456789', confirmed: true,
    endpoint: '/api/admin/meeting-bot', storageKey: 'offline-record', AbortSignal, Date,
    window: { confirm: () => true },
    sessionStorage: { setItem: (...args) => writes.push(['set', ...args]), removeItem: (...args) => writes.push(['remove', ...args]) },
    fetch: async (url, init) => { calls.push({ url, ...init }); if (reply instanceof Error) throw reply; return reply; },
  };
  for (const key of Object.keys(state)) context[`set${key[0].toUpperCase()}${key.slice(1)}`] = value => {
    state[key] = typeof value === 'function' ? value(state[key]) : value;
  };
  await vm.runInNewContext(`${compiled.outputText}\nperform`, context)(action);
  return { state, record, writes, calls };
}
for (const prior of [false, true]) {
  for (const [label, reply] of [
    ['network failure', () => new Error('offline-network')],
    ['non-JSON response', () => new Response('<html>offline</html>')],
    ['null JSON response', () => Response.json(null)],
  ]) {
    test(`check ${label} preserves prior uncertainty=${prior} and never mutates saved meeting state`, async () => {
      const result = await perform('check', prior, reply());
      assert.equal(result.state.uncertain, prior);
      assert.equal(result.state.last, result.record);
      assert.deepEqual(result.writes, []);
      assert.deepEqual(JSON.parse(result.calls[0].body), { action: 'check' });
      assert.equal(result.calls.length, 1);
      assert.match(result.state.notice, /连接检查未完成/u);
      assert.equal(result.state.busy, false);
    });
  }
}
for (const [label, reply] of [
  ['success', () => Response.json({ credentialsVerified: true, message: '应用连接检查通过' })],
  ['definite failure', () => Response.json({ outcomeUnknown: false, error: '应用连接诊断失败' }, { status: 502 })],
]) {
  test(`check ${label} does not clear or conceal a pending join record`, async () => {
    const result = await perform('check', true, reply());
    assert.equal(result.state.uncertain, true);
    assert.equal(result.state.last, result.record);
    assert.deepEqual(result.writes, []);
    assert.match(result.state.notice, /已保留之前的待核对记录/u);
  });
}
for (const action of ['join', 'leave']) {
  test(`${action} network failure still locks unknown outcome and never retries`, async () => {
    const result = await perform(action, false, new Error('offline-network'));
    assert.equal(result.state.uncertain, true);
    assert.equal(result.calls.length, 1);
    assert.match(result.state.notice, /勿重复入会/u);
    assert.ok(!result.writes.some(([kind]) => kind === 'remove'));
  });
}
