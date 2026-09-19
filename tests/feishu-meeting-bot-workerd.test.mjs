import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, Response as FixtureResponse } from 'miniflare';

// Actual workerd Request/fetch, with every outbound request routed into a strict
// in-process fixture service. It has no network fallback and uses only fake data.
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
  let expected = [], calls = [], fixtureErrors = [];
  const mf = new Miniflare({
    modules: true, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
    script: `${source}\nexport default { fetch(request) {
      if (new URL(request.url).pathname === '/__runtime_redirect_contract__') {
        let errorRejected = false;
        try { new Request('https://never-contact.invalid/', { redirect: 'error' }); }
        catch (error) { errorRejected = error instanceof TypeError; }
        const manualAccepted = new Request('https://never-contact.invalid/', { redirect: 'manual' }).redirect === 'manual';
        return Response.json({ errorRejected, manualAccepted });
      }
      return handleBotRequest(request, {
        env: ${JSON.stringify(env)}, actorKey: 'offline-admin',
        checkAdmission: async () => true, claimWrite: async () => true,
      });
    } };`,
    // Unlike a fetchImpl stub, this runs only AFTER workerd constructs the request.
    // It replaces ALL outbound traffic, including redirects/unexpected retries.
    outboundService: async request => {
      try {
        const actual = { url: request.url, method: request.method,
          body: await request.text(), authorization: request.headers.get('authorization') };
        calls.push(actual);
        const next = expected.shift();
        assert.ok(next, 'unexpected outbound request: no real network fallback');
        assert.equal(actual.url, `https://open.feishu.cn/open-apis${next.path}`);
        assert.equal(actual.method, 'POST');
        assert.equal(actual.body, JSON.stringify(next.body));
        assert.equal(actual.authorization, next.authorization);
        if (next.redirect) return new FixtureResponse(null, {
          status: next.redirect, headers: { location: 'https://do-not-contact.invalid/' },
        });
        return new FixtureResponse(JSON.stringify(next.response), {
          status: next.status, headers: { 'content-type': 'application/json' },
        });
      } catch (error) {
        fixtureErrors.push(String(error));
        return new FixtureResponse('OFFLINE_FIXTURE_MISMATCH', { status: 500 });
      }
    },
  });
  t.after(() => mf.dispose());
  function auth(redirect = false) {
    return {
      path: '/auth/v3/tenant_access_token/internal', authorization: null,
      body: { app_id: env.FEISHU_LOGIN_APP_ID, app_secret: env.FEISHU_LOGIN_APP_SECRET },
      status: 200, response: { code: 0, tenant_access_token: 'offline_runtime_token' },
      redirect: redirect ? 302 : 0,
    };
  }
  function operation(action, redirect = false) {
    return {
      path: `/vc/v1/bots/${action === 'check' ? 'join' : action}`,
      authorization: action === 'check' ? 'Bearer invalid_transport_probe' : 'Bearer offline_runtime_token',
      body: action === 'check' ? { join_type: 0, join_identify: { meeting_no: '000000000' } }
        : action === 'join' ? { join_type: 1, join_identify: { meeting_no: '123456789' } } : { meeting_id: id },
      status: action === 'check' ? 400 : 200,
      response: action === 'check' ? { code: 99991668 } : { code: 0, data: { meeting: { id } } },
      redirect: redirect ? 307 : 0,
    };
  }
  async function dispatch(action, fixtures) {
    expected = [...fixtures]; calls = []; fixtureErrors = [];
    const response = await mf.dispatchFetch(`${env.OA_PUBLIC_ORIGIN}/api/admin/meeting-bot`, {
      method: 'POST', headers: { origin: env.OA_PUBLIC_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(inputs[action]),
    });
    const data = await response.json();
    assert.deepEqual(fixtureErrors, [], 'strict outbound fixtures must match');
    assert.equal(expected.length, 0, 'all expected requests reached the fixture service');
    assert.equal(calls.length, fixtures.length, 'no unexpected requests or retries');
    assert.ok(!JSON.stringify(data).includes('offline_runtime_token'));
    assert.ok(!JSON.stringify(data).includes('offline_secret_only'));
    return { response, data };
  }
  await t.test('locked workerd rejects error and accepts manual before any outbound traffic', async () => {
    const response = await mf.dispatchFetch(`${env.OA_PUBLIC_ORIGIN}/__runtime_redirect_contract__`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { errorRejected: true, manualAccepted: true });
    assert.equal(calls.length, 0);
    assert.deepEqual(fixtureErrors, []);
  });
  for (const action of ['check', 'join', 'leave']) {
    await t.test(`${action}: supported redirect mode reaches only the expected fixture`, async () => {
      const { response, data } = await dispatch(action, [auth(), operation(action)]);
      assert.equal(response.status, 200, JSON.stringify(data));
      if (action === 'check') {
        assert.equal(data.credentialsVerified, true);
        assert.equal(data.joinTransportVerified, true);
        assert.equal(data.permissionVerified, false);
      } else assert.equal(data.state, `${action}_api_succeeded`);
    });
  }
  await t.test('authentication redirect never forwards the app secret or calls join', async () => {
    const { response, data } = await dispatch('check', [auth(true)]);
    assert.equal(response.status, 502);
    assert.equal(data.diagnostic, 'AUTH_REDIRECT');
    assert.equal(data.outcomeUnknown, false);
  });
  for (const action of ['check', 'join', 'leave']) {
    await t.test(`${action}: real runtime does not follow or retry HTTP 307`, async () => {
      const { response, data } = await dispatch(action, [auth(), operation(action, true)]);
      assert.equal(response.status, 502);
      assert.equal(data.diagnostic, `${action === 'check' ? 'PROBE' : action.toUpperCase()}_REDIRECT`);
      assert.equal(data.upstreamStatus, 307);
      assert.equal(data.outcomeUnknown, action !== 'check');
      assert.ok(!JSON.stringify(data).includes('do-not-contact'));
    });
  }
});
