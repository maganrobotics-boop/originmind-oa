import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { BOT_SCOPE, createMeetingBotStore, handleMeetingBotRequest, meetingNumber, resolveMeetingBotConfig } from '../lib/feishu-meeting-bot.mjs';

const ORIGIN = 'https://oa.example.test';
const ID = '36ad7226-8df4-429a-8e43-7978531f0001';
const SECOND = '36ad7226-8df4-429a-8e43-7978531f0002';
const LONG = '7347912458617832001';
const env = { OA_MEETING_BOT_ENABLED: 'true', FEISHU_LOGIN_ENABLED: 'false', FEISHU_LOGIN_APP_ID: 'cli_test123', FEISHU_LOGIN_APP_SECRET: 'only-a-test-secret', FEISHU_LOGIN_TENANT_KEY: 'tenant_test', OA_PUBLIC_ORIGIN: ORIGIN };
const config = resolveMeetingBotConfig(env);
const actor = { isAdmin: true, memberId: 'member1', accountId: 'account1', revision: 'revision1' };
const guard = 'EXISTS(SELECT 1 FROM admission WHERE member_id=? AND account_id=? AND revision=? AND admitted=1)';
const json = (data, status = 200, extra = {}) => Response.json(data, { status, headers: extra });
const ok = data => json({ code: 0, data });
const joinBody = overrides => ({ action: 'join', requestId: ID, meetingNumber: '123 456 789', consent: true, ...overrides });
const request = (body, headers = {}, method) => new Request(`${ORIGIN}/api/lab-ai/meeting-bot`, { method: method || (body ? 'POST' : 'GET'), headers: { origin: ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
function harness(override) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../scripts/sql/oa-meeting-bot-sessions.sql', import.meta.url), 'utf8'));
  sql.exec("CREATE TABLE admission(member_id TEXT,account_id TEXT,revision TEXT,admitted INTEGER); INSERT INTO admission VALUES('member1','account1','revision1',1); INSERT INTO admission VALUES('member2','account2','revision2',1)");
  const db = { prepare(query) { return { bind(...args) { const statement = sql.prepare(query); return { first: async () => statement.get(...args) || null, all: async () => ({ results: statement.all(...args) }), run: async () => ({ meta: { changes: Number(statement.run(...args).changes) } }) }; } }; } };
  const store = createMeetingBotStore(db, guard), calls = [];
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ url, path, init });
    if (override) { const result = await override(path, init, sql); if (result !== undefined) return result; }
    if (path.includes('tenant_access_token')) return json({ code: 0, tenant_access_token: 'a-secret-test-access-token', expire: 7200 });
    if (path.endsWith('/join')) return ok({ meeting: { id: LONG, meeting_no: '123456789', topic: '测试会议' } });
    if (path.endsWith('/leave')) return ok({});
    if (path.endsWith('/events')) return ok({ events: [], has_more: false });
    throw new Error('Unexpected endpoint');
  };
  const ctx = { config, actor, store, fetcher };
  return { sql, store, calls, ctx, async send(body, options = {}) { const response = await handleMeetingBotRequest(request(body, options.headers), { ...ctx, ...options.ctx }); return { status: response.status, body: await response.json(), headers: response.headers }; }, row: () => sql.prepare('SELECT * FROM oa_meeting_bot_sessions WHERE id=?').get(ID) };
}

test('configuration is disabled by default and independent of Feishu login', () => {
  assert.equal(resolveMeetingBotConfig({ ...env, OA_MEETING_BOT_ENABLED: undefined }), null);
  assert.equal(config.clientId, 'cli_test123'); assert.equal(BOT_SCOPE, 'vc:meeting.bot.join:write');
  assert.equal(resolveMeetingBotConfig({ ...env, OA_MEETING_BOT_APP_ID: 'cli_other' }), null);
  assert.equal(resolveMeetingBotConfig({ ...env, OA_MEETING_BOT_APP_SECRET: 'half-pair' }), null);
  assert.equal(resolveMeetingBotConfig({ ...env, OA_PUBLIC_ORIGIN: ORIGIN + '/wrong' }), null);
  assert.equal(resolveMeetingBotConfig({ ...env, OA_PUBLIC_ORIGIN: 'http://oa.example.test' }), null);
});
for (const value of ['123456789', '123 456 789', 'https://vc.feishu.cn/j/123456789', 'https://vc.feishu.cn/j/123456789/']) test(`strict meeting number accepts ${value}`, () => assert.equal(meetingNumber(value), '123456789'));
for (const value of [LONG, 123456789, '12345678', 'foo123456789', 'https://vc.feishu.cn.evil.test/j/123456789', 'https://vc.feishu.cn/j/123456789?token=bad', 'http://vc.feishu.cn/j/123456789', 'https://user:pass@vc.feishu.cn/j/123456789', 'https://vc.feishu.cn:443/j/123456789#bad']) test(`meeting input rejects ${value}`, () => assert.throws(() => meetingNumber(value)));

