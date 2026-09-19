import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validMeetingId, isMeetingCommand, normalizeMeetingEvents, mergeCapture, captureText, meetingParts } from '../lib/oa-meeting-capture.mjs';
import { seal, unseal, readCookie, safeReturnPath, feishuJson, activeMeetings, eventPage, handleMeetingRequest, GRANT_COOKIE, STATE_COOKIE, MEETING_PATH, MEETING_SCOPE } from '../lib/feishu-meeting-listen.mjs';
const id = '7612345678901234567';
const key = 'ab'.repeat(32); // Synthetic test key; never a deployment credential.
const origin = 'https://oa.example.test';
const config = { origin, clientId: 'cli_test', clientSecret: 'synthetic-app-secret', tenantKey: 'tenant_test' };
const actor = ['member-test', 'account-test', 'revision-test'];
const aad = JSON.stringify(['oa-feishu-listen-v1', origin, config.clientId, config.tenantKey, actor]);
const json = data => Response.json({ code: 0, data });
const transcript = (text = '讨论方案', revision = '1789700001000') => ({ event_id: `e-${revision}`, event_time: revision, activity_event_type: 'transcript_received', payload: { transcript_received_items: [{ sentence_id: 'sentence-one', speaker: { id: 'voice_1', user_type: 100, user_name: '说话人1' }, text, start_time_ms: '1789700000000', end_time_ms: revision }] } });
const post = (body, cookies = '', extra = {}) => new Request(origin + MEETING_PATH, { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie: cookies, ...extra }, body: JSON.stringify(body) });
async function grantCookie(extra = {}) { return `${GRANT_COOKIE}=${await seal({ token: 'synthetic-user-token', name: '测试用户', exp: Date.now() + 100000, ...extra }, key, `${aad}:grant`)}`; }
const ctx = fetcher => ({ actor, config, key, fetcher });
const noFetch = async () => { throw new Error('UNEXPECTED_NETWORK_CALL'); };

