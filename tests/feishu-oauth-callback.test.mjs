import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaFeishuCallbackTestState";
globalThis[stateKey] = { browserNonce: "", cookieWrites: [], claimCalls: 0, transactionRows: [] };

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  ssr: { noExternal: ["next"] },
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "feishu-callback-test-dependencies",
    enforce: "pre",
    resolveId(source) {
      if (source === "next/headers") return "\0feishu-callback-test-headers";
      if (/^(?:\.\.\/)+db$/u.test(source)) return "\0feishu-callback-test-db";
      if (/(^|\/)lib\/feishu-oauth$/u.test(source)) return "\0feishu-callback-test-oauth";
      if (/(^|\/)lib\/github-oauth$/u.test(source)) return "\0feishu-callback-test-hash";
      if (/(^|\/)api\/_lib\/auth$/u.test(source) || /(^|\/)_lib\/auth$/u.test(source)) return "\0feishu-callback-test-auth";
      return null;
    },
    load(id) {
      if (id === "\0feishu-callback-test-headers") return `
        export async function cookies() {
          return {
            get(name) {
              if (name !== "__Host-oa_feishu_oauth") return undefined;
              const value = globalThis.${stateKey}.browserNonce;
              return value ? { value } : undefined;
            },
            set(name, value, options) { globalThis.${stateKey}.cookieWrites.push({ name, value, options }); },
          };
        }
      `;
      if (id === "\0feishu-callback-test-db") return `
        export async function getDb() {
          return {
            update() { return { set() { return { where() { return { returning() {
              const state = globalThis.${stateKey};
              state.claimCalls += 1;
              return Promise.resolve(state.transactionRows.shift() || []);
            } }; } }; } }; },
          };
        }
      `;
      if (id === "\0feishu-callback-test-oauth") return `
        export const FEISHU_OAUTH_BROWSER_COOKIE = "__Host-oa_feishu_oauth";
        export const FEISHU_PROVIDER = "feishu";
        export function getFeishuOAuthConfig() { return { origin: "https://oa.example.test" }; }
        export async function exchangeFeishuCode() { throw new Error("not reached in denial tests"); }
      `;
      if (id === "\0feishu-callback-test-hash") return `export async function sha256Hex(value) { return "hash:" + value; }`;
      if (id === "\0feishu-callback-test-auth") return `
        export async function getAuthorizedUser() { return null; }
        export async function getPlatformUser() { return null; }
        export async function hashToken(value) { return "hash:" + value; }
      `;
      return null;
    },
  }],
});

const callbackRoute = await vite.ssrLoadModule("/app/api/auth/feishu/callback/route.ts");

after(async () => {
  delete globalThis[stateKey];
  await vite.close();
});

function reset(transactions = [], nonce = "n".repeat(43)) {
  globalThis[stateKey] = { browserNonce: nonce, cookieWrites: [], claimCalls: 0, transactionRows: [...transactions] };
}

test("Feishu denial consumes a matching state once and clears the browser nonce", async () => {
  const transaction = { action: "login", memberId: null, returnPath: "/settings?tab=login", pkceVerifier: "verifier" };
  reset([[transaction]]);
  const request = new Request(`https://oa.example.test/api/auth/feishu/callback?error=access_denied&state=${"s".repeat(43)}`);

  const first = await callbackRoute.GET(request);
  assert.equal(first.status, 303);
  assert.equal(first.headers.get("location"), "https://oa.example.test/settings?tab=login&feishu=denied");
  assert.equal(first.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(globalThis[stateKey].claimCalls, 1);
  assert.deepEqual(globalThis[stateKey].cookieWrites.map(({ name, value, options }) => [name, value, options.maxAge]), [["__Host-oa_feishu_oauth", "", 0]]);

  reset([], "n".repeat(43));
  const replay = await callbackRoute.GET(request);
  assert.equal(replay.headers.get("location"), "https://oa.example.test/?feishu=failed");
});

test("GitHub and Feishu callbacks pin transactions to their own provider", async () => {
  const [githubSource, feishuSource] = await Promise.all([
    readFile(new URL("../app/api/auth/github/callback/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/feishu/callback/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(githubSource, /eq\(oauthTransactions\.provider, GITHUB_PROVIDER\)/u);
  assert.match(feishuSource, /eq\(oauthTransactions\.provider, FEISHU_PROVIDER\)/u);
});

test("Feishu callback links by exact member and provider subject without email or name matching", async () => {
  const source = await readFile(new URL("../app/api/auth/feishu/callback/route.ts", import.meta.url), "utf8");
  assert.match(source, /authorized\.memberId !== transaction\.memberId/u);
  assert.match(source, /eq\(authIdentities\.providerSubject, feishuIdentity\.providerSubject\)/u);
  assert.match(source, /eq\(authIdentities\.memberId, authorized\.memberId\)/u);
  assert.match(source, /from\(members\)\.where\(eq\(members\.id, identity\.memberId\)\)/u);
  assert.match(source, /accountEmailForFeishu\(feishuIdentity\.providerSubject\)/u);
  assert.doesNotMatch(source, /feishuIdentity\.(?:email|unionId|userId)/u);
  assert.match(source, /verifiedEmailSnapshot:\s*sql<string>`''`/u);
});
