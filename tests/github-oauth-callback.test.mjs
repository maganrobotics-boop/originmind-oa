import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaGitHubCallbackTestState";
globalThis[stateKey] = {
  browserNonce: "",
  cookieWrites: [],
  claimCalls: 0,
  transactionRows: [],
};

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  ssr: { noExternal: ["next"] },
  server: { middlewareMode: true, hmr: false },
  plugins: [
    {
      name: "github-callback-test-dependencies",
      enforce: "pre",
      resolveId(source) {
        if (source === "next/headers") return "\0github-callback-test-headers";
        if (/^(?:\.\.\/)+db$/u.test(source)) return "\0github-callback-test-db";
        if (/(^|\/)lib\/github-oauth$/u.test(source)) return "\0github-callback-test-oauth";
        if (/(^|\/)api\/_lib\/auth$/u.test(source) || /(^|\/)_lib\/auth$/u.test(source)) return "\0github-callback-test-auth";
        return null;
      },
      load(id) {
        if (id === "\0github-callback-test-headers") {
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
            export async function headers() { return new Headers(); }
          `;
        }
        if (id === "\0github-callback-test-db") {
          return `
            export async function getDb() {
              return {
                update() {
                  return {
                    set() {
                      return {
                        where() {
                          return {
                            returning() {
                              const state = globalThis.${stateKey};
                              state.claimCalls += 1;
                              return Promise.resolve(state.transactionRows.shift() || []);
                            },
                          };
                        },
                      };
                    },
                  };
                },
              };
            }
          `;
        }
        if (id === "\0github-callback-test-oauth") {
          return `
            export const GITHUB_OAUTH_BROWSER_COOKIE = "__Host-oa_github_oauth";
            export const GITHUB_PROVIDER = "github";
            export const GITHUB_SESSION_COOKIE = "__Host-oa_github_session";
            export const GITHUB_SESSION_MAX_AGE_SECONDS = 43200;
            export function getGitHubOAuthConfig() {
              return {
                clientId: "client-id",
                clientSecret: "client-secret",
                origin: "https://oa.example.test",
                callbackUrl: "https://oa.example.test/api/auth/github/callback",
              };
            }
            export async function sha256Hex(value) { return "hash:" + value; }
            export async function exchangeGitHubCode() { throw new Error("not reached in denial tests"); }
          `;
        }
        if (id === "\0github-callback-test-auth") {
          return `
            export async function getAuthorizedUser() { return null; }
            export async function getPlatformUser() { return null; }
            export async function hashToken(value) { return "hash:" + value; }
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

function resetState({ nonce = "n".repeat(43), transactions = [] } = {}) {
  globalThis[stateKey] = {
    browserNonce: nonce,
    cookieWrites: [],
    claimCalls: 0,
    transactionRows: [...transactions],
  };
}

function deniedRequest(state = "s".repeat(43)) {
  return new Request(`https://oa.example.test/api/auth/github/callback?error=access_denied&state=${state}`);
}

test("GitHub 拒绝回调也必须匹配并一次性消费 state 与浏览器 nonce", async () => {
  const transaction = {
    action: "login",
    memberId: null,
    returnPath: "/settings?tab=login",
    pkceVerifier: "verifier",
  };
  resetState({ transactions: [[transaction]] });

  const first = await callbackRoute.GET(deniedRequest());
  assert.equal(first.status, 303);
  assert.equal(first.headers.get("location"), "https://oa.example.test/settings?tab=login&github=denied");
  assert.equal(first.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(globalThis[stateKey].claimCalls, 1);
  assert.deepEqual(
    globalThis[stateKey].cookieWrites.map(({ name, value, options }) => [name, value, options.maxAge]),
    [["__Host-oa_github_oauth", "", 0]],
  );

  globalThis[stateKey].browserNonce = "n".repeat(43);
  const replay = await callbackRoute.GET(deniedRequest());
  assert.equal(replay.status, 303);
  assert.equal(replay.headers.get("location"), "https://oa.example.test/?github=failed");
  assert.equal(globalThis[stateKey].claimCalls, 2);
});

test("GitHub 拒绝回调在 nonce 缺失时不查询或消费事务", async () => {
  resetState({ nonce: "short", transactions: [[{
    action: "login",
    memberId: null,
    returnPath: "/settings",
    pkceVerifier: "verifier",
  }]] });

  const response = await callbackRoute.GET(deniedRequest());
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://oa.example.test/?github=failed");
  assert.equal(globalThis[stateKey].claimCalls, 0);
});