test('read-only preflight does not call Feishu or imply permissions verified', async () => {
  const h = harness(); const result = await h.send(); assert.equal(result.status, 200); assert.equal(result.body.permissionsVerified, false); assert.equal(h.calls.length, 0); assert.equal(result.headers.get('cache-control'), 'private, no-store, max-age=0');
});
test('disabled configuration and non-administrator requests fail closed', async () => {
  const h = harness(); assert.equal((await h.send(joinBody(), { ctx: { config: null } })).status, 503);
  assert.equal((await h.send(joinBody(), { ctx: { actor: { ...actor, isAdmin: false } } })).status, 403); assert.equal(h.calls.length, 0);
});
test('same-origin, explicit consent and valid request identity required', async () => {
  const h = harness();
  for (const headers of [{ origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }, { origin: '' }]) assert.equal((await h.send(joinBody(), { headers })).status, 403);
  for (const changes of [{ consent: false }, { consent: 'true' }, { requestId: 'wrong' }, { password: '\nsecret' }]) assert.equal((await h.send(joinBody(changes))).status, 400);
  assert.equal(h.calls.length, 0);
});
test('malformed and oversized input is rejected before any network request', async () => {
  const h = harness();
  for (const body of ['{}x', JSON.stringify({ ignored: 'x'.repeat(9000) })]) {
    const response = await handleMeetingBotRequest(new Request(`${ORIGIN}/api/lab-ai/meeting-bot`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body }), h.ctx); assert.equal(response.status, 400);
  }
  assert.equal(h.calls.length, 0);
});
test('joins using exact documented bot payload, saves long id, never exposes secrets', async () => {
  const h = harness(); const result = await h.send(joinBody({ password: 'test-password' }));
  assert.equal(result.status, 200); assert.equal(result.body.joinedVerified, false); assert.equal(result.body.session.state, 'accepted'); assert.equal(h.row().meeting_id, LONG);
  assert.deepEqual(JSON.parse(h.calls[1].init.body), { join_type: 1, join_identify: { meeting_no: '123456789' }, password: 'test-password' });
  assert.equal(h.calls[1].init.headers.authorization, 'Bearer a-secret-test-access-token'); assert.equal(h.calls[1].init.redirect, 'error');
  assert.doesNotMatch(JSON.stringify(result.body) + JSON.stringify(h.row()), /test-password|only-a-test-secret|a-secret-test-access-token/u);
});
test('replay of same operation recovers without a second visible join', async () => {
  const h = harness(); await h.send(joinBody()); const result = await h.send(joinBody()); assert.equal(result.body.reused, true); assert.equal(h.calls.filter(call => call.path.endsWith('/join')).length, 1);
  assert.equal((await h.send(joinBody({ meetingNumber: '987654321' }))).status, 409);
});
test('SQL active-meeting uniqueness protects concurrent requests and other admins', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness(async path => { if (path.endsWith('/join')) { await gate; return ok({ meeting: { id: LONG, meeting_no: '123456789' } }); } });
  const first = h.send(joinBody()); await new Promise(resolve => setTimeout(resolve, 5));
  const duplicate = await h.send(joinBody({ requestId: SECOND })); assert.equal(duplicate.status, 409);
  const other = await h.send(joinBody(), { ctx: { actor: { isAdmin: true, memberId: 'member2', accountId: 'account2', revision: 'revision2' } } }); assert.equal(other.status, 409);
  release(); await first; assert.equal(h.calls.filter(call => call.path.endsWith('/join')).length, 1);
});
test('admission is checked after token acquisition and before join', async () => {
  const h = harness((path, init, sql) => { if (path.includes('tenant_access_token')) sql.exec('UPDATE admission SET admitted=0'); });
  const result = await h.send(joinBody()); assert.equal(result.status, 403); assert.equal(h.row().state, 'failed'); assert.equal(h.calls.length, 1);
});
test('permission refusal preserves diagnostic but never forwards raw upstream message', async () => {
  const h = harness(path => path.endsWith('/join') ? json({ code: 121003, msg: 'SECRET-UPSTREAM' }, 403, { 'x-tt-logid': 'safe-log-123' }) : undefined);
  const result = await h.send(joinBody()); assert.equal(result.status, 403); assert.equal(result.body.logId, 'safe-log-123'); assert.equal(h.row().state, 'failed'); assert.doesNotMatch(JSON.stringify(result.body), /SECRET-UPSTREAM/u);
});
test('token failure does not issue join or leave an uncertain mutation', async () => {
  const h = harness(path => path.includes('tenant_access_token') ? json({ code: 99991661 }, 400) : undefined);
  assert.equal((await h.send(joinBody())).status, 502); assert.equal(h.calls.length, 1); assert.equal(h.row().state, 'failed');
});
for (const mode of ['timeout', 'html', 'wrong-number', 'no-id', 'http500']) test(`uncertain join ${mode} remains durable and blocks silent retry`, async () => {
  const h = harness(path => {
    if (!path.endsWith('/join')) return;
    if (mode === 'timeout') throw new Error('timed out');
    if (mode === 'html') return new Response('not JSON', { status: 200 });
    if (mode === 'http500') return json({ code: 999 }, 500);
    return ok({ meeting: { id: mode === 'no-id' ? '' : LONG, meeting_no: mode === 'wrong-number' ? '987654321' : '123456789' } });
  });
  assert.equal((await h.send(joinBody())).status, 502); assert.equal(h.row().state, 'join_unknown');
  const count = h.calls.length; const result = await h.send(joinBody()); assert.equal(result.body.reused, true); assert.equal(h.calls.length, count);
  assert.equal((await h.send(joinBody({ requestId: SECOND }))).status, 409);
});
test('poll uses only the stored long id and becomes verified only after valid event response', async () => {
  const h = harness(path => path.endsWith('/events') ? ok({ events: [{ event_id: 'ev1', event_time: '1789783000000', payload: { transcript_received_items: [{ speaker: { id: 'u1', user_name: '测试发言人', user_type: 1 }, sentence_id: 's1', text: '只是一条测试字幕', start_time_ms: '1789783000000' }] } }], has_more: true, page_token: 'next-page' }) : undefined);
  await h.send(joinBody()); const result = await h.send({ action: 'poll', sessionId: ID, meetingId: '999999999999', cursor: 'previous' });
  assert.equal(result.status, 200); assert.equal(result.body.active, true); assert.equal(result.body.entries[0].text, '只是一条测试字幕'); assert.equal(h.row().state, 'verified');
  const url = new URL(h.calls.at(-1).url); assert.equal(url.searchParams.get('meeting_id'), LONG); assert.equal(url.searchParams.get('page_token'), 'previous'); assert.equal(result.body.cursor, 'next-page');
});
test('invalid events do not advance state or claim success', async () => {
  const h = harness(path => path.endsWith('/events') ? ok({ events: [{}], has_more: true }) : undefined);
  await h.send(joinBody()); assert.equal((await h.send({ action: 'poll', sessionId: ID })).status, 502); assert.equal(h.row().state, 'accepted'); assert.equal(h.row().last_verified_at, 0);
});
test('session authorization binds owner and configured application', async () => {
  const h = harness(); await h.send(joinBody());
  for (const ctx of [{ actor: { ...actor, accountId: 'other' } }, { config: { ...config, binding: 'different-app' } }]) assert.equal((await h.send({ action: 'poll', sessionId: ID }, { ctx })).status, 404);
});
test('only an explicit leave uses bots/leave and never ends the whole meeting', async () => {
  const h = harness(); await h.send(joinBody());
  assert.equal((await h.send({ action: 'leave', sessionId: ID })).status, 400);
  const result = await h.send({ action: 'leave', sessionId: ID, confirmLeave: true }); assert.equal(result.body.left, true); assert.equal(h.row().state, 'left');
  assert.deepEqual(JSON.parse(h.calls.at(-1).init.body), { meeting_id: LONG }); assert.ok(h.calls.at(-1).path.endsWith('/bots/leave'));
  const count = h.calls.length; assert.equal((await h.send({ action: 'leave', sessionId: ID, confirmLeave: true })).body.reused, true); assert.equal(h.calls.length, count);
  assert.equal((await h.send({ action: 'poll', sessionId: ID })).status, 409);
});
test('concurrent leave is claimed once and a timeout remains unknown', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness(async path => { if (path.endsWith('/leave')) { await gate; throw new Error('timeout'); } });
  await h.send(joinBody()); const first = h.send({ action: 'leave', sessionId: ID, confirmLeave: true }); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await h.send({ action: 'leave', sessionId: ID, confirmLeave: true })).status, 409); release(); await first; assert.equal(h.row().state, 'leave_unknown');
});
test('receipts remain recorded if admission changes after the visible operation', async () => {
  const h = harness((path, init, sql) => { if (path.endsWith('/join')) sql.exec('UPDATE admission SET admitted=0'); });
  assert.equal((await h.send(joinBody())).status, 200); assert.equal(h.row().state, 'accepted');
  assert.equal((await h.send({ action: 'leave', sessionId: ID, confirmLeave: true })).status, 409);
});
test('schema initialization is additive/idempotent; no secrets or transcript columns', () => {
  const h = harness(); h.sql.exec(readFileSync(new URL('../scripts/sql/oa-meeting-bot-sessions.sql', import.meta.url), 'utf8'));
  const columns = h.sql.prepare('PRAGMA table_info(oa_meeting_bot_sessions)').all().map(row => row.name).join(','); assert.doesNotMatch(columns, /token|secret|password|transcript/u);
});
test('route enforces current administrator admission and does not enable OAuth', () => {
  const source = readFileSync(new URL('../app/api/lab-ai/meeting-bot/route.ts', import.meta.url), 'utf8');
  assert.match(source, /!user\.isAdmin/u); assert.match(source, /taskActorGuard/u); assert.match(source, /user\.memberMutationRevision/u); assert.doesNotMatch(source, /getFeishuOAuthConfig|authen\/v2/u);
});
test('UI distinguishes bot identity, historical checks and foreground capture; no auto-answer/leave', () => {
  const source = readFileSync(new URL('../components/knowledge/oa-meeting-bot.tsx', import.meta.url), 'utf8');
  for (const text of ['不自动接听飞书呼叫', '关闭页面不会让机器人退出', '不保证补齐断线期间内容', 'window.confirm', 'MEETING_INSTRUCTION', 'requestId: part.requestId']) assert.ok(source.includes(text));
  assert.doesNotMatch(source, /localStorage|sessionStorage|navigator\.mediaDevices/u);
});

test('chat meeting mode mounts bot without discarding capture on panel toggle', () => {
  const source = readFileSync(new URL('../components/knowledge/oa-meeting-listener.tsx', import.meta.url), 'utf8');
  assert.match(source, /<OaMeetingBot open=\{open\} onTask=\{onTask\} onDirty=\{onDirty\} \/>/u);
  assert.ok(source.indexOf('<OaMeetingBot ') < source.indexOf('{open && <details>'));
  assert.match(source, /备选：用户身份旁听（不显示机器人）/u);
});
test('migration freeze blocks record mutations and UI retains explicit hidden state', () => {
  const route = readFileSync(new URL('../app/api/lab-ai/meeting-bot/route.ts', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../components/knowledge/oa-meeting-bot.tsx', import.meta.url), 'utf8');
  assert.match(route, /shouldBlockForMigrationFreeze\(request, settings\)/u);
  assert.ok(ui.includes("style={open ? undefined : { display: 'none' }}"));
  assert.ok(ui.includes("['failed', 'left'].includes(item.state)"));
});
