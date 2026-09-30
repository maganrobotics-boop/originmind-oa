import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const originalFetch = globalThis.fetch;
const originalEnvironment = Object.fromEntries([
  "WECOM_LOGIN_ENABLED", "WECOM_LOGIN_CORP_ID", "WECOM_LOGIN_AGENT_ID",
  "WECOM_LOGIN_APP_SECRET", "OA_PUBLIC_ORIGIN",
].map((key) => [key, process.env[key]]));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  cacheDir: `/tmp/oa-wecom-oauth-tests-${process.pid}`,
  optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});
const oauth = await vite.ssrLoadModule("/lib/wecom-oauth.ts");

beforeEach(() => {
  process.env.WECOM_LOGIN_ENABLED = "true";
  process.env.WECOM_LOGIN_CORP_ID = "ww_originmind_test";
  process.env.WECOM_LOGIN_AGENT_ID = "1000002";
  process.env.WECOM_LOGIN_APP_SECRET = "unit-test-app-secret";
  process.env.OA_PUBLIC_ORIGIN = "https://oa.example.test";
  globalThis.fetch = async () => { throw new Error("Unit tests must not make real network requests"); };
});

after(async () => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await vite.close();
});

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function mockExchange({ token, identity, member } = {}) {
  const responses = [
    token ?? { errcode: 0, access_token: "unit-test-access-token", expires_in: 7200 },
    identity ?? { errcode: 0, userid: "ZhangSan" },
    member ?? { errcode: 0, userid: "zhangsan", name: "张三", status: 1 },
  ];
  const calls = [];
  globalThis.fetch = async (input, options) => {
    calls.push({ url: new URL(String(input)), options });
    assert.ok(calls.length <= responses.length, "Unexpected WeCom request");
    const response = responses[calls.length - 1];
    return response instanceof Response ? response : json(response);
  };
  return calls;
}

test("WeCom authorization requests enterprise identity with a fixed same-origin mobile callback", () => {
  const config = oauth.getWecomOAuthConfig();
  const state = "a".repeat(43);
  const url = oauth.buildWecomAuthorizeUrl(config, state);
  assert.equal(url.origin, "https://open.weixin.qq.com");
  assert.equal(url.pathname, "/connect/oauth2/authorize");
  assert.equal(url.searchParams.get("appid"), "ww_originmind_test");
  assert.equal(url.searchParams.get("agentid"), "1000002");
  assert.equal(url.searchParams.get("redirect_uri"), "https://oa.example.test/api/auth/qr/callback/wecom");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "snsapi_base");
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.hash, "#wechat_redirect");
  assert.equal(url.searchParams.has("corpsecret"), false);
  assert.equal(url.searchParams.has("code_challenge"), false);
  assert.throws(() => oauth.buildWecomAuthorizeUrl(config, "short"), /state is invalid/u);
  for (const callbackUrl of [
    "https://attacker.example/api/auth/qr/callback/wecom",
    "https://oa.example.test/api/auth/qr/callback/wecom?return_to=https://attacker.example",
    "https://oa.example.test/api/auth/qr/callback/wecom#fragment",
    "https://user:pass@oa.example.test/api/auth/qr/callback/wecom",
    "https://oa.example.test/uncontrolled-page",
  ]) {
    assert.throws(() => oauth.buildWecomAuthorizeUrl({ ...config, callbackUrl }, state), /callback is invalid/u);
  }
  const controlledCallback = "https://oa.example.test/api/auth/qr/callback/wecom-test";
  assert.equal(oauth.buildWecomAuthorizeUrl({ ...config, callbackUrl: controlledCallback }, state).searchParams.get("redirect_uri"), controlledCallback);
});

