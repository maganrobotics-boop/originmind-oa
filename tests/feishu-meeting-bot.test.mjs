import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { botConfiguration, handleBotRequest, normalizeMeetingNumber, sanitizeMeetingEvents } from '../lib/feishu-meeting-bot.mjs';

const env = { OA_PUBLIC_ORIGIN: 'https://oa.example.test', OA_MEETING_BOT_ENABLED: 'true', FEISHU_LOGIN_APP_ID: 'cli_test123', FEISHU_LOGIN_APP_SECRET: 'secret_for_offline_tests_only', FEISHU_LOGIN_TENANT_KEY: 'tenant_test' };
const id = '7512345678901234567';
const join = { action: 'join', meeting: '123456789', confirmed: true };
const request = (body = join, headers = {}, url = `${env.OA_PUBLIC_ORIGIN}/api/admin/meeting-bot`) => new Request(url, { method: 'POST', headers: { origin: env.OA_PUBLIC_ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
function harness(extra = {}, replies = [{ code: 0, tenant_access_token: 'tenant_token_offline' }, { code: 0, data: { meeting: { id } } }]) {
  const calls = [];
  const options = { env, actorKey: 'admin:1', checkAdmission: async () => true, claimWrite: async () => true, fetchImpl: async (url, init) => {
    calls.push({ url, ...init, json: init.body ? JSON.parse(init.body) : undefined });
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
  assert.equal(data.eventScope, 'vc:meeting.meetingevent:read');
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
  assert.equal(h.calls[1].headers.authorization, 'Bearer tenant_token_offline'); assert.equal(h.calls[1].redirect, 'manual');
  assert.equal(data.meetingId, id); assert.equal(data.participantVerified, false); assert.equal(data.state, 'join_api_succeeded');
  assert.ok(!JSON.stringify(data).includes('private-password')); assert.ok(!JSON.stringify(data).includes('tenant_token_offline'));
});
test('connection probe never uses real join credentials and does not assert scope permission', async () => { const h = harness({ env: { ...env, OA_MEETING_BOT_ENABLED: 'false' } }, [{ code: 0, tenant_access_token: 'tenant_token_offline' }, new Response(JSON.stringify({ code: 99991668 }), { status: 400, headers: { 'content-type': 'application/json' } })]); const data = await (await h.run(request({ action: 'check' }))).json(); assert.equal(data.credentialsVerified, true); assert.equal(data.joinTransportVerified, true); assert.equal(data.permissionVerified, false); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].headers.authorization, 'Bearer invalid_transport_probe'); });
test('leave remains available after joining is disabled and preserves ID precision', async () => { const h = harness({ env: { ...env, OA_MEETING_BOT_ENABLED: 'false' } }); const response = await h.run(request({ action: 'leave', meetingId: id, confirmed: true })); assert.equal(response.status, 200); assert.ok(h.calls[1].url.endsWith('/bots/leave')); assert.deepEqual(h.calls[1].json, { meeting_id: id }); });
test('events use the official read endpoint and return only bounded transcript fields', async () => {
  const upstream = { code: 0, data: { has_more: true, page_token: 'next_page', private_field: 'DO_NOT_RETURN', events: [{
    event_id: 'evt_1', event_time: '1760000000', payload: {
      meeting: { topic: '研发周会', start_time: '1760000000' },
      participant_joined_items: [{ participant: { id: 'ou_1', user_name: '张三', private: 'secret' }, join_time: '1760000000' }],
      transcript_received_items: [{ speaker: { id: 'ou_1', user_name: '张三' }, text: '确认下周完成联调。', start_time_ms: '1760000000123', private: 'secret' }],
    },
  }] } };
  const h = harness({}, [{ code: 0, tenant_access_token: 'token' }, upstream]);
  const response = await h.run(request({ action: 'events', meetingId: id, pageToken: 'page_1', startTime: '1760000000' }));
  const data = await response.json();
  assert.equal(response.status, 200); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].method, 'GET'); assert.equal(h.calls[1].body, undefined);
  assert.match(h.calls[1].url, /\/vc\/v1\/bots\/events\?/u);
  const query = new URL(h.calls[1].url).searchParams;
  assert.equal(query.get('meeting_id'), id); assert.equal(query.get('page_size'), '100'); assert.equal(query.get('page_token'), 'page_1');
  assert.deepEqual(data.transcript, [{ id: 'evt_1:0:1760000000123:ou_1', speaker: '张三', text: '确认下周完成联调。', time: '2025-10-09T08:53:20.123Z' }]);
  assert.deepEqual(data.participants, ['张三']); assert.equal(data.meeting.topic, '研发周会'); assert.equal(data.pageToken, 'next_page'); assert.equal(data.contentTruncated, false);
  assert.doesNotMatch(JSON.stringify(data), /DO_NOT_RETURN|private|secret/u);
});
test('meeting event sanitizer detects a meeting-ended signal without exposing raw events', () => {
  const result = sanitizeMeetingEvents({ events: [{ event_id: 'end', event_type: 'participant_left', payload: { participant_left_items: [{ participant: { user_name: '李四' }, leave_reason: 2, leave_time: '1760000100' }] } }] });
  assert.equal(result.meetingEnded, true); assert.equal(result.meeting.endTime, '2025-10-09T08:55:00.000Z'); assert.deepEqual(result.participants, ['李四']);
  assert.equal(result.events, undefined);
});
test('meeting metadata with a valid end time is also treated as ended', () => {
  const result = sanitizeMeetingEvents({ events: [{ event_type: 'meeting_updated', payload: { meeting: { start_time: '1760000000', end_time: '1760000100' } } }] });
  assert.equal(result.meetingEnded, true); assert.equal(result.meeting.endTime, '2025-10-09T08:55:00.000Z');
});
test('oversized transcript text is reported and omitted rather than silently shortened', () => {
  const result = sanitizeMeetingEvents({ events: [{ event_id: 'long', event_type: 'transcript_received', payload: { transcript_received_items: [{ speaker: { user_name: '张三' }, text: '长'.repeat(4001), start_time_ms: '1760000000123' }] } }] });
  assert.equal(result.contentTruncated, true); assert.deepEqual(result.transcript, []);
});
test('a paginated event response without a next token fails closed', async () => {
  const h = harness({}, [{ code: 0, tenant_access_token: 'token' }, { code: 0, data: { has_more: true, events: [] } }]);
  const response = await h.run(request({ action: 'events', meetingId: id })); const data = await response.json();
  assert.equal(response.status, 502); assert.equal(data.diagnostic, 'EVENTS_RESPONSE_INVALID'); assert.equal(data.outcomeUnknown, false);
});
for (const input of [
  { action: 'events', meetingId: '123456789' },
  { action: 'events', meetingId: id, pageToken: 'bad\nvalue' },
  { action: 'events', meetingId: id, startTime: 'yesterday' },
  { action: 'events', meetingId: id, confirmed: true },
]) test('invalid event read is rejected before authentication', async () => { const h = harness(); assert.equal((await h.run(request(input))).status, 400); assert.equal(h.calls.length, 0); });
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
test('auth network failure is retried once but never sends mutation', async () => { const h = harness({}, [new Error('SECRET_1'), new Error('SECRET_2')]); const data = await (await h.run()).json(); assert.equal(data.outcomeUnknown, false); assert.equal(data.diagnostic, 'AUTH_NETWORK'); assert.equal(h.calls.length, 2); assert.ok(!JSON.stringify(data).includes('SECRET')); });
test('connection probe can recover from one transient auth failure', async () => { const h = harness({ env: { ...env, OA_MEETING_BOT_ENABLED: 'false' } }, [new Error('transient'), { code: 0, tenant_access_token: 'tenant_token_offline' }, new Response(JSON.stringify({ code: 99991668 }), { status: 400, headers: { 'content-type': 'application/json' } })]); const response = await h.run(request({ action: 'check' })); const data = await response.json(); assert.equal(response.status, 200); assert.equal(data.credentialsVerified, true); assert.equal(data.joinTransportVerified, true); assert.equal(h.calls.length, 3); });
test('auth timeout is retried once and safely classified', async () => { const first = new Error('SECRET_1'); first.name = 'TimeoutError'; const second = new Error('SECRET_2'); second.name = 'AbortError'; const h = harness({}, [first, second]); const data = await (await h.run()).json(); assert.equal(data.outcomeUnknown, false); assert.equal(data.diagnostic, 'AUTH_TIMEOUT'); assert.equal(h.calls.length, 2); assert.ok(!JSON.stringify(data).includes('SECRET')); });
test('auth redirect is not followed and never sends mutation', async () => { const h = harness({}, [new Response(null, { status: 302, headers: { location: 'https://example.test/' } })]); const data = await (await h.run()).json(); assert.equal(data.diagnostic, 'AUTH_REDIRECT'); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].redirect, 'manual'); });
test('auth non-JSON response is safely classified', async () => { const h = harness({}, [new Response('<html>PRIVATE</html>', { headers: { 'content-type': 'text/html' } })]); const data = await (await h.run()).json(); assert.equal(data.diagnostic, 'AUTH_CONTENT_TYPE'); assert.equal(h.calls.length, 1); assert.ok(!JSON.stringify(data).includes('PRIVATE')); });
test('missing numeric success code is not accepted', async () => { const h = harness({}, [{ tenant_access_token: 'token' }]); const response = await h.run(); const data = await response.json(); assert.equal(response.status, 502); assert.equal(data.diagnostic, 'AUTH_RESPONSE_INVALID'); assert.equal(h.calls.length, 1); });
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
    '../../../../lib/feishu-meeting-bot.mjs': { handleBotRequest: async (_request, options) => { handedOff = true; await options.claimWrite('leave'); await options.claimWrite('events'); await options.claimWrite('join'); return Response.json({ ok: await options.checkAdmission() }); } },
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
test('route reuses live admin guard and separates leave, events and control rate limits', async () => { const h = routeHarness(admin); assert.equal((await h.run()).status, 200); assert.deepEqual(h.scopes, ['meeting_bot_leave', 'meeting_bot_events', 'meeting_bot_control']); });
