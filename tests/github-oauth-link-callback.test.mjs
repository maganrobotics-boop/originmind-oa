import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaGitHubLinkCallbackTestState";

function initialState() {
  return {
    browserNonce: "n".repeat(43),
    cookieWrites: [],
    transactionRows: [],
    identitySelectRows: [],
    batches: [],
    batchRows: [[{ id: "github-identity" }], [{ id: 1 }]],
    platformUser: null,
    authorized: null,
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
      name: "github-link-callback-test-dependencies",
      enforce: "pre",
      resolveId(source) {
        if (source === "next/headers") return "\0github-link-callback-test-headers";
        if (/^(?:\.\.\/)+db$/u.test(source)) return "\0github-link-callback-test-db";
        if (/(^|\/)lib\/github-oauth$/u.test(source)) return "\0github-link-callback-test-oauth";
        if (/(^|\/)api\/_lib\/auth$/u.test(source) || /(^|\/)_lib\/auth$/u.test(source)) return "\0github-link-callback-test-auth";
        return null;
      },
      load(id) {
        if (id === "\0github-link-callback-test-headers") {
          return `
            export async function cookies() {
              return {
                get(name) {
                  if (name !== "__Host-oa_github_oauth") return undefined;
                  const value = globalThis.${stateKey}.browserNonce;
                  return value ? { value } : undefined;
                },
                set(name, value, options) {
                  globalThis.${stateKey}.cookieWrites.push({ name, value, options });
                },
              };
            }
          `;
        }
        if (id === "\0github-link-callback-test-auth") {
          return `
            export async function getPlatformUser() { return globalThis.${stateKey}.platformUser; }
            export async function getAuthorizedUser() { return globalThis.${stateKey}.authorized; }
            export async function hashToken(value) { return "hash:" + value; }
          `;
        }
        if (id === "\0github-link-callback-test-oauth") {
          return `
            export const GITHUB_OAUTH_BROWSER_COOKIE = "__Host-oa_github_oauth";
            export const GITHUB_PROVIDER = "github";
            export const GITHUB_SESSION_COOKIE = "__Host-oa_github_session";
            export const GITHUB_SESSION_MAX_AGE_SECONDS = 43200;
            export function getGitHubOAuthConfig() { return { origin: "https://oa.example.test" }; }
            export async function sha256Hex(value) { return "hash:" + value; }
            export async function exchangeGitHubCode() {
              return {
                providerSubject: "583231",
                login: "octocat",
                verifiedEmail: "octocat@example.com",
                displayName: "Octo Cat",
              };
            }
          `;
        }
        if (id === "\0github-link-callback-test-db") {
          return `
            const tableName = (table) => table?.[Symbol.for("drizzle:Name")] || "unknown";
            export async function getDb() {
              const state = globalThis.${stateKey};
              return {
                update() {
                  const builder = {
                    set() { return builder; },
                    where() { return builder; },
                    returning() { return Promise.resolve(state.transactionRows.shift() || []); },
                  };
                  return builder;
                },
                select() {
                  let table = "unknown";
                  const builder = {
                    from(value) { table = tableName(value); return builder; },
                    where() { return builder; },
                    limit() {
                      if (table === "auth_identities") return Promise.resolve(state.identitySelectRows.shift() || []);
                      return Promise.resolve([]);
                    },
                  };
                  return builder;
                },
                insert(table) {
                  return {
                    select() {
                      return {
                        returning() { return { kind: "insert-select", table: tableName(table) }; },
                      };
                    },
                    values(value) {
                      return { kind: "insert-values", table: tableName(table), value };
                    },
                  };
                },
                async batch(operations) {
                  state.batches.push(operations);
                  return state.batchRows;
                },
                delete(table) {
                  return { where() { return { kind: "delete", table: tableName(table) }; } };
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

const callbackRoute = await vite.ssrLoadModule("/app/api/auth/github/callback/route.ts");

function resetState(overrides = {}) {
  globalThis[stateKey] = { ...initialState(), ...overrides };
  return globalThis[stateKey];
}

function platformUser() {
  return {
    email: "admin@example.com",
    displayName: "OA 管理员",
    accountUserId: "email:admin@example.com",
    authProvider: "chatgpt",
  };
}

function authorizedUser(overrides = {}) {
  return {
    user: { email: "admin@example.com", displayName: "OA 管理员", authProvider: "chatgpt" },
    role: "project_owner",
    accountUserId: "email:admin@example.com",
    memberId: "member-admin",
    memberMutationRevision: "revision-admin",
    canReviewMembers: true,
    canGrantMemberPermissions: true,
    isAdmin: true,
    isFinanceOwner: true,
    ndaCompleted: true,
    ndaAcceptedAt: "2026-09-01T00:00:00.000Z",
    ndaApprovalId: "nda-admin",
    ndaAgreementVersion: "PROJECT-OWNER-PLEDGE-2026-09",
    ...overrides,
  };
}

function callbackRequest() {
  return new Request(`https://oa.example.test/api/auth/github/callback?code=oauth-code&state=${"s".repeat(43)}`);
}

test("物化后的配置管理员可以完成 GitHub 身份绑定并写审计", async () => {
  const state = resetState({
    platformUser: platformUser(),
    authorized: authorizedUser(),
    transactionRows: [[{
      action: "link",
      memberId: "member-admin",
      returnPath: "/",
      pkceVerifier: "verifier",
    }]],
    identitySelectRows: [[], []],
  });

  const response = await callbackRoute.GET(callbackRequest());

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://oa.example.test/?github=linked");
  assert.deepEqual(state.batches[0].map((item) => item.table), ["auth_identities", "member_events"]);
  assert.deepEqual(state.cookieWrites.map(({ name, value, options }) => [name, value, options.maxAge]), [
    ["__Host-oa_github_oauth", "", 0],
  ]);
});

test("回调时 NDA 精确归档时间缺失会失败关闭", async () => {
  const state = resetState({
    platformUser: platformUser(),
    authorized: authorizedUser({ ndaAcceptedAt: undefined }),
    transactionRows: [[{
      action: "link",
      memberId: "member-admin",
      returnPath: "/settings",
      pkceVerifier: "verifier",
    }]],
  });

  const response = await callbackRoute.GET(callbackRequest());

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://oa.example.test/settings?github=link-session-expired");
  assert.equal(state.batches.length, 0);
});
