import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/d1";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const origin = "https://oa.example.test";
const stateKey = "__oaUnifiedQrIntegrationTests";
const contexts = new AsyncLocalStorage();
const previousEnvironment = Object.fromEntries([
  "OA_PUBLIC_ORIGIN", "OA_UNIFIED_QR_LOGIN_ENABLED", "OA_MIGRATION_WRITE_FROZEN",
].map((key) => [key, process.env[key]]));
const previousFetch = globalThis.fetch;
process.env.OA_PUBLIC_ORIGIN = origin;
globalThis.fetch = async () => { throw new Error("Integration tests must not make real network requests"); };

let sqlite;
let batchTail = Promise.resolve();

function d1Adapter(database) {
  function prepare(query, params = []) {
    const execute = () => ({
      success: true,
      results: database.prepare(query).all(...params),
      meta: { changes: Number(database.prepare("SELECT changes() AS n").get().n) },
    });
    return {
      bind(...values) { return prepare(query, values); },
      async all() { return execute(); },
      async run() { return execute(); },
      async first(column) {
        const row = database.prepare(query).get(...params) ?? null;
        return column && row ? row[column] : row;
      },
      async raw() {
        const statement = database.prepare(query);
        statement.setReturnArrays(true);
        return statement.all(...params);
      },
    };
  }
  return {
    prepare,
    batch(statements) {
      const run = async () => {
        const hook = globalThis[stateKey].beforeBatch;
        globalThis[stateKey].beforeBatch = null;
        hook?.();
        database.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.all());
          database.exec("COMMIT");
          return results;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      };
      const result = batchTail.then(run, run);
      batchTail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

globalThis[stateKey] = {
  context: () => contexts.getStore(),
  hash: async (value) => createHash("sha256").update(value).digest("hex"),
};

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  cacheDir: `/tmp/oa-unified-qr-tests-${process.pid}`,
  optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } },
  ssr: { noExternal: ["next"] },
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "unified-qr-integration-fixtures",
    enforce: "pre",
    resolveId(source) {
      if (source === "next/headers") return "\0unified-qr-test-headers";
      if (/^(?:\.\.\/)+db$/u.test(source)) return "\0unified-qr-test-db";
      if (/(^|\/)_lib\/auth$/u.test(source)) return "\0unified-qr-test-auth";
      if (/(^|\/)lib\/feishu-oauth$/u.test(source)) return "\0unified-qr-test-feishu";
      if (/(^|\/)lib\/wecom-oauth$/u.test(source)) return "\0unified-qr-test-wecom";
      if (/(^|\/)lib\/write-rate-limit$/u.test(source)) return "\0unified-qr-test-rate";
      if (/(^|\/)lib\/qr-svg$/u.test(source)) return "\0unified-qr-test-svg";
      return null;
    },
    load(id) {
      const state = `globalThis.${stateKey}`;
      if (id === "\0unified-qr-test-db") return `
        export async function getDb() { return ${state}.db; }
        export async function getD1Database() { return ${state}.d1; }
      `;
      if (id === "\0unified-qr-test-headers") return `
        export async function headers() { return ${state}.context().request.headers; }
        export async function cookies() {
          const ctx = ${state}.context();
          return {
            get(name) { const value = ctx.jar.get(name); return value ? { value } : undefined; },
            set(name, value, options) {
              ctx.writes.push({ name, value, options });
              if (options?.maxAge === 0 || !value) ctx.jar.delete(name);
              else ctx.jar.set(name, value);
            },
            delete(name) { ctx.jar.delete(name); },
          };
        }
      `;
      if (id === "\0unified-qr-test-auth") return `
        import { sql } from "drizzle-orm";
        export async function getAuthorizedUser() { return ${state}.context()?.authorized ?? null; }
        export async function getPlatformUser() { return null; }
        export async function hashToken(value) { return ${state}.hash(value); }
        export function authorizedMemberGuard(actor) {
          return sql\`EXISTS (SELECT 1 FROM members WHERE id=\${actor.memberId}
            AND account_user_id=\${actor.accountUserId}
            AND mutation_revision=\${actor.memberMutationRevision} AND status='active')\`;
        }
      `;
      if (id === "\0unified-qr-test-rate") return `
        export async function consumeWriteRateLimit() { return ${state}.rateAllowed; }
      `;
      if (id === "\0unified-qr-test-svg") return `
        export function generateQrSvg() { return '<svg xmlns="http://www.w3.org/2000/svg"></svg>'; }
      `;
      if (id === "\0unified-qr-test-feishu") return `
        export const FEISHU_PROVIDER = "feishu";
        export const FEISHU_OAUTH_BROWSER_COOKIE = "__Host-oa_feishu_oauth";
        export const FEISHU_OAUTH_TRANSACTION_MAX_AGE_SECONDS = 300;
        export function isFeishuLoginEnabled() { return ${state}.feishuEnabled; }
        export function getFeishuOAuthConfig() {
          if (!isFeishuLoginEnabled()) throw new Error("Feishu login is not configured");
          return { clientId: "cli_unit_test", clientSecret: "unit-test-secret", tenantKey: "tenant_unit_test", origin: "${origin}", callbackUrl: "${origin}/api/auth/feishu/callback" };
        }
        export function buildFeishuAuthorizeUrl(config, state, challenge) {
          const url = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
          url.searchParams.set("state", state);
          url.searchParams.set("redirect_uri", config.callbackUrl);
          url.searchParams.set("code_challenge", challenge);
          return url;
        }
        export function buildFeishuQrAuthorizeUrl() { throw new Error("A mobile scan must not request a second desktop QR code"); }
        export async function exchangeFeishuCode(config, code, verifier) {
          ${state}.exchangeCalls.push({ provider: "feishu", config, code, verifier });
          if (${state}.exchangeError) throw new Error("Unit-test provider failure");
          return ${state}.feishuIdentity;
        }
      `;
      if (id === "\0unified-qr-test-wecom") return `
        export const WECOM_PROVIDER = "wecom";
        export function isWecomLoginEnabled() { return ${state}.wecomEnabled; }
        export function getWecomOAuthConfig() {
          if (!isWecomLoginEnabled()) throw new Error("WeCom login is not configured");
          return { corpId: "ww_unit_test", agentId: "1000002", corpSecret: "unit-test-secret", origin: "${origin}", callbackUrl: "${origin}/api/auth/qr/callback/wecom" };
        }
        export function buildWecomAuthorizeUrl(config, state) {
          const url = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
          url.searchParams.set("state", state);
          url.searchParams.set("redirect_uri", config.callbackUrl);
          return url;
        }
        export async function exchangeWecomCode(config, code) {
          ${state}.exchangeCalls.push({ provider: "wecom", config, code });
          if (${state}.exchangeError) throw new Error("Unit-test provider failure");
          return ${state}.wecomIdentity;
        }
      `;
      return null;
    },
  }],
});

