import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaFeishuStartTestState";

function initialState() {
  return {
    batches: [],
    cookieWrites: [],
    dbCalls: 0,
    rateAllowed: true,
  };
}

globalThis[stateKey] = initialState();

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  ssr: { noExternal: ["next"] },
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "feishu-start-test-dependencies",
    enforce: "pre",
    resolveId(source) {
      if (source === "next/headers") return "\0feishu-start-test-headers";
      if (/^(?:\.\.\/)+db$/u.test(source)) return "\0feishu-start-test-db";
      if (/(^|\/)lib\/feishu-oauth$/u.test(source)) return "\0feishu-start-test-oauth";
      if (/(^|\/)lib\/github-oauth$/u.test(source)) return "\0feishu-start-test-helpers";
      if (/(^|\/)lib\/write-rate-limit$/u.test(source)) return "\0feishu-start-test-rate-limit";
      if (/(^|\/)api\/_lib\/auth$/u.test(source) || /(^|\/)_lib\/auth$/u.test(source)) return "\0feishu-start-test-auth";
      return null;
    },
    load(id) {
      if (id === "\0feishu-start-test-headers") return `
        export async function cookies() {
          return { set(name, value, options) { globalThis.${stateKey}.cookieWrites.push({ name, value, options }); } };
        }
      `;
      if (id === "\0feishu-start-test-db") return `
        const tableName = (table) => table?.[Symbol.for("drizzle:Name")] || "unknown";
        const operation = (kind, table, value) => ({ kind, table: tableName(table), value });
        export async function getDb() {
          const state = globalThis.${stateKey};
          state.dbCalls += 1;
          return {
            delete(table) { return { where() { return operation("delete", table, null); } }; },
            insert(table) { return { values(value) { return operation("insert", table, value); } }; },
            async batch(operations) { state.batches.push(operations); return operations.map(() => []); },
          };
        }
      `;
      if (id === "\0feishu-start-test-oauth") return `
        export const FEISHU_OAUTH_BROWSER_COOKIE = "__Host-oa_feishu_oauth";
        export const FEISHU_OAUTH_TRANSACTION_MAX_AGE_SECONDS = 300;
        export const FEISHU_PROVIDER = "feishu";
        export function getFeishuOAuthConfig() {
          return { clientId: "cli_test", origin: "https://oa.example.test", callbackUrl: "https://oa.example.test/api/auth/feishu/callback" };
        }
        export function buildFeishuAuthorizeUrl() { return new URL("https://accounts.feishu.cn/unused"); }
        export function buildFeishuQrAuthorizeUrl(_config, state) {
          const url = new URL("https://passport.feishu.cn/suite/passport/oauth/authorize");
          url.searchParams.set("client_id", "cli_test");
          url.searchParams.set("redirect_uri", "https://oa.example.test/api/auth/feishu/callback");
          url.searchParams.set("state", state);
          return url;
        }
        export function feishuQrTransactionVerifier(nonce) { return "qr_login:" + nonce; }
      `;
      if (id === "\0feishu-start-test-helpers") return `
        export function normalizeReturnPath(value) { return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/"; }
        export function randomBase64Url(size) { return "r".repeat(size + 16); }
        export async function sha256Hex(value) { return "hex:" + value; }
        export async function sha256Base64Url(value) { return "b64:" + value; }
      `;
      if (id === "\0feishu-start-test-rate-limit") return `
        export async function consumeWriteRateLimit() { return globalThis.${stateKey}.rateAllowed; }
      `;
      if (id === "\0feishu-start-test-auth") return `export async function getAuthorizedUser() { return null; }`;
      return null;
    },
  }],
});

const startRoute = await vite.ssrLoadModule("/app/api/auth/feishu/start/route.ts");

after(async () => {
  delete globalThis[stateKey];
  await vite.close();
});

function resetState(overrides = {}) {
  globalThis[stateKey] = { ...initialState(), ...overrides };
  return globalThis[stateKey];
}

function qrRequest(origin = "https://oa.example.test") {
  return new Request("https://oa.example.test/api/auth/feishu/start?mode=qr", {
    method: "POST",
    headers: { origin, "sec-fetch-site": origin === "https://oa.example.test" ? "same-origin" : "cross-site" },
  });
}

function insertedTransaction(state) {
  return state.batches.flat().find((item) => item.kind === "insert" && item.table === "oauth_transactions")?.value;
}

test("same-origin QR start creates a login transaction and returns the embedded Feishu URL", async () => {
  const state = resetState();

  const response = await startRoute.POST(qrRequest());
  const payload = await response.json();
  const authorizeUrl = new URL(payload.authorizeUrl);
  const transaction = insertedTransaction(state);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(authorizeUrl.origin, "https://passport.feishu.cn");
  assert.equal(authorizeUrl.pathname, "/suite/passport/oauth/authorize");
  assert.equal(authorizeUrl.searchParams.get("state"), "r".repeat(48));
  assert.equal(payload.expiresIn, 300);
  assert.equal(transaction.provider, "feishu");
  assert.equal(transaction.action, "login");
  assert.equal(transaction.memberId, null);
  assert.match(transaction.pkceVerifier, /^qr_login:[A-Za-z0-9_-]{32,128}$/u);
  assert.deepEqual(state.cookieWrites.map(({ name, options }) => [name, options.httpOnly, options.secure, options.sameSite]), [
    ["__Host-oa_feishu_oauth", true, true, "lax"],
  ]);
});

test("cross-site QR start is rejected before any database or cookie mutation", async () => {
  const state = resetState();

  const response = await startRoute.POST(qrRequest("https://attacker.example"));

  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /来源无效/u);
  assert.equal(state.dbCalls, 0);
  assert.equal(state.batches.length, 0);
  assert.equal(state.cookieWrites.length, 0);
});