test("WeCom identity is corporation scoped and case-insensitive, never matched by email or name", () => {
  assert.equal(oauth.wecomProviderSubject("ww_originmind_test", "ZhangSan"), "ww_originmind_test:zhangsan");
  assert.equal(oauth.wecomProviderSubject("ww_originmind_test", "ZHANGSAN"), "ww_originmind_test:zhangsan");
  assert.notEqual(oauth.wecomProviderSubject("ww_other_company", "zhangsan"), "ww_originmind_test:zhangsan");
  for (const userId of ["", "foreigncorp/zhangsan", " member ", "成员", "a".repeat(65), "user:admin", "user\n"]) {
    assert.throws(() => oauth.wecomProviderSubject("ww_originmind_test", userId), /invalid account identifier/u);
  }
  assert.throws(() => oauth.wecomProviderSubject("evil:corp", "zhangsan"), /invalid enterprise identifier/u);
});

test("WeCom code exchange verifies the same-app visible, active member before returning an identity", async () => {
  const calls = mockExchange({
    member: { errcode: 0, userid: "ZHANGSAN", name: "张三", status: 1, email: "owner@example.test", mobile: "123456789", open_userid: "ignored" },
  });
  const identity = await oauth.exchangeWecomCode(oauth.getWecomOAuthConfig(), "unit-test-code");
  assert.deepEqual(identity, { providerSubject: "ww_originmind_test:zhangsan", corpId: "ww_originmind_test", userId: "zhangsan", displayName: "张三" });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url.origin, "https://qyapi.weixin.qq.com");
  assert.equal(calls[0].url.pathname, "/cgi-bin/gettoken");
  assert.equal(calls[0].url.searchParams.get("corpid"), "ww_originmind_test");
  assert.equal(calls[0].url.searchParams.get("corpsecret"), "unit-test-app-secret");
  assert.equal(calls[1].url.pathname, "/cgi-bin/auth/getuserinfo");
  assert.equal(calls[1].url.searchParams.get("access_token"), "unit-test-access-token");
  assert.equal(calls[1].url.searchParams.get("code"), "unit-test-code");
  assert.equal(calls[1].url.searchParams.has("agentid"), false);
  assert.equal(calls[1].url.searchParams.has("corpsecret"), false);
  assert.equal(calls[2].url.pathname, "/cgi-bin/user/get");
  assert.equal(calls[2].url.searchParams.get("access_token"), "unit-test-access-token");
  assert.equal(calls[2].url.searchParams.get("userid"), "zhangsan");
  assert.equal(calls[2].url.searchParams.has("code"), false);
  for (const { options } of calls) {
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.doesNotMatch(JSON.stringify(identity), /access.token|app.secret|owner@example|123456789|ignored/u);
});

test("WeCom does not require a display name or sensitive member fields for authentication", async () => {
  mockExchange({ member: { errcode: 0, userid: "zhangsan", status: 1 } });
  const identity = await oauth.exchangeWecomCode(oauth.getWecomOAuthConfig(), "unit-test-code");
  assert.equal(identity.displayName, "企业微信成员");
  mockExchange({ member: { errcode: 0, userid: "zhangsan", status: 1, name: "  张\u0000三\n " } });
  assert.equal((await oauth.exchangeWecomCode(oauth.getWecomOAuthConfig(), "unit-test-code")).displayName, "张三");
});

test("WeCom rejects non-members, legacy identity shapes, and interconnected enterprise identities", async () => {
  for (const identity of [
    { errcode: 0, openid: "non-member" },
    { errcode: 0, external_userid: "external-member" },
    { errcode: 0, UserId: "legacy-response" },
    { errcode: 0, userid: "foreigncorp/zhangsan" },
    { errcode: 0, userid: "zhangsan", external_userid: "external-member" },
  ]) {
    const calls = mockExchange({ identity });
    await assert.rejects(oauth.exchangeWecomCode(oauth.getWecomOAuthConfig(), "unit-test-code"), /WeCom/u);
    assert.equal(calls.length, 2, "An invalid identity must not reach member lookup");
  }
});

test("WeCom requires membership in the application's visible range and an activated matching account", async () => {
  for (const member of [
    { errcode: 60011, errmsg: "no privilege to access this user" },
    { errcode: 0, userid: "another-member", status: 1 },
    { errcode: 0, userid: "zhangsan", status: 2 },
    { errcode: 0, userid: "zhangsan", status: 4 },
    { errcode: 0, userid: "zhangsan", status: 5 },
    { errcode: 0, userid: "zhangsan", status: "1" },
    { errcode: 0, userid: "zhangsan" },
  ]) {
    mockExchange({ member });
    await assert.rejects(oauth.exchangeWecomCode(oauth.getWecomOAuthConfig(), "unit-test-code"), /member access denied/u);
  }
});