const service = await vite.ssrLoadModule("/app/api/auth/qr/_lib/service.ts");
const { QR_DESKTOP_COOKIE, QR_PHONE_COOKIE } = await vite.ssrLoadModule("/lib/qr-login.ts");
const sessionCookie = "__Host-oa_oauth_session";

after(async () => {
  sqlite?.close();
  await vite.close();
  globalThis.fetch = previousFetch;
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete globalThis[stateKey];
});

beforeEach(() => {
  process.env.OA_UNIFIED_QR_LOGIN_ENABLED = "true";
  process.env.OA_MIGRATION_WRITE_FROZEN = "false";
  sqlite?.close();
  sqlite = new DatabaseSync(":memory:");
  batchTail = Promise.resolve();
  const dir = new URL("../drizzle/", import.meta.url);
  for (const file of readdirSync(dir).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    for (const statement of readFileSync(new URL(file, dir), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  for (const [id, name] of [["member-one", "原有成员"], ["member-two", "另一成员"]]) {
    sqlite.prepare(`INSERT INTO members(id, full_name, chatgpt_account, account_user_id, role,
      permissions_json, nda_accepted_at, nda_approval_id, nda_agreement_version, mutation_revision)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, name, `${id}@example.test`, `email:${id}@example.test`,
      "technical_advisor", '["technical_advisor"]', "2026-09-01T00:00:00.000Z", `nda-${id}`, "TEST-NDA", "member-r1");
  }
  const d1 = d1Adapter(sqlite);
  Object.assign(globalThis[stateKey], {
    db: drizzle(d1), d1, rateAllowed: true, feishuEnabled: true, wecomEnabled: true,
    beforeBatch: null, exchangeError: false, exchangeCalls: [],
    feishuIdentity: { providerSubject: "cli_unit_test:tenant_unit_test:ou_memberone", tenantKey: "tenant_unit_test", openId: "ou_memberone", displayName: "平台显示名" },
    wecomIdentity: { providerSubject: "ww_unit_test:memberone", corpId: "ww_unit_test", userId: "memberone", displayName: "平台显示名" },
  });
  seedIdentity("feishu", globalThis[stateKey].feishuIdentity.providerSubject);
  seedIdentity("wecom", globalThis[stateKey].wecomIdentity.providerSubject);
});

function seedIdentity(provider, subject, memberId = "member-one") {
  sqlite.prepare(`INSERT INTO auth_identities(id, member_id, provider, provider_subject)
    VALUES(?,?,?,?)`).run(`${provider}-${memberId}`, memberId, provider, subject);
}

function authorizedUser(overrides = {}) {
  return {
    user: { email: "member-one@example.test", displayName: "原有成员", authProvider: "feishu" },
    memberId: "member-one", accountUserId: "email:member-one@example.test", memberMutationRevision: "member-r1",
    role: "technical_advisor", isAdmin: false, isFinanceOwner: false, ndaCompleted: true,
    ndaAcceptedAt: "2026-09-01T00:00:00.000Z", ndaApprovalId: "nda-member-one", ndaAgreementVersion: "TEST-NDA", ...overrides,
  };
}

function browser() { return { jar: new Map(), writes: [] }; }

async function invoke(handler, client, path, { method = "GET", data, headers = {}, authorized, args = [] } = {}) {
  const request = new Request(new URL(path, origin), {
    method,
    headers: {
      ...(method !== "GET" ? { origin, "content-type": "application/json" } : {}),
      cookie: [...client.jar].map(([name, value]) => `${name}=${value}`).join("; "),
      ...headers,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const writes = [];
  const response = await contexts.run({ jar: client.jar, writes, request, authorized }, () => handler(request, ...args));
  client.writes.push(...writes);
  return response;
}

const challengeRow = (id) => sqlite.prepare("SELECT * FROM qr_login_challenges WHERE id=?").get(id);
const count = (table) => sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const sessionWrites = (client) => client.writes.filter((write) => write.name === sessionCookie && write.value && write.options?.maxAge !== 0);
const fingerprint = (value) => createHash("sha256").update(value).digest("hex");

async function start(pc, action = "login", authorized) {
  const response = await invoke(service.startQrLogin, pc, "/api/auth/qr/start", {
    method: "POST", data: { action }, authorized, headers: { "user-agent": "Mozilla/5.0 Windows NT 10.0" },
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}

async function scan(phone, id, provider) {
  const response = await invoke(service.scanQrLogin, phone, "/api/auth/qr/scan", { method: "POST", data: { id, provider } });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  const url = new URL(data.authorizeUrl);
  return { url, state: url.searchParams.get("state") };
}

function callback(phone, provider, state, extra = {}) {
  const url = new URL(`/api/auth/qr/callback/${provider}`, origin);
  url.searchParams.set("state", state);
  url.searchParams.set("code", "unit-test-code");
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return invoke(service.qrCallback, phone, url.href, { args: [provider] });
}

function confirm(phone, id, approve = true, headers = {}) {
  return invoke(service.confirmQrLogin, phone, "/api/auth/qr/confirm", { method: "POST", data: { id, approve }, headers });
}

function status(pc, id, authorized, headers = {}) {
  return invoke(service.qrStatus, pc, "/api/auth/qr/status", { method: "POST", data: { id }, authorized, headers });
}

function mobileInfo(phone, id) {
  return invoke(service.mobileQrInfo, phone, `/api/auth/qr/info?id=${id}`);
}

async function verifiedFlow(provider = "feishu", { action = "login", authorized } = {}) {
  const pc = browser();
  const phone = browser();
  const data = await start(pc, action, authorized);
  const oauth = await scan(phone, data.id, provider);
  const response = await callback(phone, provider, oauth.state);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${origin}/auth/qr?id=${data.id}`);
  assert.equal(challengeRow(data.id).status, "verified");
  return { pc, phone, data, oauth };
}

for (const provider of ["feishu", "wecom"]) {
  test(`${provider}: one OA QR needs phone confirmation and only its original computer receives one session`, async () => {
    const beforeMember = sqlite.prepare("SELECT * FROM members WHERE id='member-one'").get();
    const { pc, phone, data, oauth } = await verifiedFlow(provider);
    const scanUrl = new URL(data.scanUrl);
    assert.equal(scanUrl.origin, origin);
    assert.equal(scanUrl.pathname, "/auth/qr");
    assert.equal(scanUrl.searchParams.get("id"), data.id);
    assert.deepEqual([...scanUrl.searchParams.keys()], ["id"]);
    assert.ok(!data.scanUrl.includes(pc.jar.get(QR_DESKTOP_COOKIE)), "The QR must not carry the PC possession secret");
    assert.deepEqual(data.providers, ["feishu", "wecom"]);
    assert.match(data.verificationCode, /^\d{6}$/u);
    assert.equal(data.expiresIn, 300);
    assert.equal(oauth.url.searchParams.get("redirect_uri"), `${origin}/api/auth/qr/callback/${provider}`);
    assert.notEqual(pc.jar.get(QR_DESKTOP_COOKIE), phone.jar.get(QR_PHONE_COOKIE));
    assert.equal(pc.jar.has(QR_PHONE_COOKIE), false);
    assert.equal(phone.jar.has(QR_DESKTOP_COOKIE), false);
    for (const client of [pc, phone]) {
      for (const { options } of client.writes) {
        assert.equal(options.httpOnly, true);
        assert.equal(options.secure, true);
        assert.equal(options.sameSite, "lax");
        assert.equal(options.path, "/");
      }
    }

    const waiting = await status(pc, data.id);
    assert.deepEqual(await waiting.json(), { status: "verified", verificationCode: data.verificationCode });
    assert.equal(count("oauth_sessions"), 0);
    assert.equal(sessionWrites(pc).length, 0);
    const infoResponse = await mobileInfo(phone, data.id);
    const info = await infoResponse.json();
    assert.equal(info.phase, "confirm");
    assert.equal(info.displayName, "原有成员");
    assert.equal(info.linkTargetName, undefined);
    assert.equal(info.linkTargetAccountHint, undefined);
    assert.equal(info.verificationCode, data.verificationCode);
    assert.equal(info.desktopLabel, "Windows 电脑");
    assert.equal(infoResponse.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.equal(infoResponse.headers.get("referrer-policy"), "no-referrer");
    assert.equal((await confirm(phone, data.id)).status, 200);
    assert.equal(sessionWrites(phone).length, 0);
    assert.equal(count("oauth_sessions"), 0);

    const consumed = await status(pc, data.id);
    assert.equal(consumed.status, 200);
    assert.deepEqual(await consumed.json(), { status: "consumed", redirectTo: "/" });
    assert.equal(count("oauth_sessions"), 1);
    assert.equal(sessionWrites(pc).length, 1);
    assert.equal(sessionWrites(phone).length, 0);
    const session = sqlite.prepare("SELECT * FROM oauth_sessions").get();
    assert.equal(session.member_id, "member-one");
    assert.equal(session.provider, provider);
    assert.equal(session.display_name_snapshot, "原有成员");
    assert.equal(session.email_snapshot, "member-one@example.test");
    assert.equal(session.token_hash, fingerprint(pc.jar.get(sessionCookie)));
    assert.deepEqual(sqlite.prepare("SELECT * FROM members WHERE id='member-one'").get(), beforeMember);
    assert.equal(count("auth_identities"), 2);
    assert.equal((await status(pc, data.id)).status, 200);
    assert.equal(count("oauth_sessions"), 1);
    assert.equal(sessionWrites(pc).length, 1);
    assert.equal((await confirm(phone, data.id)).status, 409);
    const strangerInfo = await (await mobileInfo(browser(), data.id)).json();
    assert.equal(strangerInfo.phase, "denied");
    assert.equal(strangerInfo.displayName, undefined);
  });
}

test("a QR URL without the PC nonce never permits status lookup or session consumption", async () => {
  const { pc, phone, data } = await verifiedFlow("wecom");
  const strangers = [browser(), { jar: new Map([[QR_DESKTOP_COOKIE, "x".repeat(43)]]), writes: [] }, phone];
  for (const stranger of strangers) {
    assert.equal((await status(stranger, data.id)).status, 403);
  }
  assert.equal((await confirm(phone, data.id)).status, 200);
  for (const stranger of strangers) assert.equal((await status(stranger, data.id)).status, 403);
  assert.equal(count("oauth_sessions"), 0);
  assert.equal(challengeRow(data.id).status, "approved");
  assert.equal((await status(pc, data.id)).status, 200);
  assert.equal(count("oauth_sessions"), 1);
});

test("OAuth state is pinned to the provider and phone nonce, not to a desktop or a user-agent string", async () => {
  const pc = browser();
  const phone = browser();
  const data = await start(pc);
  const oauth = await scan(phone, data.id, "feishu");
  const strangers = [browser(), pc, { jar: new Map([[QR_PHONE_COOKIE, "z".repeat(43)]]), writes: [] }];
  assert.equal((await callback(phone, "wecom", oauth.state)).status, 303);
  for (const stranger of strangers) assert.equal((await callback(stranger, "feishu", oauth.state)).status, 303);
  assert.equal(globalThis[stateKey].exchangeCalls.length, 0);
  assert.equal(challengeRow(data.id).status, "pending");
  assert.equal(sqlite.prepare("SELECT consumed_at FROM qr_oauth_attempts").get().consumed_at, null);
  const url = `/api/auth/qr/callback/feishu?state=${oauth.state}&code=unit-test-code`;
  const real = await invoke(service.qrCallback, phone, url, { args: ["feishu"], headers: { "user-agent": "Fake WeCom wxwork" } });
  assert.equal(real.status, 303);
  assert.equal(globalThis[stateKey].exchangeCalls.length, 1);
  assert.equal(globalThis[stateKey].exchangeCalls[0].provider, "feishu");
  assert.equal(challengeRow(data.id).provider, "feishu");
  assert.equal((await callback(phone, "feishu", oauth.state)).status, 303);
  assert.equal(globalThis[stateKey].exchangeCalls.length, 1, "An OAuth state cannot be exchanged twice");
  assert.equal((await confirm(strangers[2], data.id)).status, 409);
  assert.equal((await confirm(pc, data.id)).status, 403);
});

test("two phones may authorize but only the first verified identity may confirm the challenge", async () => {
  const pc = browser();
  const phones = [browser(), browser()];
  const data = await start(pc);
  const attempts = await Promise.all(phones.map((phone) => scan(phone, data.id, "feishu")));
  assert.equal(challengeRow(data.id).status, "pending", "Scanning must not lock out another authorization attempt");
  await Promise.all(phones.map((phone, i) => callback(phone, "feishu", attempts[i].state)));
  const row = challengeRow(data.id);
  assert.equal(row.status, "verified");
  const winner = phones.find((phone) => fingerprint(phone.jar.get(QR_PHONE_COOKIE)) === row.scanner_nonce_hash);
  const loser = phones.find((phone) => phone !== winner);
  assert.ok(winner);
  assert.equal((await (await mobileInfo(loser, data.id)).json()).phase, "denied");
  assert.equal((await confirm(loser, data.id)).status, 409);
  assert.equal((await confirm(winner, data.id)).status, 200);
  const results = await Promise.all([status(pc, data.id), status(pc, data.id)]);
  assert.ok(results.some((response) => response.status === 200));
  assert.ok(results.every((response) => [200, 409].includes(response.status)));
  assert.equal(count("oauth_sessions"), 1);
  assert.equal(sessionWrites(pc).length, 1);
});

test("a failed session insert rolls back consumption and leaves no usable cookie", async () => {
  const { pc, phone, data } = await verifiedFlow();
  assert.equal((await confirm(phone, data.id)).status, 200);
  sqlite.exec("CREATE TRIGGER test_session_insert_failure BEFORE INSERT ON oauth_sessions BEGIN SELECT RAISE(ABORT, 'test-only storage failure'); END;");
  assert.equal((await status(pc, data.id)).status, 503);
  const row = challengeRow(data.id);
  assert.equal(row.status, "approved");
  assert.equal(row.consumed_at, null);
  assert.equal(row.receipt_hash, null);
  assert.equal(count("oauth_sessions"), 0);
  assert.equal(sessionWrites(pc).length, 0);
  sqlite.exec("DROP TRIGGER test_session_insert_failure;");
  assert.equal((await status(pc, data.id)).status, 200);
  assert.equal(count("oauth_sessions"), 1);
});

test("member revocation and a revision change at commit time both prevent session creation", async () => {
  const first = await verifiedFlow("wecom");
  await confirm(first.phone, first.data.id);
  sqlite.exec("UPDATE members SET status='departed' WHERE id='member-one'");
  assert.equal((await status(first.pc, first.data.id)).status, 403);
  assert.equal(count("oauth_sessions"), 0);
  sqlite.exec("UPDATE members SET status='active' WHERE id='member-one'");
  const second = await verifiedFlow("wecom");
  await confirm(second.phone, second.data.id);
  globalThis[stateKey].beforeBatch = () => sqlite.exec("UPDATE members SET mutation_revision='member-r2' WHERE id='member-one'");
  assert.equal((await status(second.pc, second.data.id)).status, 409);
  assert.equal(challengeRow(second.data.id).status, "approved");
  assert.equal(count("oauth_sessions"), 0);
  assert.equal(sessionWrites(second.pc).length, 0);
});

test("all QR mutation endpoints enforce exact Origin and reject GET or cross-site requests", async () => {
  const { pc, phone, data } = await verifiedFlow("wecom");
  const cases = [
    [service.startQrLogin, pc, "start", { action: "login" }],
    [service.scanQrLogin, phone, "scan", { id: data.id, provider: "wecom" }],
    [service.confirmQrLogin, phone, "confirm", { id: data.id, approve: true }],
    [service.qrStatus, pc, "status", { id: data.id }],
    [service.cancelQrLogin, pc, "cancel", { id: data.id }],
  ];
  for (const [handler, client, endpoint, body] of cases) {
    for (const headers of [{ origin: "https://attacker.example" }, { origin: "" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }]) {
      const response = await invoke(handler, client, `/api/auth/qr/${endpoint}`, { method: "POST", data: body, headers });
      assert.equal(response.status, 403, `${endpoint}: ${JSON.stringify(headers)}`);
    }
    assert.equal((await invoke(handler, client, `/api/auth/qr/${endpoint}`)).status, 403, `${endpoint}: GET`);
  }
  assert.equal(challengeRow(data.id).status, "verified");
  assert.equal(count("qr_login_challenges"), 1);
  assert.equal(count("qr_oauth_attempts"), 1);
  assert.equal(count("oauth_sessions"), 0);
  assert.equal(sessionWrites(pc).length, 0);
});

test("unbound WeCom identity cannot merge by name or prevent a valid Feishu phone from using the QR", async () => {
  sqlite.exec("DELETE FROM auth_identities WHERE provider='wecom'");
  globalThis[stateKey].wecomIdentity.displayName = "原有成员";
  const pc = browser();
  const phone = browser();
  const data = await start(pc);
  const oauth = await scan(phone, data.id, "wecom");
  await callback(phone, "wecom", oauth.state);
  assert.equal(challengeRow(data.id).status, "pending");
  assert.equal(sqlite.prepare("SELECT failure_reason FROM qr_oauth_attempts WHERE challenge_id=?").get(data.id).failure_reason, "wecom-not-linked");
  const info = await (await mobileInfo(phone, data.id)).json();
  assert.equal(info.phase, "choose");
  assert.equal(info.displayName, undefined);
  assert.match(info.error, /绑定/u);
  assert.equal((await confirm(phone, data.id)).status, 409);
  assert.equal(count("members"), 2);
  assert.equal(count("auth_identities"), 1);
  assert.equal(count("oauth_sessions"), 0);
  assert.equal((await (await status(pc, data.id)).json()).status, "pending");
  const validPhone = browser();
  const validAttempt = await scan(validPhone, data.id, "feishu");
  await callback(validPhone, "feishu", validAttempt.state);
  assert.equal(challengeRow(data.id).status, "verified");
  assert.equal((await confirm(validPhone, data.id)).status, 200);
  assert.equal((await status(pc, data.id)).status, 200);
  assert.equal(count("oauth_sessions"), 1);
  assert.equal(sqlite.prepare("SELECT member_id FROM oauth_sessions").get().member_id, "member-one");
  assert.equal(count("members"), 2);
});

test("a foreign Feishu tenant and a revoked provider identity never reach phone confirmation", async () => {
  globalThis[stateKey].feishuIdentity.tenantKey = "tenant_other_company";
  const pc = browser();
  const phone = browser();
  const first = await start(pc);
  const firstAttempt = await scan(phone, first.id, "feishu");
  await callback(phone, "feishu", firstAttempt.state);
  assert.equal(challengeRow(first.id).status, "pending");
  assert.equal(sqlite.prepare("SELECT failure_reason FROM qr_oauth_attempts WHERE challenge_id=?").get(first.id).failure_reason, "verification-failed");
  assert.equal((await confirm(phone, first.id)).status, 409);
  globalThis[stateKey].feishuIdentity.tenantKey = "tenant_unit_test";
  sqlite.exec("UPDATE auth_identities SET unlinked_at='2026-09-01' WHERE provider='wecom'");
  const second = await start(pc);
  const secondAttempt = await scan(phone, second.id, "wecom");
  await callback(phone, "wecom", secondAttempt.state);
  assert.equal(challengeRow(second.id).status, "pending");
  assert.equal(sqlite.prepare("SELECT failure_reason FROM qr_oauth_attempts WHERE challenge_id=?").get(second.id).failure_reason, "identity-conflict");
  assert.equal((await confirm(phone, second.id)).status, 409);
  assert.equal(count("oauth_sessions"), 0);
});

test("refresh, phone rejection, desktop cancellation and expiry invalidate delayed authorization or consumption", async () => {
  const pc = browser();
  const phone = browser();
  const old = await start(pc);
  const attempt = await scan(phone, old.id, "feishu");
  const replacement = await start(pc);
  assert.notEqual(old.id, replacement.id);
  assert.equal(challengeRow(old.id), undefined);
  await callback(phone, "feishu", attempt.state);
  assert.equal(globalThis[stateKey].exchangeCalls.length, 0);
  assert.equal((await status(pc, old.id)).status, 403);
  const rejected = await verifiedFlow();
  assert.equal((await confirm(rejected.phone, rejected.data.id, false)).status, 200);
  assert.equal((await (await status(rejected.pc, rejected.data.id)).json()).status, "denied");
  const cancelled = await verifiedFlow();
  await confirm(cancelled.phone, cancelled.data.id);
  assert.equal((await invoke(service.cancelQrLogin, cancelled.pc, "/api/auth/qr/cancel", { method: "POST", data: { id: cancelled.data.id } })).status, 200);
  assert.equal((await (await status(cancelled.pc, cancelled.data.id)).json()).status, "denied");
  const expired = await verifiedFlow();
  sqlite.prepare("UPDATE qr_login_challenges SET expires_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", expired.data.id);
  assert.equal((await confirm(expired.phone, expired.data.id)).status, 409);
  assert.equal((await (await status(expired.pc, expired.data.id)).json()).status, "expired");
  assert.equal((await (await mobileInfo(expired.phone, expired.data.id)).json()).phase, "expired");
  assert.equal(count("oauth_sessions"), 0);
});

test("WeCom binding requires an existing admitted PC account and never creates a login session", async () => {
  sqlite.exec("DELETE FROM auth_identities WHERE provider='wecom'");
  const anonymous = browser();
  assert.equal((await invoke(service.startQrLogin, anonymous, "/api/auth/qr/start", { method: "POST", data: { action: "link" } })).status, 401);
  assert.equal((await invoke(service.startQrLogin, anonymous, "/api/auth/qr/start", {
    method: "POST", data: { action: "link" }, authorized: authorizedUser({ ndaCompleted: false }),
  })).status, 401);
  const memberBefore = sqlite.prepare("SELECT * FROM members WHERE id='member-one'").get();
  const auth = authorizedUser();
  const { pc, phone, data } = await verifiedFlow("wecom", { action: "link", authorized: auth });
  assert.deepEqual(data.providers, ["wecom"]);
  await confirm(phone, data.id);
  assert.equal((await status(pc, data.id)).status, 401, "A lost OA login cannot be replaced by possession of a QR cookie");
  assert.equal((await status(pc, data.id, authorizedUser({ memberId: "member-two" }))).status, 401);
  assert.equal(count("auth_identities"), 1);
  const linked = await status(pc, data.id, auth);
  assert.equal(linked.status, 200);
  assert.deepEqual(await linked.json(), { status: "consumed", linked: true });
  assert.equal(count("auth_identities"), 2);
  assert.equal(sqlite.prepare("SELECT member_id FROM auth_identities WHERE provider='wecom'").get().member_id, "member-one");
  assert.equal(sqlite.prepare("SELECT action FROM member_events").get().action, "wecom_identity_linked");
  assert.equal(count("oauth_sessions"), 0);
  assert.equal(sessionWrites(pc).length, 0);
  assert.equal(sessionWrites(phone).length, 0);
  assert.deepEqual(sqlite.prepare("SELECT * FROM members WHERE id='member-one'").get(), memberBefore);
});

test("binding phone confirmation shows its verified source and guarded OA destination only to that phone", async () => {
  sqlite.exec("DELETE FROM auth_identities WHERE provider='wecom'");
  const auth = authorizedUser();
  const pc = browser();
  const phone = browser();
  const data = await start(pc, "link", auth);
  const publicInfo = await (await mobileInfo(browser(), data.id)).json();
  assert.equal(publicInfo.phase, "choose");
  assert.equal(publicInfo.linkTargetName, undefined);
  assert.equal(publicInfo.linkTargetAccountHint, undefined);
  const oauth = await scan(phone, data.id, "wecom");
  const beforeVerification = await (await mobileInfo(phone, data.id)).json();
  assert.equal(beforeVerification.phase, "choose");
  assert.equal(beforeVerification.linkTargetName, undefined);
  assert.equal(beforeVerification.linkTargetAccountHint, undefined);
  await callback(phone, "wecom", oauth.state);
  const denied = await (await mobileInfo(browser(), data.id)).json();
  assert.equal(denied.phase, "denied");
  assert.equal(denied.displayName, undefined);
  assert.equal(denied.linkTargetName, undefined);
  assert.equal(denied.linkTargetAccountHint, undefined);
  const info = await (await mobileInfo(phone, data.id)).json();
  assert.equal(info.phase, "confirm");
  assert.equal(info.action, "link");
  assert.equal(info.displayName, "平台显示名");
  assert.equal(info.linkTargetName, "原有成员");
  assert.equal(info.linkTargetAccountHint, "m***@example.test");
  const serialized = JSON.stringify(info);
  assert.ok(!serialized.includes("member-one@example.test"), "The phone must not receive the full OA email");
  assert.ok(!serialized.includes("member-one"), "The phone must not receive the member ID or account subject");
});

for (const [label, mutation] of [
  ["member revision", "UPDATE members SET mutation_revision='member-r2' WHERE id='member-one'"],
  ["OA account subject", "UPDATE members SET account_user_id='email:changed@example.test' WHERE id='member-one'"],
  ["member status", "UPDATE members SET status='departed' WHERE id='member-one'"],
]) {
  test(`binding phone info hides both identities when the target's ${label} changes`, async () => {
    const { phone, data } = await verifiedFlow("wecom", { action: "link", authorized: authorizedUser() });
    sqlite.exec(mutation);
    const info = await (await mobileInfo(phone, data.id)).json();
    assert.equal(info.phase, "denied");
    assert.match(info.error, /重新发起绑定/u);
    assert.equal(info.displayName, undefined);
    assert.equal(info.linkTargetName, undefined);
    assert.equal(info.linkTargetAccountHint, undefined);
    assert.deepEqual(info.providers, []);
    assert.equal(challengeRow(data.id).status, "verified", "Reading mobile info must not mutate the QR request");
    assert.equal(count("oauth_sessions"), 0);
    assert.equal(count("member_events"), 0);
  });
}

test("binding refuses a changed authorization snapshot and membership changes at database commit", async () => {
  sqlite.exec("DELETE FROM auth_identities WHERE provider='wecom'");
  const auth = authorizedUser();
  const first = await verifiedFlow("wecom", { action: "link", authorized: auth });
  await confirm(first.phone, first.data.id);
  assert.equal((await status(first.pc, first.data.id, authorizedUser({ memberMutationRevision: "member-r2" }))).status, 401);
  globalThis[stateKey].beforeBatch = () => sqlite.exec("UPDATE members SET mutation_revision='member-r2' WHERE id='member-one'");
  assert.equal((await status(first.pc, first.data.id, auth)).status, 409);
  assert.equal(challengeRow(first.data.id).status, "approved");
  assert.equal(count("auth_identities"), 1);
  assert.equal(count("member_events"), 0);
});

test("binding cannot take an identity concurrently linked to another OA member", async () => {
  sqlite.exec("DELETE FROM auth_identities WHERE provider='wecom'");
  const auth = authorizedUser();
  const { pc, phone, data } = await verifiedFlow("wecom", { action: "link", authorized: auth });
  await confirm(phone, data.id);
  seedIdentity("wecom", globalThis[stateKey].wecomIdentity.providerSubject, "member-two");
  assert.equal((await status(pc, data.id, auth)).status, 409);
  assert.equal(sqlite.prepare("SELECT member_id FROM auth_identities WHERE provider='wecom'").get().member_id, "member-two");
  assert.equal(count("member_events"), 0);
  assert.equal(count("oauth_sessions"), 0);
});

test("provider disablement, rate limiting and malformed requests fail closed", async () => {
  const pc = browser();
  const phone = browser();
  globalThis[stateKey].rateAllowed = false;
  assert.equal((await invoke(service.startQrLogin, pc, "/api/auth/qr/start", { method: "POST", data: { action: "login" } })).status, 429);
  assert.equal(count("qr_login_challenges"), 0);
  globalThis[stateKey].rateAllowed = true;
  const data = await start(pc);
  globalThis[stateKey].wecomEnabled = false;
  assert.equal((await invoke(service.scanQrLogin, phone, "/api/auth/qr/scan", { method: "POST", data: { id: data.id, provider: "wecom" } })).status, 503);
  assert.equal(count("qr_oauth_attempts"), 0);
  assert.equal((await invoke(service.startQrLogin, pc, "/api/auth/qr/start", { method: "POST", data: { action: "arbitrary" } })).status, 400);
  assert.equal((await invoke(service.startQrLogin, pc, "/api/auth/qr/start", { method: "POST", data: { action: "login" }, headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await invoke(service.startQrLogin, pc, "/api/auth/qr/start", { method: "POST", data: { action: "login", padding: "x".repeat(2049) } })).status, 413);
  assert.equal((await invoke(service.scanQrLogin, phone, "/api/auth/qr/scan", { method: "POST", data: { id: "short", provider: "feishu" } })).status, 400);
  assert.equal(count("oauth_sessions"), 0);
});
