import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaGitHubStartTestState";

function initialState() {
  return {
    platformUser: null,
    authorized: null,
    memberSelectRows: [],
    identitySelectRows: [],
    batches: [],
    cookieWrites: [],
    rateAllowed: true,
    failMemberBatch: false,
    dbCalls: 0,
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
      name: "github-start-test-dependencies",
      enforce: "pre",
      resolveId(source) {
        if (source === "next/headers") return "\0github-start-test-headers";
        if (/^(?:\.\.\/)+db$/u.test(source)) return "\0github-start-test-db";
        if (/(^|\/)lib\/github-oauth$/u.test(source)) return "\0github-start-test-oauth";
        if (/(^|\/)lib\/write-rate-limit$/u.test(source)) return "\0github-start-test-rate-limit";
        if (/(^|\/)api\/_lib\/auth$/u.test(source) || /(^|\/)_lib\/auth$/u.test(source)) return "\0github-start-test-auth";
        return null;
      },
      load(id) {
        if (id === "\0github-start-test-headers") {
          return `
            export async function cookies() {
              return {
                set(name, value, options) {
                  globalThis.${stateKey}.cookieWrites.push({ name, value, options });
                },
              };
            }
          `;
        }
        if (id === "\0github-start-test-auth") {
          return `
            export async function getPlatformUser() {
              return globalThis.${stateKey}.platformUser;
            }
            export async function getAuthorizedUser() {
              return globalThis.${stateKey}.authorized;
            }
          `;
        }
        if (id === "\0github-start-test-rate-limit") {
          return `
            export async function consumeWriteRateLimit() {
              return globalThis.${stateKey}.rateAllowed;
            }
          `;
        }
        if (id === "\0github-start-test-oauth") {
          return `
            export const GITHUB_OAUTH_BROWSER_COOKIE = "__Host-oa_github_oauth";
            export const GITHUB_OAUTH_TRANSACTION_MAX_AGE_SECONDS = 600;
            export const GITHUB_PROVIDER = "github";
            export function getGitHubOAuthConfig() {
              return { origin: "https://oa.example.test" };
            }
            export function normalizeReturnPath(value) {
              return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
            }
            export function randomBase64Url(size) { return "r".repeat(size + 16); }
            export async function sha256Hex(value) { return "hex:" + value; }
            export async function sha256Base64Url(value) { return "b64:" + value; }
            export function buildGitHubAuthorizeUrl(_config, state, challenge) {
              return "https://github.example/authorize?state=" + encodeURIComponent(state) + "&challenge=" + encodeURIComponent(challenge);
            }
          `;
        }
        if (id === "\0github-start-test-db") {
          return `
            const tableName = (table) => table?.[Symbol.for("drizzle:Name")] || "unknown";
            const operation = (kind, table, value) => ({
              kind,
              table: tableName(table),
              value,
              returning() { return { kind, table: tableName(table), value, returnsRows: true }; },
            });
            export async function getDb() {
              const state = globalThis.${stateKey};
              state.dbCalls += 1;
              return {
                select() {
                  let table = "unknown";
                  const builder = {
                    from(value) { table = tableName(value); return builder; },
                    where() { return builder; },
                    limit() {
                      if (table === "members") return Promise.resolve(state.memberSelectRows.shift() || []);
                      if (table === "auth_identities") return Promise.resolve(state.identitySelectRows.shift() || []);
                      return Promise.resolve([]);
                    },
                  };
                  return builder;
                },
                insert(table) {
                  return {
                    values(value) { return operation("insert", table, value); },
                  };
                },
                delete(table) {
                  return { where() { return operation("delete", table, null); } };
                },
                async batch(operations) {
                  const memberInsert = operations.find((item) => item.kind === "insert" && item.table === "members");
                  if (memberInsert) {
                    if (state.failMemberBatch) {
                      state.failMemberBatch = false;
                      throw new Error("simulated concurrent unique constraint");
                    }
                    state.batches.push(operations);
                    const eventInsert = operations.find((item) => item.kind === "insert" && item.table === "member_events");
                    return [
                      [{ id: memberInsert.value.id, mutationRevision: memberInsert.value.mutationRevision }],
                      eventInsert ? [{ id: 1 }] : [],
                    ];
                  }
                  state.batches.push(operations);
                  return operations.map(() => []);
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

const startRoute = await vite.ssrLoadModule("/app/api/auth/github/start/route.ts");

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

function linkRequest(path = "/api/auth/github/start?return_to=%2F") {
  return new Request(`https://oa.example.test${path}`, {
    method: "POST",
    headers: { origin: "https://oa.example.test" },
  });
}

function insertedValue(state, table) {
  return state.batches.flat().find((item) => item.kind === "insert" && item.table === table)?.value;
}

test("已准入普通成员可以发起 GitHub 绑定事务", async () => {
  const state = resetState({
    platformUser: platformUser(),
    authorized: authorizedUser({ isAdmin: false, canReviewMembers: false, canGrantMemberPermissions: false }),
    memberSelectRows: [[{ id: "member-admin", mutationRevision: "revision-admin" }]],
    identitySelectRows: [[]],
  });

  const response = await startRoute.POST(linkRequest());

  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /^https:\/\/github\.example\/authorize\?/u);
  assert.equal(insertedValue(state, "members"), undefined);
  assert.equal(insertedValue(state, "oauth_transactions").memberId, "member-admin");
  assert.deepEqual(state.cookieWrites.map(({ name, options }) => [name, options.httpOnly, options.secure]), [
    ["__Host-oa_github_oauth", true, true],
  ]);
});

