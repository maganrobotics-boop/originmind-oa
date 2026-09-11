import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const originalFetch = globalThis.fetch;
const originalEnvironment = {
  FEISHU_LOGIN_ENABLED: process.env.FEISHU_LOGIN_ENABLED,
  FEISHU_LOGIN_APP_ID: process.env.FEISHU_LOGIN_APP_ID,
  FEISHU_LOGIN_APP_SECRET: process.env.FEISHU_LOGIN_APP_SECRET,
  FEISHU_LOGIN_TENANT_KEY: process.env.FEISHU_LOGIN_TENANT_KEY,
  OA_PUBLIC_ORIGIN: process.env.OA_PUBLIC_ORIGIN,
};

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});

const oauth = await vite.ssrLoadModule("/lib/feishu-oauth.ts");
const accountSubject = await vite.ssrLoadModule("/lib/account-subject.ts");

beforeEach(() => {
  process.env.FEISHU_LOGIN_ENABLED = "true";
  process.env.FEISHU_LOGIN_APP_ID = "cli_originmind_app";
  process.env.FEISHU_LOGIN_APP_SECRET = "test-secret";
  process.env.FEISHU_LOGIN_TENANT_KEY = "tenant_originmind";
  process.env.OA_PUBLIC_ORIGIN = "https://oa.example.test";
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

test("Feishu authorize URL fixes origin, state, and PKCE without requesting email scope", () => {
  const config = oauth.getFeishuOAuthConfig();
  const url = oauth.buildFeishuAuthorizeUrl(config, "state-value", "challenge-value");

  assert.equal(url.origin, "https://accounts.feishu.cn");
  assert.equal(url.pathname, "/open-apis/authen/v1/authorize");
  assert.equal(url.searchParams.get("redirect_uri"), "https://oa.example.test/api/auth/feishu/callback");
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-value");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.has("scope"), false);
  assert.doesNotMatch(url.href, /contact:user\.email:readonly/u);
  assert.doesNotMatch(url.href, /auth:user\.id:read/u);
  assert.doesNotMatch(url.href, /offline_access/u);
});

test("Feishu QR authorize URL uses the official embedded-QR legacy flow", () => {
  const config = oauth.getFeishuOAuthConfig();
  const url = oauth.buildFeishuQrAuthorizeUrl(config, "qr-state-value");

  assert.equal(url.origin, "https://passport.feishu.cn");
  assert.equal(url.pathname, "/suite/passport/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "cli_originmind_app");
  assert.equal(url.searchParams.get("redirect_uri"), "https://oa.example.test/api/auth/feishu/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "qr-state-value");
  assert.equal(url.searchParams.has("code_challenge"), false);
  assert.equal(oauth.feishuOAuthFlowForTransactionVerifier(oauth.feishuQrTransactionVerifier("a".repeat(48))), "qr");
  assert.equal(oauth.feishuOAuthFlowForTransactionVerifier("modern-pkce-verifier"), "modern");
});

test("Feishu identity is app and tenant scoped and yields a supported deterministic account subject", async () => {
  const providerSubject = oauth.feishuProviderSubject("cli_originmind_app", "tenant_originmind", "ou_member_1234");
  assert.equal(providerSubject, "cli_originmind_app:tenant_originmind:ou_member_1234");

  const first = await accountSubject.accountSubjectForFeishu(providerSubject);
  const second = await accountSubject.accountSubjectForFeishu(providerSubject);
  assert.equal(first, second);
  assert.match(first, /^feishu_[0-9a-f]{64}$/u);
  assert.equal(accountSubject.isSupportedAccountSubject(first), true);
  await assert.rejects(() => accountSubject.accountSubjectForFeishu("tenant_originmind:ou_member_1234"), /invalid/u);
  const hyphenated = oauth.feishuProviderSubject("cli_originmind_app", "tenant_originmind", "ou-member-5678");
  assert.match(await accountSubject.accountSubjectForFeishu(hyphenated), /^feishu_[0-9a-f]{64}$/u);
});

test("Feishu code exchange succeeds without email and exposes no email or union identity fields", async () => {
  const requests = [];
  const accessTokenKey = ["access", "token"].join("_");
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (requests.length === 1) return json({ code: 0, [accessTokenKey]: "opaque-test-value" });
    return json({ code: 0, data: { tenant_key: "tenant_originmind", open_id: "ou_member_1234", union_id: "on_union_1234", name: "成员甲" } });
  };

  const identity = await oauth.exchangeFeishuCode(oauth.getFeishuOAuthConfig(), "authorization-code", "pkce-verifier");
  assert.equal(identity.providerSubject, "cli_originmind_app:tenant_originmind:ou_member_1234");
  assert.equal(identity.displayName, "成员甲");
  assert.equal(Object.hasOwn(identity, "verifiedEmail"), false);
  assert.equal(Object.hasOwn(identity, "unionId"), false);
  assert.equal(requests[0].url, "https://open.feishu.cn/open-apis/authen/v2/oauth/token");
  assert.equal(requests[0].init.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    grant_type: "authorization_code",
    client_id: "cli_originmind_app",
    client_secret: "test-secret",
    code: "authorization-code",
    redirect_uri: "https://oa.example.test/api/auth/feishu/callback",
    code_verifier: "pkce-verifier",
  });
  assert.equal(requests[1].init.headers.authorization, "Bearer opaque-test-value");
  assert.doesNotMatch(JSON.stringify(identity), /opaque-test-value/u);
});

test("Feishu code exchange ignores upstream email fields instead of treating them as identity evidence", async () => {
  let calls = 0;
  const accessTokenKey = ["access", "token"].join("_");
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return json({ code: 0, [accessTokenKey]: "opaque-test-value" });
    return json({
      code: 0,
      data: {
        tenant_key: "tenant_originmind",
        open_id: "ou_member_5678",
        union_id: "on_union_5678",
        enterprise_email: "first@example.com",
        email: "different@example.com",
        name: "成员乙",
      },
    });
  };

  const identity = await oauth.exchangeFeishuCode(oauth.getFeishuOAuthConfig(), "authorization-code", "pkce-verifier");
  assert.deepEqual(identity, {
    providerSubject: "cli_originmind_app:tenant_originmind:ou_member_5678",
    openId: "ou_member_5678",
    tenantKey: "tenant_originmind",
    displayName: "成员乙",
  });
  assert.doesNotMatch(JSON.stringify(identity), /example\.com|on_union/u);
});

test("Feishu embedded QR code exchange uses the matching legacy token and user-info endpoints", async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (requests.length === 1) return json({ access_token: "legacy-opaque-value", token_type: "Bearer", expires_in: 3600 });
    return json({ tenant_key: "tenant_originmind", open_id: "ou_member_qr123", union_id: "on_ignored", name: "扫码成员" });
  };

  const identity = await oauth.exchangeFeishuCode(
    oauth.getFeishuOAuthConfig(),
    "qr-authorization-code",
    oauth.feishuQrTransactionVerifier("b".repeat(48)),
    "qr",
  );
  assert.equal(requests[0].url, "https://passport.feishu.cn/suite/passport/oauth/token");
  assert.equal(requests[0].init.headers["content-type"], "application/x-www-form-urlencoded");
  const tokenBody = new URLSearchParams(String(requests[0].init.body));
  assert.equal(tokenBody.get("grant_type"), "authorization_code");
  assert.equal(tokenBody.get("client_id"), "cli_originmind_app");
  assert.equal(tokenBody.get("client_secret"), "test-secret");
  assert.equal(tokenBody.get("code"), "qr-authorization-code");
  assert.equal(tokenBody.get("redirect_uri"), "https://oa.example.test/api/auth/feishu/callback");
  assert.equal(tokenBody.has("code_verifier"), false);
  assert.equal(requests[1].url, "https://passport.feishu.cn/suite/passport/oauth/userinfo");
  assert.equal(requests[1].init.headers.authorization, "Bearer legacy-opaque-value");
  assert.deepEqual(identity, {
    providerSubject: "cli_originmind_app:tenant_originmind:ou_member_qr123",
    openId: "ou_member_qr123",
    tenantKey: "tenant_originmind",
    displayName: "扫码成员",
  });
  assert.doesNotMatch(JSON.stringify(identity), /legacy-opaque-value|on_ignored/u);
});

test("Feishu code exchange rejects another tenant and malformed upstream responses", async () => {
  let calls = 0;
  const accessTokenKey = ["access", "token"].join("_");
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return json({ code: 0, [accessTokenKey]: "opaque-test-value" });
    return json({ code: 0, data: { tenant_key: "tenant_attacker", open_id: "ou_member_1234", enterprise_email: "attacker@example.com" } });
  };
  await assert.rejects(() => oauth.exchangeFeishuCode(oauth.getFeishuOAuthConfig(), "code", "verifier"), /configured organization/u);

  globalThis.fetch = async () => new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } });
  await assert.rejects(() => oauth.exchangeFeishuCode(oauth.getFeishuOAuthConfig(), "code", "verifier"), /unexpected response/u);
});

test("Feishu config rejects production-host drift and incomplete credentials", () => {
  process.env.OA_PUBLIC_ORIGIN = "https://oa.example.test/path";
  assert.equal(oauth.isFeishuLoginEnabled(), false);
  process.env.OA_PUBLIC_ORIGIN = "https://oa.example.test";
  delete process.env.FEISHU_LOGIN_APP_SECRET;
  assert.equal(oauth.isFeishuLoginEnabled(), false);
});
