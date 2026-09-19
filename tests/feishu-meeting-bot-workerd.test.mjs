import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, createFetchMock } from 'miniflare';

// Use the workerd runtime shipped with the repository's locked Cloudflare tooling.
// No live Feishu calls: unmocked outbound networking is disabled before startup.
const env = {
  OA_PUBLIC_ORIGIN: 'https://oa.example.test', OA_MEETING_BOT_ENABLED: 'true',
  FEISHU_LOGIN_APP_ID: 'cli_offline123', FEISHU_LOGIN_APP_SECRET: 'offline_secret_only',
  FEISHU_LOGIN_TENANT_KEY: 'tenant_offline',
};
const id = '7512345678901234567';
const inputs = {
  check: { action: 'check' },
  join: { action: 'join', meeting: '123456789', confirmed: true },
  leave: { action: 'leave', meetingId: id, confirmed: true },
};
const source = readFileSync(new URL('../lib/feishu-meeting-bot.mjs', import.meta.url), 'utf8');

test('meeting bot runs in workerd without real network or production credentials', { timeout: 60000 }, async t => {
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const mf = new Miniflare({
    modules: true, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
    script: `${source}\nexport default { fetch(request) { return handleBotRequest(request, {
      env: ${JSON.stringify(env)}, actorKey: 'offline-admin',
      checkAdmission: async () => true, claimWrite: async () => true,
    }); } };`,
    fetchMock,
  });
  t.after(async () => { try { await mf.dispose(); } finally { await fetchMock.close(); } });
  const pool = fetchMock.get('https://open.feishu.cn');
  function auth(redirect = false) {
    const interceptor = pool.intercept({
      method: 'POST', path: '/open-apis/auth/v3/tenant_access_token/internal',
      body: JSON.stringify({ app_id: env.FEISHU_LOGIN_APP_ID, app_secret: env.FEISHU_LOGIN_APP_SECRET }),
    });
    if (redirect) interceptor.reply(302, '', { headers: { location: 'https://do-not-contact.invalid/' } });
    else interceptor.reply(200, JSON.stringify({ code: 0, tenant_access_token: 'offline_runtime_token' }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  function operation(action, redirect = false) {
    const body = action === 'check' ? { join_type: 0, join_identify: { meeting_no: '000000000' } }
      : action === 'join' ? { join_type: 1, join_identify: { meeting_no: '123456789' } } : { meeting_id: id };
    const interceptor = pool.intercept({
      method: 'POST', path: `/open-apis/vc/v1/bots/${action === 'check' ? 'join' : action}`,
      body: JSON.stringify(body),
      headers: { authorization: action === 'check' ? 'Bearer invalid_transport_probe' : 'Bearer offline_runtime_token' },
    });
    if (redirect) interceptor.reply(307, '', { headers: { location: 'https://do-not-contact.invalid/' } });
    else interceptor.reply(action === 'check' ? 400 : 200,
      JSON.stringify(action === 'check' ? { code: 99991668 } : { code: 0, data: { meeting: { id } } }),
      { headers: { 'content-type': 'application/json' } });
  }
  async function dispatch(action) {
    const response = await mf.dispatchFetch(`${env.OA_PUBLIC_ORIGIN}/api/admin/meeting-bot`, {
      method: 'POST', headers: { origin: env.OA_PUBLIC_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(inputs[action]),
    });
    const data = await response.json();
    assert.ok(!JSON.stringify(data).includes('offline_runtime_token'));
    assert.ok(!JSON.stringify(data).includes('offline_secret_only'));
    return { response, data };
  }
  for (const action of ['check', 'join', 'leave']) {
    await t.test(`${action}: supported redirect mode reaches only the expected mock`, async () => {
      auth(); operation(action);
      const { response, data } = await dispatch(action);
      assert.equal(response.status, 200, JSON.stringify(data));
      if (action === 'check') {
        assert.equal(data.credentialsVerified, true);
        assert.equal(data.joinTransportVerified, true);
        assert.equal(data.permissionVerified, false);
      } else assert.equal(data.state, `${action}_api_succeeded`);
      fetchMock.assertNoPendingInterceptors();
    });
  }
  await t.test('authentication redirect never forwards the app secret or calls join', async () => {
    auth(true);
    const { response, data } = await dispatch('check');
    assert.equal(response.status, 502);
    assert.equal(data.diagnostic, 'AUTH_REDIRECT');
    assert.equal(data.outcomeUnknown, false);
    fetchMock.assertNoPendingInterceptors();
  });
  for (const action of ['check', 'join', 'leave']) {
    await t.test(`${action}: real runtime does not follow or retry HTTP 307`, async () => {
      auth(); operation(action, true);
      const { response, data } = await dispatch(action);
      assert.equal(response.status, 502);
      assert.equal(data.diagnostic, `${action === 'check' ? 'PROBE' : action.toUpperCase()}_REDIRECT`);
      assert.equal(data.upstreamStatus, 307);
      assert.equal(data.outcomeUnknown, action !== 'check');
      assert.ok(!JSON.stringify(data).includes('do-not-contact'));
      fetchMock.assertNoPendingInterceptors();
    });
  }
});
