import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaOAuthSessionCookieCleanupTestState";
const sqliteDialect = new SQLiteSyncDialect();

function initialState() {
  return {
    cookies: {},
    cookieWrites: [],
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
      name: "oauth-session-cookie-cleanup-test-dependencies",
      enforce: "pre",
      resolveId(source) {
        if (source === "next/headers") return "\0oauth-session-cookie-cleanup-test-headers";
        if (/^(?:\.\.\/)+db$/u.test(source)) return "\0oauth-session-cookie-cleanup-test-db";
        return null;
      },
      load(id) {
        if (id === "\0oauth-session-cookie-cleanup-test-headers") {
          return `
            export async function headers() { return new Headers(); }
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
        if (id === "\0oauth-session-cookie-cleanup-test-db") {
          return `
            const tableName = (table) => table?.[Symbol.for("drizzle:Name")] || "unknown";
            export async function getDb() {
              return {
                select() {
                  const builder = {
                    from() { return builder; },
                    where() { return builder; },
                    limit() { return Promise.resolve([]); },
                  };
                  return builder;
                },
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

const auth = await vite.ssrLoadModule("/app/api/_lib/auth.ts");

function resetState(overrides = {}) {
  globalThis[stateKey] = { ...initialState(), ...overrides };
  return globalThis[stateKey];
}

function oauthCookies() {
  return {
    "__Host-oa_oauth_session": "invalid-current-token",
    "__Host-oa_github_session": "invalid-legacy-token",
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clearedCookieSummary(state) {
  return state.cookieWrites.map(({ name, value, options }) => [name, value, options.maxAge]);
}

function oauthDeletionQuery(state) {
  return sqliteDialect.sqlToQuery(state.deleteCalls[0].predicate);
}

test("无效通用会话触发清理时也撤销旧 GitHub Cookie 对应的会话", async () => {
  const state = resetState({ cookies: oauthCookies() });

  assert.equal(await auth.getCurrentUser(), null);

  assert.equal(state.deleteCalls.length, 1);
  assert.equal(state.deleteCalls[0].table, "oauth_sessions");
  assert.equal(oauthDeletionQuery(state).sql, '"oauth_sessions"."token_hash" in (?, ?)');
  assert.deepEqual(oauthDeletionQuery(state).params, [
    sha256("invalid-current-token"),
    sha256("invalid-legacy-token"),
  ]);
  assert.deepEqual(clearedCookieSummary(state), [
    ["__Host-oa_oauth_session", "", 0],
    ["__Host-oa_github_session", "", 0],
  ]);
});

test("无效会话的 D1 清理失败时仍清除新旧 OAuth Cookie", async () => {
  const state = resetState({ cookies: oauthCookies(), failDeletion: true });

  assert.equal(await auth.getCurrentUser(), null);

  assert.deepEqual(oauthDeletionQuery(state).params, [
    sha256("invalid-current-token"),
    sha256("invalid-legacy-token"),
  ]);
  assert.deepEqual(clearedCookieSummary(state), [
    ["__Host-oa_oauth_session", "", 0],
    ["__Host-oa_github_session", "", 0],
  ]);
});

test("只读或 no-touch 认证判定无效 OAuth 会话时不删除会话也不清理 Cookie", async () => {
  for (const authenticate of [
    () => auth.getAuthorizedUser({ readOnly: true }),
    () => auth.getCurrentUser({ noTouch: true }),
  ]) {
    const state = resetState({ cookies: oauthCookies() });

    assert.equal(await authenticate(), null);

    assert.deepEqual(state.deleteCalls, []);
    assert.deepEqual(state.cookieWrites, []);
  }
});