test("已完成保密承诺的配置管理员会先原子建立规范成员记录再绑定", async () => {
  const state = resetState({
    platformUser: platformUser(),
    authorized: authorizedUser({ memberId: undefined, memberMutationRevision: undefined }),
    identitySelectRows: [[]],
  });

  const response = await startRoute.POST(linkRequest());
  const member = insertedValue(state, "members");
  const event = insertedValue(state, "member_events");
  const transaction = insertedValue(state, "oauth_transactions");

  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /^https:\/\/github\.example\/authorize\?/u);
  assert.equal(member.chatgptAccount, "admin@example.com");
  assert.equal(member.accountUserId, "email:admin@example.com");
  assert.equal(member.status, "active");
  assert.equal(member.role, "member");
  assert.equal(member.permissionsJson, "[]", "管理员权限仍应只由服务端配置授予");
  assert.equal(member.ndaAcceptedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(member.ndaApprovalId, "nda-admin");
  assert.equal(event.memberId, member.id);
  assert.equal(event.action, "configured_admin_member_materialized");
  assert.equal(transaction.memberId, member.id);
});

test("缺少平台身份时返回 OA 站内状态，不显示裸 JSON 也不写事务", async () => {
  const state = resetState({ authorized: authorizedUser() });

  const response = await startRoute.POST(linkRequest("/api/auth/github/start?return_to=%2Fsettings"));

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://oa.example.test/settings?github=link-not-ready");
  assert.equal(state.batches.length, 0);
  assert.equal(state.cookieWrites.length, 0);
});

test("未完成 NDA 的配置管理员不会被物化或创建 OAuth 事务", async () => {
  const state = resetState({
    platformUser: platformUser(),
    authorized: authorizedUser({
      memberId: undefined,
      memberMutationRevision: undefined,
      ndaCompleted: false,
      ndaAcceptedAt: undefined,
      ndaApprovalId: undefined,
      ndaAgreementVersion: undefined,
    }),
  });

  const response = await startRoute.POST(linkRequest());

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://oa.example.test/?github=link-not-ready");
  assert.equal(state.batches.length, 0);
  assert.equal(state.cookieWrites.length, 0);
});

