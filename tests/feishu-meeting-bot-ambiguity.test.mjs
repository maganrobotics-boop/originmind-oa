import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBotRequest } from '../lib/feishu-meeting-bot.mjs';

const env = {
  OA_PUBLIC_ORIGIN: 'https://oa.example.test', OA_MEETING_BOT_ENABLED: 'true',
  FEISHU_LOGIN_APP_ID: 'cli_offline123', FEISHU_LOGIN_APP_SECRET: 'offline_test_secret',
  FEISHU_LOGIN_TENANT_KEY: 'tenant_offline',
};
const auth = { code: 0, tenant_access_token: 'offline_token' };
const invalidCodes = [
  ['missing', {}], ['string', { code: '0' }], ['null', { code: null }],
  ['boolean', { code: false }], ['fractional', { code: 0.5 }],
  ['unsafe integer', { code: Number.MAX_SAFE_INTEGER + 1 }],
];
async function invoke(action, responses) {
  let calls = 0;
  const body = action === 'join' ? { action, meeting: '123456789', confirmed: true }
    : { action, meetingId: '7512345678901234567', confirmed: true };
  const request = new Request(`${env.OA_PUBLIC_ORIGIN}/api/admin/meeting-bot`, {
    method: 'POST', headers: { origin: env.OA_PUBLIC_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await handleBotRequest(request, {
    env, actorKey: 'admin:1', checkAdmission: async () => true, claimWrite: async () => true,
    fetchImpl: async () => {
      const item = responses[calls++];
      assert.ok(item, 'the service must never retry an ambiguous mutation');
      return item instanceof Response ? item : Response.json(item);
    },
  });
  return { status: response.status, data: await response.json(), calls };
}
for (const action of ['join', 'leave']) {
  for (const [label, payload] of invalidCodes) {
    test(`${action}: ${label} result code keeps outcome unknown`, async () => {
      const result = await invoke(action, [auth, { ...payload, msg: 'PRIVATE_RESPONSE_TEXT' }]);
      assert.equal(result.status, 502); assert.equal(result.calls, 2);
      assert.equal(result.data.outcomeUnknown, true);
      assert.match(result.data.error, /结果暂不明确/u);
      assert.ok(!JSON.stringify(result.data).includes('PRIVATE_RESPONSE_TEXT'));
    });
  }
  for (const status of [403, 408, 503]) {
    test(`${action}: success code contradicting HTTP ${status} is ambiguous`, async () => {
      const result = await invoke(action, [auth, Response.json({ code: 0 }, { status })]);
      assert.equal(result.status, 502); assert.equal(result.calls, 2);
      assert.equal(result.data.outcomeUnknown, true);
      assert.match(result.data.error, /结果暂不明确/u);
    });
  }
  test(`${action}: HTTP timeout does not unlock a repeat mutation`, async () => {
    const result = await invoke(action, [auth, Response.json({ code: 999 }, { status: 408 })]);
    assert.equal(result.data.outcomeUnknown, true); assert.equal(result.calls, 2);
  });
  test(`${action}: invalid JSON stays ambiguous`, async () => {
    const result = await invoke(action, [auth, new Response('{', { headers: { 'content-type': 'application/json' } })]);
    assert.equal(result.data.outcomeUnknown, true); assert.equal(result.calls, 2);
  });
  for (const status of [200, 403]) {
    test(`${action}: explicit business rejection at HTTP ${status} remains definite`, async () => {
      const result = await invoke(action, [auth, Response.json({ code: 121003, msg: 'PRIVATE_RESPONSE_TEXT' }, { status })]);
      assert.equal(result.status, 502); assert.equal(result.calls, 2);
      assert.equal(result.data.outcomeUnknown, false); assert.equal(result.data.code, 121003);
      assert.ok(!JSON.stringify(result.data).includes('PRIVATE_RESPONSE_TEXT'));
    });
  }
}
for (const [label, payload] of invalidCodes) {
  test(`auth: ${label} code prevents sending any mutation`, async () => {
    const result = await invoke('join', [{ ...payload, tenant_access_token: 'offline_token' }]);
    assert.equal(result.status, 502); assert.equal(result.calls, 1);
    assert.equal(result.data.outcomeUnknown, false);
  });
}
