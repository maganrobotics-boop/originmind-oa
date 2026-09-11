import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";
import { accountEmailForFeishu } from "../lib/account-subject.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaGitHubRegistrationIsolationTestState";
globalThis[stateKey] = {
  selectRows: [],
  batchCalls: 0,
  currentUser: null,
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
      name: "github-registration-isolation-test-dependencies",
      enforce: "pre",
      resolveId(source) {
        if (source === "next/headers") return "\0github-registration-test-headers";
        if (/^(?:\.\.\/)+db$/u.test(source)) return "\0github-registration-test-db";
        if (/(^|\/)api\/_lib\/auth$/u.test(source) || /(^|\/)_lib\/auth$/u.test(source)) return "\0github-registration-test-auth";
        return null;
      },
      load(id) {
        if (id === "\0github-registration-test-headers") {
          return `
            export async function cookies() {
              return {
                get(name) {
                  return name === "__Host-oa_oauth_session" || name === "__Host-oa_github_session" ? { value: "oauth-session-token" } : undefined;
                },
                set() {},
              };
            }
            export async function headers() { return new Headers(); }
          `;
        }
        if (id === "\0github-registration-test-auth") {
          return `
            export async function getCurrentUser() {
              return globalThis.${stateKey}.currentUser;
            }
            export async function hashToken(value) { return "hash:" + value; }
          `;
        }
        if (id === "\0github-registration-test-db") {
          return `
            export async function getDb() {
              function selectBuilder() {
                const builder = {
                  from() { return builder; },
                  where() { return builder; },
                  limit() {
                    return Promise.resolve(globalThis.${stateKey}.selectRows.shift() || []);
                  },
                };
                return builder;
              }
              return {
                select() { return selectBuilder(); },
                batch() {
                  globalThis.${stateKey}.batchCalls += 1;
                  throw new Error("same-email isolation must return before writes");
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

const registerRoute = await vite.ssrLoadModule("/app/api/register/route.ts");

test("未绑定 GitHub 即使验证邮箱相同也不会继承现有成员", async () => {
  globalThis[stateKey] = {
    selectRows: [
      [],
      [{
        id: "existing-member",
        chatgptAccount: "same@example.com",
        accountUserId: "email:same@example.com",
        status: "active",
      }],
      [],
    ],
    batchCalls: 0,
    currentUser: {
      email: "same@example.com",
      displayName: "GitHub User",
      authProvider: "github",
      externalSubject: "583231",
      externalLogin: "octocat",
    },
  };

  const response = await registerRoute.POST(new Request("https://oa.example.test/api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fullName: "测试成员", identityNumber: "" }),
  }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /不会|显式绑定|原 ChatGPT/u);
  assert.equal(globalThis[stateKey].batchCalls, 0);
});

test("未绑定飞书身份不能凭内部账户键继承已有成员", async () => {
  const providerSubject = "cli_originmind_app:tenant_originmind:ou_feishu_1234";
  const internalEmail = await accountEmailForFeishu(providerSubject);
  globalThis[stateKey] = {
    selectRows: [
      [],
      [{
        id: "existing-member",
        chatgptAccount: internalEmail,
        accountUserId: `email:${internalEmail}`,
        status: "active",
      }],
      [],
    ],
    batchCalls: 0,
    currentUser: {
      email: internalEmail,
      displayName: "飞书成员",
      authProvider: "feishu",
      externalSubject: providerSubject,
      externalLogin: "ou_feishu_1234",
    },
  };

  const response = await registerRoute.POST(new Request("https://oa.example.test/api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fullName: "测试成员", identityNumber: "" }),
  }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /不会|显式绑定|原 ChatGPT/u);
  assert.equal(globalThis[stateKey].batchCalls, 0);
});