test('long meeting IDs stay strings; 9-digit display numbers and unsafe numbers rejected', () => {
  assert.equal(validMeetingId(id), true);
  for (const invalid of ['919700881', Number(id), '-12345678900', '9223372036854775808', '//evil.test']) assert.equal(validMeetingId(invalid), false);
});
test('@会议模式 dispatch does not hijack a normal question or other capability', () => {
  for (const value of ['@会议模式', '＠会议模式，开启', '@会议模式 919 700 881']) assert.equal(isMeetingCommand(value), true);
  for (const value of ['会议模式是什么', '@会议模式化', '@会议纪要']) assert.equal(isMeetingCommand(value), false);
});
test('known arrays match the supplied PDF, voiceprint identities are preserved without inference', () => {
  const page = normalizeMeetingEvents([transcript()]);
  assert.equal(page.entries[0].actor.userType, 100);
  assert.match(captureText(mergeCapture(new Map(), page.entries)), /身份需核对/u);
});
test('sentence corrections replace old text, replay is idempotent, older revisions cannot roll back', () => {
  let map = mergeCapture(new Map(), normalizeMeetingEvents([transcript()]).entries);
  map = mergeCapture(map, normalizeMeetingEvents([transcript('修正后的决定', '1789700002000')]).entries);
  map = mergeCapture(map, normalizeMeetingEvents([transcript('旧版本', '1789700001000')]).entries);
  assert.equal(map.size, 1); assert.equal([...map.values()][0].text, '修正后的决定');
});
test('same display names but different speaker IDs remain distinct', () => {
  const other = transcript(); other.payload.transcript_received_items[0].speaker.id = 'voice_2';
  assert.equal(mergeCapture(new Map(), normalizeMeetingEvents([transcript(), other]).entries).size, 2);
});
test('missing sentence IDs do not discard different lines in the same event', () => {
  const event = transcript(); delete event.payload.transcript_received_items[0].sentence_id;
  event.payload.transcript_received_items.push({ ...event.payload.transcript_received_items[0], text: '第二句' });
  assert.equal(mergeCapture(new Map(), normalizeMeetingEvents([event]).entries).size, 2);
});
test('encrypted chat stays opaque and participant enter/leave events are retained', () => {
  const result = normalizeMeetingEvents([{ payload: { chat_received_items: [{ operator: { id: 'u' }, message_id: 'm1', message_type: 4, content: 'ciphertext' }], participant_joined_items: [{ participant: { id: 'u' }, join_time: '1789700001000' }], participant_left_items: [{ participant: { id: 'u' }, leave_reason: 2, leave_time: '1789700002000' }] } }]);
  assert.equal(result.entries.length, 3); assert.doesNotMatch(result.entries[0].text, /ciphertext/u);
});
test('unknown event types are explicit, malformed items fail rather than silently advance', () => {
  assert.equal(normalizeMeetingEvents([{ payload: { something_new: [] } }]).unsupported, 1);
  assert.throws(() => normalizeMeetingEvents([{ payload: { transcript_received_items: [{}] } }]), /MEETING_SCHEMA/u);
});
test('capture limits leave the existing map unchanged', () => {
  const before = new Map(); assert.throws(() => mergeCapture(before, normalizeMeetingEvents([transcript()]).entries, 1), /MEETING_CAPTURE_LIMIT/u); assert.equal(before.size, 0);
});
test('out-of-range upstream timestamps cannot break text export', () => {
  const event = transcript(); event.event_time = '9999999999999999'; event.payload.transcript_received_items[0].start_time_ms = '9999999999999999';
  assert.doesNotThrow(() => captureText(mergeCapture(new Map(), normalizeMeetingEvents([event]).entries)));
});
test('long materials split without omission, duplication or splitting surrogate pairs', () => {
  const text = ('材料🦾\n'.repeat(16000)); const parts = meetingParts(text);
  assert.equal(parts.join(''), text); assert.ok(parts.length > 1); assert.ok(parts.every(part => part.length <= 18000 && !/[\uD800-\uDBFF]$/u.test(part)));
});
test('grants are authenticated, encrypted, actor-bound and expiring', async () => {
  const value = { token: 'secret-fixture', exp: Date.now() + 10000 };
  const sealed = await seal(value, key, aad);
  assert.doesNotMatch(sealed, /secret-fixture/u);
  assert.deepEqual(await unseal(sealed, key, aad), value);
  assert.equal(await unseal(sealed, key, aad + 'another-member'), null);
  assert.equal(await unseal(sealed.slice(0, -4) + 'AAAA', key, aad), null);
  assert.equal(await unseal(sealed, key, aad, value.exp + 1), null);
});
test('independent encryption key and cookie size limits fail closed', async () => {
  await assert.rejects(seal({ exp: Date.now() + 1000 }, 'short', aad), /MEETING_CONFIG/u);
  await assert.rejects(seal({ exp: Date.now() + 1000, token: 'x'.repeat(4000) }, key, aad), /MEETING_COOKIE_SIZE/u);
});
test('ambiguous duplicate cookies are not accepted', () => {
  assert.equal(readCookie(new Request(origin, { headers: { cookie: `${GRANT_COOKIE}=one; ${GRANT_COOKIE}=two` } }), GRANT_COOKIE), '');
});
test('OAuth return paths cannot redirect externally or to private API actions', () => {
  for (const path of ['https://evil.test/', '//evil.test', '/\\evil.test', '/api/auth/logout', '/\n/evil']) assert.equal(safeReturnPath(path, origin), '/');
  assert.equal(safeReturnPath('/knowledge?tab=ask', origin), '/knowledge?tab=ask');
});
test('HTTP client only permits specific Feishu endpoints and never follows redirects', async () => {
  await assert.rejects(feishuJson('https://evil.test/', {}, noFetch), /MEETING_UPSTREAM/u);
  await feishuJson('/open-apis/vc/v1/bots/user_active_meeting', {}, async (url, options) => { assert.equal(new URL(url).origin, 'https://open.feishu.cn'); assert.equal(options.redirect, 'error'); return json({ meetings: [] }); });
});
test('non-JSON, oversized and permission-error responses are rejected without leaking messages', async () => {
  await assert.rejects(feishuJson('/open-apis/vc/v1/bots/events', {}, async () => new Response('<html>no</html>')), /MEETING_SCHEMA/u);
  await assert.rejects(feishuJson('/open-apis/vc/v1/bots/events', {}, async () => Response.json({ text: 'x'.repeat(1100000) })), /MEETING_SCHEMA/u);
  await assert.rejects(feishuJson('/open-apis/vc/v1/bots/events', {}, async () => Response.json({ code: 99, msg: 'secret-token' })), /^Error: MEETING_PERMISSION$/u);
});
test('active meeting API uses UAT, no target user argument and returns all choices', async () => {
  const list = await activeMeetings('uat-fixture', async (url, options) => { assert.equal(new URL(url).search, ''); assert.equal(options.headers.authorization, 'Bearer uat-fixture'); return json({ meetings: [{ meeting_id: id, meeting_no: '919700881', meeting_title: '周会' }, { meeting_id: '7612345678901234568' }] }); });
  assert.equal(list.length, 2); assert.equal(list[0].id, id);
});
test('raw data.events schema and incremental page_token match official CLI implementation', async () => {
  const page = await eventPage('uat', id, 'old', async url => { const query = new URL(url).searchParams; assert.equal(query.get('meeting_id'), id); assert.equal(query.get('page_token'), 'old'); assert.equal(query.get('page_size'), '100'); return json({ events: [transcript()], has_more: true, page_token: 'next' }); });
  assert.equal(page.entries.length, 1); assert.equal(page.cursor, 'next'); assert.equal(page.hasMore, true);
});
test('bad pagination never masquerades as a complete successful page', async () => {
  for (const page of [{ events: [], has_more: true }, { events: [], has_more: true, page_token: 'old' }, { items: [], has_more: false }]) await assert.rejects(eventPage('uat', id, 'old', async () => json(page)), /MEETING_(CURSOR|SCHEMA)/u);
});
test('last cursor is retained on empty polls for safe idempotent replay', async () => {
  assert.equal((await eventPage('uat', id, 'old', async () => json({ events: [], has_more: false }))).cursor, 'old');
});
test('unconfigured and unauthenticated status never claim active listening or contact Feishu', async () => {
  const response = await handleMeetingRequest(new Request(origin + MEETING_PATH), ctx(noFetch));
  const data = await response.json(); assert.equal(data.authorized, false); assert.equal(data.active, undefined);
});
test('cross-origin POST, unknown parameters and malformed JSON are rejected', async () => {
  assert.equal((await handleMeetingRequest(post({ action: 'authorize' }, '', { origin: 'https://evil.test' }), ctx(noFetch))).status, 403);
  assert.equal((await handleMeetingRequest(post({ action: 'authorize', token: 'injected' }), ctx(noFetch))).status, 400);
  assert.equal((await handleMeetingRequest(new Request(origin + MEETING_PATH, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{' }), ctx(noFetch))).status, 400);
});
test('authorization requires independent scope, PKCE, random state and HttpOnly handoff', async () => {
  const response = await handleMeetingRequest(post({ action: 'authorize', returnTo: '/knowledge' }), ctx(noFetch));
  const result = await response.json(); const url = new URL(result.authorizationUrl);
  assert.equal(url.searchParams.get('scope'), MEETING_SCOPE); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), origin + MEETING_PATH);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/u);
  assert.doesNotMatch(JSON.stringify(result), /verifier|client_secret|synthetic-app-secret/u);
});
test('successful callback encrypts token, binds identity and consumes state cookie', async () => {
  const begin = await handleMeetingRequest(post({ action: 'authorize', returnTo: '/knowledge' }), ctx(noFetch));
  const authorize = new URL((await begin.json()).authorizationUrl);
  const stateCookie = begin.headers.get('set-cookie').split(';')[0]; let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    if (url.includes('/oauth/token')) { const body = JSON.parse(options.body); assert.equal(body.redirect_uri, origin + MEETING_PATH); assert.ok(body.code_verifier.length >= 43); return Response.json({ access_token: 'uat-fixture', expires_in: 3600, scope: MEETING_SCOPE }); }
    return json({ tenant_key: config.tenantKey, open_id: 'ou_fixture', name: '测试人' });
  };
  const callback = new Request(`${origin}${MEETING_PATH}?code=fixture&state=${authorize.searchParams.get('state')}`, { headers: { cookie: stateCookie } });
  const response = await handleMeetingRequest(callback, ctx(fetcher));
  assert.equal(calls, 2); assert.equal(response.status, 303); assert.equal(response.headers.get('location'), origin + '/knowledge?oaMeetingAuth=connected');
  const cookies = response.headers.getSetCookie(); assert.ok(cookies.some(value => value.startsWith(STATE_COOKIE) && value.includes('Max-Age=0')));
  assert.ok(cookies.some(value => value.startsWith(GRANT_COOKIE) && value.includes('HttpOnly; SameSite=Strict')));
  assert.doesNotMatch(cookies.join(' '), /uat-fixture/u);
});
test('callback state or OA account mismatch cannot exchange a code', async () => {
  const handoff = await seal({ exp: Date.now() + 100000, state: 'correct', verifier: 'a'.repeat(43) }, key, aad + ':state');
  const response = await handleMeetingRequest(new Request(`${origin}${MEETING_PATH}?state=wrong&code=fixture`, { headers: { cookie: `${STATE_COOKIE}=${handoff}` } }), ctx(noFetch));
  assert.equal(response.status, 303); assert.match(response.headers.get('location'), /MEETING_AUTH/u);
});
test('missing consent and arbitrary meeting IDs cannot start listening', async () => {
  const cookie = await grantCookie();
  assert.equal((await handleMeetingRequest(post({ action: 'start', meetingId: id, consent: false }, cookie), ctx(noFetch))).status, 400);
  assert.equal((await handleMeetingRequest(post({ action: 'start', meetingId: id, consent: true }, cookie), ctx(async () => json({ meetings: [] })))).status, 409);
});
test('actual selected meeting starts with a server-issued listening ID but no fake events', async () => {
  const response = await handleMeetingRequest(post({ action: 'start', meetingId: id, consent: true }, await grantCookie()), ctx(async () => json({ meetings: [{ meeting_id: id, meeting_no: '919700881' }] })));
  const data = await response.json(); assert.match(data.listenId, /^[a-f0-9-]{36}$/u); assert.equal(data.meeting.id, id); assert.equal(data.entries, undefined);
});
test('poll refuses a stale or another tab listening session', async () => {
  const response = await handleMeetingRequest(post({ action: 'poll', meetingId: id, listenId: 'wrong' }, await grantCookie({ meetingId: id, listenId: 'right' })), ctx(noFetch));
  assert.equal(response.status, 409);
});
test('user no longer in selected meeting stops without requesting its events', async () => {
  let calls = 0;
  const response = await handleMeetingRequest(post({ action: 'poll', meetingId: id, listenId: 'right' }, await grantCookie({ meetingId: id, listenId: 'right' })), ctx(async url => { calls++; assert.match(url, /user_active_meeting/u); return json({ meetings: [] }); }));
  assert.equal((await response.json()).active, false); assert.equal(calls, 1);
});
test('poll verifies current attendance before using the selected long ID and UAT', async () => {
  const paths = [];
  const response = await handleMeetingRequest(post({ action: 'poll', meetingId: id, listenId: 'right', cursor: '' }, await grantCookie({ meetingId: id, listenId: 'right' })), ctx(async url => { paths.push(new URL(url).pathname); return url.includes('user_active_meeting') ? json({ meetings: [{ meeting_id: id }] }) : json({ events: [transcript()], has_more: false, page_token: 'last' }); }));
  const data = await response.json(); assert.equal(data.active, true); assert.equal(data.entries.length, 1); assert.equal(data.cursor, 'last'); assert.equal(paths.length, 2); assert.doesNotMatch(JSON.stringify(data), /synthetic-user-token/u);
});
test('stop clears selection but retains short-lived grant; disconnect clears this browser grant', async () => {
  const cookie = await grantCookie({ meetingId: id, listenId: 'right' });
  const response = await handleMeetingRequest(post({ action: 'stop', meetingId: id, listenId: 'right' }, cookie), ctx(noFetch));
  const raw = response.headers.get('set-cookie').split(';')[0].slice(GRANT_COOKIE.length + 1);
  assert.equal((await unseal(raw, key, aad + ':grant')).listenId, undefined);
  const end = await handleMeetingRequest(post({ action: 'disconnect' }, cookie), ctx(noFetch)); assert.match(end.headers.get('set-cookie'), /Max-Age=0/u);
});
test('OA route rechecks live admission/NDA; UI reuses guarded tasks and no auto archive', () => {
  const route = readFileSync(new URL('../app/api/lab-ai/meeting-listen/route.ts', import.meta.url), 'utf8');
  assert.match(route, /getAuthorizedUser/u); assert.match(route, /taskActorGuard/u); assert.match(route, /memberMutationRevision/u); assert.match(route, /OA_MEETING_LISTEN_ENABLED/u);
  const ui = readFileSync(new URL('../components/knowledge/oa-meeting-listener.tsx', import.meta.url), 'utf8');
  assert.match(ui, /kind: 'meeting_minutes'/u); assert.match(ui, /requestId: part.requestId/u); assert.doesNotMatch(ui, /fetch\([^\n]*(?:public|archive)/u);
  assert.doesNotMatch(ui, /localStorage\.(?:get|set)Item|dangerouslySetInnerHTML|navigator.mediaDevices/u);
});
test('chat command interception precedes both model/document dispatch and preserves four buttons', () => {
  const ui = readFileSync(new URL('../components/knowledge/oa-chat-panel.tsx', import.meta.url), 'utf8');
  assert.ok(ui.indexOf('isMeetingCommand(normalized)') < ui.indexOf('resolveChatCapability(normalized)'));
  assert.match(ui, /CHAT_DOCUMENT_HINTS\.map/u); assert.match(ui, /onTask=\{documents.restore\}/u); assert.match(ui, /meetingDirty \|\| turns.length/u);
});