test("WeCom exchange rejects malformed and failed API responses without exposing secrets", async () => {
  for (const token of [
    { errcode: 40013, errmsg: "invalid corpid unit-test-app-secret", access_token: "unexpected-token", expires_in: 7200 },
    { errcode: "0", access_token: "unit-test-access-token", expires_in: 7200 },
    { errcode: 0, access_token: "", expires_in: 7200 },
    { errcode: 0, access_token: "invalid token", expires_in: 7200 },
    { errcode: 0, access_token: "unit-test-access-token" },
    { errcode: 0, access_token: "unit-test-access-token", expires_in: -1 },
    new Response("<html>upstream sign-in page</html>", { headers: { "content-type": "text/html" } }),
    json([], 200),
    json({ errcode: 0, access_token: "unit-test-access-token", expires_in: 7200 }, 503),
  ]) {
    const calls = mockExchange({ token });
    await assert.rejects(oauth.exchangeWecomCode(oauth.getWecomOAuthConfig(), "unit-test-code"), { message: "WeCom application token request failed" });
    assert.equal(calls.length, 1);
  }
  const calls = mockExchange({ identity: { errcode: 40029, errmsg: "invalid unit-test-code" } });
  await assert.rejects(oauth.exchangeWecomCode(oauth.getWecomOAuthConfig(), "unit-test-code"), { message: "WeCom authorization code exchange failed" });
  assert.equal(calls.length, 2);
  globalThis.fetch = async (input) => { throw new Error(`network failed for ${String(input)}`); };
  await assert.rejects(oauth.exchangeWecomCode(oauth.getWecomOAuthConfig(), "unit-test-code"), (error) => {
    assert.equal(error.message, "WeCom application token request failed");
    assert.doesNotMatch(error.message, /unit-test-(?:access-token|app-secret)|corpsecret|weixin\.qq/u);
    return true;
  });
});

test("WeCom rejects malformed and oversized codes before requesting an application token", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("Unexpected request"); };
  for (const code of ["", "code with space", "code\n", "a".repeat(513), "码".repeat(171)]) {
    await assert.rejects(oauth.exchangeWecomCode(oauth.getWecomOAuthConfig(), code), /authorization code is invalid/u);
  }
  assert.equal(calls, 0);
});

test("WeCom remains disabled with missing settings or unsafe public origins", () => {
  assert.equal(oauth.isWecomLoginEnabled(), true);
  for (const key of ["WECOM_LOGIN_CORP_ID", "WECOM_LOGIN_AGENT_ID", "WECOM_LOGIN_APP_SECRET", "OA_PUBLIC_ORIGIN"]) {
    const previous = process.env[key];
    delete process.env[key];
    assert.equal(oauth.isWecomLoginEnabled(), false, key);
    assert.throws(() => oauth.getWecomOAuthConfig(), /not configured/u);
    process.env[key] = previous;
  }
  for (const value of ["false", "", "1"]) {
    process.env.WECOM_LOGIN_ENABLED = value;
    assert.equal(oauth.isWecomLoginEnabled(), false);
  }
  process.env.WECOM_LOGIN_ENABLED = "true";
  for (const origin of ["http://oa.example.test", "https://oa.example.test/path", "https://oa.example.test?x=1", "https://oa.example.test#fragment", "https://user:pass@oa.example.test"]) {
    process.env.OA_PUBLIC_ORIGIN = origin;
    assert.equal(oauth.isWecomLoginEnabled(), false, origin);
  }
  process.env.OA_PUBLIC_ORIGIN = "http://localhost:5173";
  assert.equal(oauth.getWecomOAuthConfig().callbackUrl, "http://localhost:5173/api/auth/qr/callback/wecom");
  process.env.WECOM_LOGIN_AGENT_ID = "not-an-agent";
  assert.equal(oauth.isWecomLoginEnabled(), false);
});
