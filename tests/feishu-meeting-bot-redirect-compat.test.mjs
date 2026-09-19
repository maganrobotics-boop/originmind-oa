import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBotRequest } from '../lib/feishu-meeting-bot.mjs';

// Synthetic credentials only. This test double enforces workerd's redirect contract;
// the separate workerd test executes the real runtime with outbound networking disabled.
const env = {
  OA_PUBLIC_ORIGIN: 'https://oa.example.test', OA_MEETING_BOT_ENABLED: 'true',
  FEISHU_LOGIN_APP_ID: 'cli_offline123', FEISHU_LOGIN_APP_SECRET: 'offline_secret_only',
  FEISHU_LOGIN_TENANT_KEY: 'tenant_offline',
};
const inputs = {
  check: { action: 'check' },
  join: { action: 'join', meeting: '123456789', password: 'private_offline_password', confirmed: true },
  leave: { action: 'leave', meetingId: '7512345678901234567', confirmed: true },
};
async function run(action, redirectPhase, status = 302) {
  const calls = [];
  const response = await handleBotRequest(new Request(`${env.OA_PUBLIC_ORIGIN}/api/admin/meeting-bot`, {
    method: 'POST', headers: { origin: env.OA_PUBLIC_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(inputs[action]),
  }), {
    env, actorKey: 'offline-admin', checkAdmission: async () => true, claimWrite: async () => true,
    fetchImpl: async (url, init) => {
      // Unlike a permissive Node fetch stub, reject unsupported modes before any response.
      if (!['manual', 'follow'].includes(init.redirect)) throw new TypeError('Invalid redirect value');
      assert.equal(init.redirect, 'manual', 'credentials must never follow a redirect');
      calls.push({ url, ...init });
      const phase = calls.length === 1 ? 'auth' : action === 'check' ? 'probe' : action;
      if (phase === redirectPhase) return new Response(null, {
        status, headers: { location: 'https://do-not-contact.invalid/?private_offline_password' },
      });
      if (phase === 'auth') return Response.json({ code: 0, tenant_access_token: 'offline_token' });
      if (phase === 'probe') return Response.json({ code: 99991668 }, { status: 400 });
      return Response.json({ code: 0, data: { meeting: { id: inputs.leave.meetingId } } });
    },
  });
  return { response, data: await response.json(), calls };
}
for (const action of ['check', 'join', 'leave']) {
  test(`${action} uses a supported no-follow mode for authentication and operation`, async () => {
    const { response, data, calls } = await run(action);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(item => item.redirect), ['manual', 'manual']);
    if (action === 'check') {
      assert.equal(data.credentialsVerified, true);
      assert.equal(data.joinTransportVerified, true);
      assert.equal(data.permissionVerified, false);
      assert.equal(calls[1].headers.authorization, 'Bearer invalid_transport_probe');
      assert.deepEqual(JSON.parse(calls[1].body), { join_type: 0, join_identify: { meeting_no: '000000000' } });
      assert.ok(!JSON.stringify(calls[1]).includes('offline_token'));
    } else assert.equal(data.state, `${action}_api_succeeded`);
  });
}
for (const phase of ['auth', 'probe', 'join', 'leave']) {
  for (const status of [301, 302, 303, 307, 308]) {
    test(`${phase} HTTP ${status} is rejected, not followed or retried`, async () => {
      const action = phase === 'auth' || phase === 'probe' ? 'check' : phase;
      const { response, data, calls } = await run(action, phase, status);
      assert.equal(response.status, 502);
      assert.equal(data.diagnostic, `${phase.toUpperCase()}_REDIRECT`);
      assert.equal(data.upstreamStatus, status);
      assert.equal(data.outcomeUnknown, phase === 'join' || phase === 'leave');
      assert.equal(calls.length, phase === 'auth' ? 1 : 2);
      assert.ok(calls.every(item => item.url.startsWith('https://open.feishu.cn/open-apis/')));
      assert.ok(!JSON.stringify(data).includes('private_offline_password'));
      assert.ok(!JSON.stringify(data).includes('offline_token'));
      assert.ok(!JSON.stringify(data).includes('do-not-contact'));
      if (phase === 'probe') {
        assert.equal(data.credentialsVerified, true);
        assert.equal(data.joinTransportVerified, false);
        assert.equal(data.permissionVerified, false);
      }
    });
  }
}
