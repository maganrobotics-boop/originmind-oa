import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaOAuthSessionLogoutTestState";
const sqliteDialect = new SQLiteSyncDialect();

function initialState() {
  return {
    cookies: {},
    cookieWrites: [],
    hashInputs: [],
    deleteCalls: [],
    failDeletion: false,
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
  plugins: [
    {
      name: "oauth-session-logout-test-dependencies",
      enforce: "pre",
      resolveId(source) {
        if (source === "next/headers") return "\0oauth-session-logout-test-headers";
        if (/^(?:\.\.\/)+db$/u.test(source)) return "\0oauth-session-logout-test-db";
        if (/(^|\/)api\/_lib\/auth$/u.test(source) || /(^|\/)_lib\/auth$/u.test(source)) return "\0oauth-session-logout-test-auth";
        return null;
      },
      load(id) {
        if (id === "\0oauth-session-logout-test-headers") {
          return `
            export async function cookies() {
              return {
                get(name) {
                  const value = globalThis.${stateKey}.cookies[name];
                  return typeof value === "string" ? { value } : undefined;
                },
                set(name, value, options) {
                  globalThis.${stateKey}.cookieWrites.push({ name, value, options });
                },
              };
            }
          `;
        }
        if (id === "\0oauth-session-logout-test-auth") {
          return `
            export async function getAuthorizedUser() { return null; }
            export async function getCurrentUser() { return null; }
            export async function hashToken(value) {
              globalThis.${stateKey}.hashInputs.push(value);
              return "hash:" + value;
            }
          `;
        }
        if (id === "\0oauth-session-logout-test-db") {
          return `
            const tableName = (table) => table?.[Symbol.for("drizzle:Name")] || "unknown";
            export async function getDb() {
              return {
                delete(table) {
                  return {
                    async where(predicate) {
                      const state = globalThis.${stateKey};
                      state.deleteCalls.push({ table: tableName(table), predicate });
                      if (state.failDeletion) throw new Error("D1 unavailable");
                    },
                  };
                },
              };
            }
          `;
        }
        return null;
      },
    },
  ],
});

after(async () => {
  delete globalThis[stateKey];
  await vite.close();
});

const sessionRoute = await vite.ssrLoadModule("/app/api/session/route.ts");

function resetState(overrides = {}) {
  globalThis[stateKey] = { ...initialState(), ...overrides };
  return globalThis[stateKey];
}

function oauthCookies() {
  return {
    "__Host-oa_oauth_session": "current-oauth-token",
    "__Host-oa_github_session": "legacy-github-token",
  };
}

function clearedCookieSummary(state) {
  return state.cookieWrites.map(({ name, value, options }) => [name, value, options.maxAge]);
}

function oauthDeletionQuery(state) {
  return sqliteDialect.sqlToQuery(state.deleteCalls[0].predicate);
}

test("注销时同时撤销通用与旧 GitHub OAuth 会话并清除两个 Cookie", async () => {
  const state = resetState({ cookies: oauthCookies() });

  const response = await sessionRoute.DELETE();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(state.hashInputs, ["current-oauth-token", "legacy-github-token"]);
  assert.equal(state.deleteCalls.length, 1);
  assert.equal(state.deleteCalls[0].table, "oauth_sessions");
  assert.equal(oauthDeletionQuery(state).sql, '"oauth_sessions"."token_hash" in (?, ?)');
  assert.deepEqual(oauthDeletionQuery(state).params, [
    "hash:current-oauth-token",
    "hash:legacy-github-token",
  ]);
  assert.deepEqual(clearedCookieSummary(state), [
    ["oa_session", "", 0],
    ["__Host-oa_oauth_session", "", 0],
    ["__Host-oa_github_session", "", 0],
  ]);
});

test("D1 撤销失败时仍清除浏览器中的全部会话 Cookie", async () => {
  const state = resetState({ cookies: oauthCookies(), failDeletion: true });

  const response = await sessionRoute.DELETE();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, serverRevocationPending: true });
  assert.deepEqual(state.hashInputs, ["current-oauth-token", "legacy-github-token"]);
  assert.deepEqual(oauthDeletionQuery(state).params, [
    "hash:current-oauth-token",
    "hash:legacy-github-token",
  ]);
  assert.deepEqual(clearedCookieSummary(state), [
    ["oa_session", "", 0],
    ["__Host-oa_oauth_session", "", 0],
    ["__Host-oa_github_session", "", 0],
  ]);
});
