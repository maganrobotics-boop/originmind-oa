import assert from 'node:assert/strict';
import test from 'node:test';

import { handleRequest } from '../chat-cloudflare/src/app.mjs';
import { D1DatabaseAdapter } from '../chat-cloudflare/test/d1-adapter.mjs';
import { OA_ADMIN_ORIGIN, OA_ADMIN_PATH, handleOaAdminBridge, signOaAdminRequest, validOaAdminPayload } from '../chat-cloudflare/src/oa-admin-bridge.mjs';

const secret = 'test-admin-service-secret-that-is-long-enough';
const now = Date.parse('2026-09-21T10:00:00.000Z');
const nonce = '11111111-2222-4333-8444-555555555555';

async function signedRequest(payload, body = JSON.stringify(payload)) {
  return new Request(`${OA_ADMIN_ORIGIN}${OA_ADMIN_PATH}`, {
    method: 'POST', body,
    headers: await signOaAdminRequest(body, secret, { now, nonce }),
  });
}

function context(request) {
  return { request, env: { PUBLIC_LAB_AI_SERVICE_TOKEN: secret } };
}

test('OA 管理桥只接受有界的白名单操作', () => {
  assert.equal(validOaAdminPayload({ operation: 'status' }), true);
  assert.equal(validOaAdminPayload({ operation: 'status', sessionToken: 'a'.repeat(64) }), true);
  assert.equal(validOaAdminPayload({ operation: 'set_password', password: 'a secure password', actor: 'oa-admin' }), true);
  assert.equal(validOaAdminPayload({ operation: 'config_save', sessionToken: 'a'.repeat(64), baseUrl: '', model: 'qwen-plus' }), true);
  assert.equal(validOaAdminPayload({ operation: 'set_password', password: 'short', actor: 'oa-admin' }), false);
  assert.equal(validOaAdminPayload({ operation: 'config_save', sessionToken: 'a'.repeat(64), baseUrl: '', model: 'gpt-5' }), false);
  assert.equal(validOaAdminPayload({ operation: 'status', apiKey: 'must-not-pass' }), false);
});

test('签名 OA 管理请求经防重放后才调用管理引擎', async () => {
  const calls = [];
  const payload = { operation: 'status', sessionToken: 'a'.repeat(64) };
  const response = await handleOaAdminBridge(context(await signedRequest(payload)), {
    claimRequest(value) { calls.push(['claim', value]); },
    handle(value) { calls.push(['handle', value]); return { initialized: true, signedIn: true }; },
  }, now);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, initialized: true, signedIn: true });
  assert.deepEqual(calls, [['claim', nonce], ['handle', payload]]);
});

test('未签名、篡改、带浏览器来源或 Cookie 的请求在引擎前被拒绝', async () => {
  const payload = { operation: 'status' };
  const valid = await signedRequest(payload);
  const variants = [
    new Request(`${OA_ADMIN_ORIGIN}${OA_ADMIN_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
    new Request(valid, { body: JSON.stringify({ operation: 'login', password: 'changed' }) }),
    new Request(await signedRequest(payload), { headers: { ...(Object.fromEntries((await signedRequest(payload)).headers)), origin: 'https://oa.omindos.ai' } }),
    new Request(await signedRequest(payload), { headers: { ...(Object.fromEntries((await signedRequest(payload)).headers)), cookie: 'session=browser' } }),
  ];
  for (const request of variants) {
    let touched = false;
    const response = await handleOaAdminBridge(context(request), {
      claimRequest() { touched = true; }, handle() { touched = true; },
    }, now);
    assert.equal(response.status, 401);
    assert.equal(touched, false);
  }
});

test('真实 Chat Worker 设置密码并加密保存已验证的百炼配置', async t => {
  const database = new D1DatabaseAdapter(); t.after(() => database.close());
  const env = {
    DB: database, APP_ORIGIN: OA_ADMIN_ORIGIN, ADMIN_EMAIL: 'owner@example.test',
    APP_ENCRYPTION_KEY: 'e'.repeat(48), RATE_LIMIT_HMAC_KEY: 'r'.repeat(48),
    PUBLIC_LAB_AI_SERVICE_TOKEN: secret,
  };
  const request = async payload => {
    const body = JSON.stringify(payload);
    return handleRequest(new Request(OA_ADMIN_ORIGIN + OA_ADMIN_PATH, {
      method: 'POST', body, headers: await signOaAdminRequest(body, secret),
    }), env, {}, { fetch: async (_url, init) => {
      assert.match(init.headers.Authorization, /^Bearer sk-test-secret/u);
      return Response.json({ choices: [{ message: { role: 'assistant', content: '连接成功' } }] });
    } });
  };

  const passwordResponse = await request({ operation: 'set_password', password: 'correct horse battery staple', actor: 'oa-account-1' });
  assert.equal(passwordResponse.status, 200);
  const passwordResult = await passwordResponse.json();
  assert.equal(passwordResult.signedIn, true);
  assert.match(passwordResult.sessionToken, /^[a-f0-9]{64}$/u);
  const account = database.sqlite.prepare('SELECT algorithm,hash FROM admin_account WHERE id=1').get();
  assert.equal(account.algorithm, 'PBKDF2-SHA-256');
  assert.doesNotMatch(account.hash, /correct horse/u);

  const saveResponse = await request({
    operation: 'config_save', sessionToken: passwordResult.sessionToken,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', apiKey: 'sk-test-secret',
  });
  assert.equal(saveResponse.status, 200);
  const saved = await saveResponse.json();
  assert.equal(saved.keyConfigured, true); assert.equal(saved.activeProvider, 'bailian');
  assert.equal(saved.apiKey, undefined); assert.equal(saved.encryptedKey, undefined);
  const stored = database.sqlite.prepare("SELECT value FROM settings WHERE id='model'").get();
  assert.doesNotMatch(stored.value, /sk-test-secret/u);

  const statusResponse = await request({ operation: 'status', sessionToken: passwordResult.sessionToken });
  const status = await statusResponse.json();
  assert.equal(status.signedIn, true); assert.equal(status.keyConfigured, true);
  assert.equal(status.apiKey, undefined); assert.equal(status.encryptedKey, undefined);
});
