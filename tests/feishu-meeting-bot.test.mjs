import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { botConfiguration, handleBotRequest, normalizeMeetingNumber } from '../lib/feishu-meeting-bot.mjs';

const env = { OA_PUBLIC_ORIGIN: 'https://oa.example.test', OA_MEETING_BOT_ENABLED: 'true', FEISHU_LOGIN_APP_ID: 'cli_test123', FEISHU_LOGIN_APP_SECRET: 'secret_for_offline_tests_only', FEISHU_LOGIN_TENANT_KEY: 'tenant_test' };
const id = '7512345678901234567';
const join = { action: 'join', meeting: '123456789', confirmed: true };
const request = (body = join, headers = {}, url = `${env.OA_PUBLIC_ORIGIN}/api/admin/meeting-bot`) => new Request(url, { method: 'POST', headers: { origin: env.OA_PUBLIC_ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
function harness(extra = {}, replies = [{ code: 0, tenant_access_token: 'tenant_token_offline' }, { code: 0, data: { meeting: { id } } }]) {
  const calls = [];
  const options = { env, actorKey: 'admin:1', checkAdmission: async () => true, claimWrite: async () => true, fetchImpl: async (url, init) => {
    calls.push({ url, ...init, json: JSON.parse(init.body) });
    const item = replies[calls.length - 1];
    if (item instanceof Error) throw item;
    if (item instanceof Response) return item;
    return Response.json(item);
  }, ...extra };
  return { calls, options, run: input => handleBotRequest(input || request(), options) };
}
for (const value of ['123456789', '123 456 789', ' https://vc.feishu.cn/j/123456789?from=invite ']) test(`meeting number accepts ${value}`, () => assert.equal(normalizeMeetingNumber(value), '123456789'));
for (const value of [123456789, id, '', '12345678', 'https://evil.test/j/123456789', 'http://vc.feishu.cn/j/123456789', 'https://vc.feishu.cn.evil.test/j/123456789', 'https://name@vc.feishu.cn/j/123456789', 'https://vc.feishu.cn:444/j/123456789', 'https://vc.feishu.cn/j/123456789/extra']) test(`meeting number rejects ${String(value)}`, () => assert.equal(normalizeMeetingNumber(value), null));

test('GET reports configuration, not permission/participation verification, and no secrets', async () => {
  const h = harness(); const response = await h.run(new Request(`${env.OA_PUBLIC_ORIGIN}/api/admin/meeting-bot`));
  const data = await response.json(); assert.equal(data.permissionVerified, false); assert.equal(data.configured, true);
  assert.equal(h.calls.length, 0); assert.ok(response.headers.get('cache-control').includes('no-store'));
  assert.ok(!JSON.stringify(data).includes(env.FEISHU_LOGIN_APP_SECRET));
});
test('unconfigured environment fails closed', () => { assert.equal(botConfiguration({}).configured, false); assert.equal(botConfiguration({ ...env, OA_PUBLIC_ORIGIN: 'http://oa.example.test' }).configured, false); });
test('join disabled does not fetch', async () => { const h = harness({ env: { ...env, OA_MEETING_BOT_ENABLED: 'false' } }); assert.equal((await h.run()).status, 503); assert.equal(h.calls.length, 0); });
for (const [name, input, status] of [
  ['foreign origin', () => request(join, { origin: 'https://evil.test' }), 403],
  ['missing origin', () => request(join, { origin: '' }), 403],
  ['foreign request host', () => request(join, {}, 'https://evil.test/api/admin/meeting-bot'), 403],
  ['cross-site metadata', () => request(join, { 'sec-fetch-site': 'cross-site' }), 403],
  ['wrong content type', () => request(join, { 'content-type': 'text/plain' }), 415],
  ['query parameters', () => request(join, {}, `${env.OA_PUBLIC_ORIGIN}/api/admin/meeting-bot?action=join`), 400],
  ['unconfirmed write', () => request({ ...join, confirmed: false }), 400],
  ['untrusted call ID', () => request({ ...join, call_id: 'invented' }), 400],
  ['implicit meeting start', () => request({ ...join, action: 'start' }), 400],
  ['numeric meeting ID', () => request({ action: 'leave', meetingId: Number(id), confirmed: true }), 400],
  ['nine digit leave ID', () => request({ action: 'leave', meetingId: '123456789', confirmed: true }), 400],
  ['control in password', () => request({ ...join, password: 'pw\n' }), 400],
  ['oversized body', () => request({ ...join, password: 'a'.repeat(6000) }), 413],
  ['array body', () => request([]), 400],
]) test(name, async () => { const h = harness(); assert.equal((await h.run(input())).status, status); assert.equal(h.calls.length, 0); });
test('join uses official join_type/join_identify and tenant token, no start action', async () => {
  const h = harness(); const response = await h.run(request({ ...join, password: 'private-password' })); const data = await response.json();
  assert.equal(response.status, 200); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].url, 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal');
  assert.deepEqual(h.calls[0].json, { app_id: env.FEISHU_LOGIN_APP_ID, app_secret: env.FEISHU_LOGIN_APP_SECRET });
  assert.equal(h.calls[1].url, 'https://open.feishu.cn/open-apis/vc/v1/bots/join');
  assert.deepEqual(h.calls[1].json, { join_type: 1, join_identify: { meeting_no: '123456789' }, password: 'private-password' });
  assert.equal(h.calls[1].headers.authorization, 'Bearer tenant_token_offline'); assert.equal(h.calls[1].redirect, 'error');
  assert.equal(data.meetingId, id); assert.equal(data.participantVerified, false); assert.equal(data.state, 'join_api_succeeded');
  assert.ok(!JSON.stringify(data).includes('private-password')); assert.ok(!JSON.stringify(data).includes('tenant_token_offline'));
});
test('connection probe never joins and does not assert scope permission', async () => { const h = harness({ env: { ...env, OA_MEETING_BOT_ENABLED: 'false' } }); const data = await (await h.run(request({ action: 'check' }))).json(); assert.equal(data.credentialsVerified, true); assert.equal(data.permissionVerified, false); assert.equal(h.calls.length, 1); });
test('leave remains available after joining is disabled and preserves ID precision', async () => { const h = harness({ env: { ...env, OA_MEETING_BOT_ENABLED: 'false' } }); const response = await h.run(request({ action: 'leave', meetingId: id, confirmed: true })); assert.equal(response.status, 200); assert.ok(h.calls[1].url.endsWith('/bots/leave')); assert.deepEqual(h.calls[1].json, { meeting_id: id }); });
test('denied admission makes no outbound calls', async () => { const h = harness({ checkAdmission: async () => false }); assert.equal((await h.run()).status, 403); assert.equal(h.calls.length, 0); });
test('admission revoked during authentication prevents join', async () => { let count = 0; const h = harness({ checkAdmission: async () => ++count === 1 }); assert.equal((await h.run()).status, 403); assert.equal(h.calls.length, 1); });
test('rate limit prevents token acquisition and join', async () => { const h = harness({ claimWrite: async () => false }); assert.equal((await h.run()).status, 429); assert.equal(h.calls.length, 0); });
test('Feishu business errors and trace IDs are safe; upstream text is not echoed', async () => {
  const h = harness({}, [{ code: 0, tenant_access_token: 'token' }, Response.json({ code: 121003, msg: 'PRIVATE PASSWORD SECRET' }, { status: 403, headers: { 'x-tt-logid': 'abc123' } })]);
  const response = await h.run(); const data = await response.json(); assert.equal(response.status, 502); assert.equal(data.code, 121003); assert.equal(data.logId, 'abc123'); assert.equal(data.outcomeUnknown, false); assert.ok(!JSON.stringify(data).includes('PRIVATE'));
});
for (const [msg, expected] of [['gray release denied', /灰度/u], ['app_scope_not_applied', /应用权限/u]]) test(`actionable ${msg}`, async () => { const h = harness({}, [{ code: 0, tenant_access_token: 'token' }, { code: 10012, msg }]); assert.match((await (await h.run()).json()).error, expected); });
test('join network failure is ambiguous and never retried', async () => { const h = harness({}, [{ code: 0, tenant_access_token: 'token' }, new Error('network')]); const data = await (await h.run()).json(); assert.equal(data.outcomeUnknown, true); assert.equal(h.calls.length, 2); });
test('5xx mutation failure stays ambiguous', async () => { const h = harness({}, [{ code: 0, tenant_access_token: 'token' }, Response.json({ code: 999, msg: 'server failure' }, { status: 503 })]); assert.equal((await (await h.run()).json()).outcomeUnknown, true); });
test('auth network failure never sends mutation', async () => { const h = harness({}, [new Error('SECRET')]); const data = await (await h.run()).json(); assert.equal(data.outcomeUnknown, false); assert.equal(h.calls.length, 1); assert.ok(!JSON.stringify(data).includes('SECRET')); });
test('missing numeric success code is not accepted', async () => { const h = harness({}, [{ tenant_access_token: 'token' }]); assert.equal((await h.run()).status, 502); assert.equal(h.calls.length, 1); });
test('missing tenant token never sends mutation', async () => { const h = harness({}, [{ code: 0 }]); assert.equal((await h.run()).status, 502); assert.equal(h.calls.length, 1); });
test('numeric meeting ID is not rounded into a leave target', async () => { const h = harness({}, [{ code: 0, tenant_access_token: 'token' }, { code: 0, data: { meeting: { id: Number(id) } } }]); const data = await (await h.run()).json(); assert.equal(data.meetingId, null); assert.equal(data.participantVerified, false); });
test('unsupported methods do not fetch', async () => { const h = harness(); assert.equal((await h.run(new Request(`${env.OA_PUBLIC_ORIGIN}/api/admin/meeting-bot`, { method: 'DELETE' }))).status, 405); assert.equal(h.calls.length, 0); });

const require = createRequire(import.meta.url);
const ts = require('typescript');
function routeHarness(user) {
  let handedOff = false; const scopes = [];
  const mocks = {
    '../../../../db': { getDb: async () => ({}), getD1Database: async () => ({}) },
    '../../_lib/auth': { getAuthorizedUser: async () => user },
    '../../../../lib/admin-meeting-minutes': { hasMeetingAdminMembership: async () => true },
    '../../../../lib/write-rate-limit': { consumeWriteRateLimit: async (_db, args) => { scopes.push(args.scope); return true; } },
    '../../../../lib/feishu-meeting-bot.mjs': { handleBotRequest: async (_request, options) => { handedOff = true; await options.claimWrite('leave'); await options.claimWrite('join'); return Response.json({ ok: await options.checkAdmission() }); } },
    'cloudflare:workers': { env },
  };
  const source = readFileSync(new URL('../app/api/admin/meeting-bot/route.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => { assert.ok(mocks[name], `unexpected import ${name}`); return mocks[name]; }, Response });
  return { run: () => exports.POST(request()), handed: () => handedOff, scopes };
}
const admin = { isAdmin: true, ndaCompleted: true, memberId: 'member', accountUserId: 'account', memberMutationRevision: 1 };
for (const [label, user, status] of [['anonymous', null, 401], ['member', { ...admin, isAdmin: false }, 403], ['NDA incomplete', { ...admin, ndaCompleted: false }, 403], ['missing revision', { ...admin, memberMutationRevision: 0 }, 403]]) test(`route blocks ${label}`, async () => { const h = routeHarness(user); assert.equal((await h.run()).status, status); assert.equal(h.handed(), false); });
test('route reuses live admin guard and separates emergency-leave rate limit', async () => { const h = routeHarness(admin); assert.equal((await h.run()).status, 200); assert.deepEqual(h.scopes, ['meeting_bot_leave', 'meeting_bot_control']); });