test("限流发生在配置管理员建档之前", async () => {
  const state = resetState({
    platformUser: platformUser(),
    authorized: authorizedUser({ memberId: undefined, memberMutationRevision: undefined }),
    rateAllowed: false,
  });

  const response = await startRoute.POST(linkRequest());

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://oa.example.test/?github=rate-limited");
  assert.equal(insertedValue(state, "members"), undefined);
  assert.equal(insertedValue(state, "oauth_transactions"), undefined);
});

test("配置管理员只能凭当前项目负责人承诺书建立成员记录", async () => {
  const state = resetState({
    platformUser: platformUser(),
    authorized: authorizedUser({
      memberId: undefined,
      memberMutationRevision: undefined,
      ndaAgreementVersion: "NDA-2026-09",
    }),
  });

  const response = await startRoute.POST(linkRequest());

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://oa.example.test/?github=link-not-ready");
  assert.equal(state.batches.length, 0);
});

test("配置管理员姓名不符合成员记录约束时不会被物化", async () => {
  const state = resetState({
    platformUser: platformUser(),
    authorized: authorizedUser({
      user: { email: "admin@example.com", displayName: "A", authProvider: "chatgpt" },
      memberId: undefined,
      memberMutationRevision: undefined,
    }),
  });

  const response = await startRoute.POST(linkRequest());

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://oa.example.test/?github=link-not-ready");
  assert.equal(state.batches.length, 0);
});

test("配置管理员已有失效或冲突成员锚点时不会另建记录绕过状态", async () => {
  const state = resetState({
    platformUser: platformUser(),
    authorized: authorizedUser(),
    memberSelectRows: [[]],
  });

  const response = await startRoute.POST(linkRequest());

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://oa.example.test/?github=link-not-ready");
  assert.equal(insertedValue(state, "members"), undefined);
  assert.equal(insertedValue(state, "oauth_transactions"), undefined);
});

test("并发建档冲突后只接受字段完全匹配的 active 成员记录", async () => {
  const state = resetState({
    platformUser: platformUser(),
    authorized: authorizedUser({ memberId: undefined, memberMutationRevision: undefined }),
    failMemberBatch: true,
    memberSelectRows: [[{
      id: "member-concurrent",
      mutationRevision: "revision-concurrent",
      ndaAcceptedAt: "2026-09-01T00:00:00.000Z",
      ndaApprovalId: "nda-admin",
      ndaAgreementVersion: "PROJECT-OWNER-PLEDGE-2026-09",
    }]],
    identitySelectRows: [[]],
  });

  const response = await startRoute.POST(linkRequest());

  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /^https:\/\/github\.example\/authorize\?/u);
  assert.equal(insertedValue(state, "oauth_transactions").memberId, "member-concurrent");
});

test("并发冲突行的 NDA 三元组不一致时不会创建 OAuth 事务", async () => {
  const state = resetState({
    platformUser: platformUser(),
    authorized: authorizedUser({ memberId: undefined, memberMutationRevision: undefined }),
    failMemberBatch: true,
    memberSelectRows: [[{
      id: "member-conflict",
      mutationRevision: "revision-conflict",
      ndaAcceptedAt: "2026-08-01T00:00:00.000Z",
      ndaApprovalId: "nda-admin",
      ndaAgreementVersion: "PROJECT-OWNER-PLEDGE-2026-09",
    }]],
  });

  const response = await startRoute.POST(linkRequest());

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://oa.example.test/?github=link-not-ready");
  assert.equal(insertedValue(state, "oauth_transactions"), undefined);
  assert.equal(state.cookieWrites.length, 0);
});

test("跨站 POST 仍被拒绝且不会读取身份或写数据库", async () => {
  const state = resetState({
    platformUser: platformUser(),
    authorized: authorizedUser(),
  });
  const request = new Request("https://oa.example.test/api/auth/github/start", {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  });

  const response = await startRoute.POST(request);

  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /来源无效/u);
  assert.equal(state.dbCalls, 0);
  assert.equal(state.batches.length, 0);
});
