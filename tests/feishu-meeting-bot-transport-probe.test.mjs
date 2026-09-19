import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBotRequest } from '../lib/feishu-meeting-bot.mjs';

const env = {
  OA_PUBLIC_ORIGIN: 'https://oa.example.test', OA_MEETING_BOT_ENABLED: 'true',
  FEISHU_LOGIN_APP_ID: 'cli_offline123', FEISHU_LOGIN_APP_SECRET: 'offline_test_secret',
  FEISHU_LOGIN_TENANT_KEY: 'tenant_offline',
};
const request = () => new Request(`${env.OA_PUBLIC_ORIGIN}/api/admin/meeting-bot`, {
  method: 'POST',
  headers: { origin: env.OA_PUBLIC_ORIGIN, 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'check' }),
});
async function run(second) {
  const calls = [];
  const response = await handleBotRequest(request(), {
    env, actorKey: 'admin:1', checkAdmission: async () => true, claimWrite: async () => true,
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init, json: JSON.parse(init.body) });
      if (calls.length === 1) return Response.json({ code: 0, tenant_access_token: 'real_tenant_token' });
      if (second instanceof Error) throw second;
      return second;
    },
  });
  return { response, data: await response.json(), calls };
}

test('check probes the join route with credentials and meeting data that cannot join', async () => {
  const result = await run(Response.json({ code: 99991668, msg: 'invalid token' }, { status: 400 }));
  assert.equal(result.response.status, 200);
  assert.equal(result.data.credentialsVerified, true);
  assert.equal(result.data.joinTransportVerified, true);
  assert.equal(result.data.permissionVerified, false);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[1].url, 'https://open.feishu.cn/open-apis/vc/v1/bots/join');
  assert.equal(result.calls[1].headers.authorization, 'Bearer invalid_transport_probe');
  assert.notEqual(result.calls[1].headers.authorization, 'Bearer real_tenant_token');
  assert.deepEqual(result.calls[1].json, { join_type: 0, join_identify: { meeting_no: '000000000' } });
  assert.equal(result.calls[1].redirect, 'error');
  assert.match(result.data.message, /未加入会议/u);
});

test('probe network failure is definite and cannot unlock or duplicate a real join', async () => {
  const result = await run(new Error('PRIVATE_NETWORK_DETAIL'));
  assert.equal(result.response.status, 502);
  assert.equal(result.data.diagnostic, 'PROBE_NETWORK');
  assert.equal(result.data.outcomeUnknown, false);
  assert.equal(result.calls.length, 2);
  assert.ok(!JSON.stringify(result.data).includes('PRIVATE_NETWORK_DETAIL'));
  assert.match(result.data.error, /未发送有效入会请求/u);
});

test('probe refuses an unexpected success envelope', async () => {
  const result = await run(Response.json({ code: 0 }));
  assert.equal(result.response.status, 502);
  assert.equal(result.data.diagnostic, 'PROBE_RESPONSE_INVALID');
  assert.equal(result.data.outcomeUnknown, false);
});
