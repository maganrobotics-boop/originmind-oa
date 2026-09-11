import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaMemberApiAccessTestState";
globalThis[stateKey] = { authorized: null, db: null, dbCalls: 0 };

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
  plugins: [
    {
      name: "member-api-access-test-dependencies",
      enforce: "pre",
      resolveId(source) {
        if (/(^|\/)api\/_lib\/auth$/.test(source) || /(^|\/)_lib\/auth$/.test(source)) return "\0member-api-test-auth";
        if (/^(?:\.\.\/)+db$/.test(source)) return "\0member-api-test-db";
        return null;
      },
      load(id) {
        if (id === "\0member-api-test-auth") {
          return `
            export async function getAuthorizedUser() {
              return globalThis.${stateKey}.authorized;
            }
            export function parseMemberPermissions() { return []; }
            export function authorizedMemberGuard() { return undefined; }
            export function isAdministrator() { return false; }
          `;
        }
        if (id === "\0member-api-test-db") {
          return `
            export async function getDb() {
              const state = globalThis.${stateKey};
              state.dbCalls += 1;
              return state.db;
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

const memberListRoute = await vite.ssrLoadModule("/app/api/members/route.ts");
const memberDetailRoute = await vite.ssrLoadModule("/app/api/members/[id]/route.ts");

function authorizedActor(overrides = {}) {
  return {
    user: { email: "member@example.com", displayName: "测试成员" },
    role: "member",
    accountUserId: "account-member",
    memberId: "member-actor",
    memberMutationRevision: "revision-member",
    canReviewMembers: false,
    canGrantMemberPermissions: false,
    isAdmin: false,
    isFinanceOwner: false,
    ndaCompleted: true,
    ...overrides,
  };
}

function createReadDb({ listRows = [], lookupRows = [] } = {}) {
  return {
    select() {
      return {
        from() {
          return {
            orderBy() {
              return Promise.resolve(listRows);
            },
            where() {
              return {
                limit() {
                  return Promise.resolve(lookupRows);
                },
              };
            },
          };
        },
      };
    },
  };
}

function patchRequest() {
  return new Request("https://oa.example.test/api/members/member-target", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve", departmentCode: "agent_os" }),
  });
}

function deleteRequest() {
  return new Request("https://oa.example.test/api/members/member-target", { method: "DELETE" });
}

async function assertAdminOnlyResponse(response, label) {
  assert.equal(response.status, 403, label);
  const body = await response.json();
  assert.match(body.error, /只有 OA 管理员本人/);
}

test("成员注册 API 只允许 OA 管理员并在拒绝时不访问数据库", async (t) => {
  const deniedActors = [
    ["未登录用户", null],
    ["项目负责人", authorizedActor({ role: "project_owner", canReviewMembers: true })],
    ["技术顾问", authorizedActor({ role: "technical_advisor", canReviewMembers: true })],
    ["经费负责人", authorizedActor({ role: "finance_owner", isFinanceOwner: true })],
    ["普通成员", authorizedActor()],
  ];

  for (const [label, actor] of deniedActors) {
    await t.test(`${label}无法读取或修改成员注册`, async () => {
      const state = globalThis[stateKey];
      state.authorized = actor;
      state.db = null;

      state.dbCalls = 0;
      await assertAdminOnlyResponse(await memberListRoute.GET(), `${label}的 GET 应返回 403`);
      assert.equal(state.dbCalls, 0, `${label}的 GET 不应访问数据库`);

      state.dbCalls = 0;
      await assertAdminOnlyResponse(
        await memberDetailRoute.PATCH(patchRequest(), { params: Promise.resolve({ id: "member-target" }) }),
        `${label}的 PATCH 应返回 403`,
      );
      assert.equal(state.dbCalls, 0, `${label}的 PATCH 不应访问数据库`);

      state.dbCalls = 0;
      await assertAdminOnlyResponse(
        await memberDetailRoute.DELETE(deleteRequest(), { params: Promise.resolve({ id: "member-target" }) }),
        `${label}的 DELETE 应返回 403`,
      );
      assert.equal(state.dbCalls, 0, `${label}的 DELETE 不应访问数据库`);
    });
  }

  await t.test("管理员能够进入三个接口的后续处理", async () => {
    const state = globalThis[stateKey];
    state.authorized = authorizedActor({
      user: { email: "admin@example.com", displayName: "OA 管理员" },
      role: "project_owner",
      accountUserId: "account-admin",
      memberId: "member-admin",
      memberMutationRevision: "revision-admin",
      canReviewMembers: true,
      canGrantMemberPermissions: true,
      isAdmin: true,
      isFinanceOwner: true,
    });

    state.dbCalls = 0;
    state.db = createReadDb({
      listRows: [
        {
          id: "member-pending",
          fullName: "待审核成员",
          identityNumber: "20260001",
          chatgptAccount: "pending@example.com",
          status: "pending",
          createdAt: "2026-09-01T00:00:00.000Z",
          departmentCode: "agent_os",
          role: "member",
          permissionsJson: "[]",
          accountBindingPreviousStatus: null,
          pendingFullName: null,
          pendingIdentityNumber: null,
        },
      ],
    });
    const listResponse = await memberListRoute.GET();
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.equal(listBody.pendingCount, 1);
    assert.equal(listBody.members[0].id, "member-pending");
    assert.equal(state.dbCalls, 1);

    state.dbCalls = 0;
    state.db = null;
    const patchResponse = await memberDetailRoute.PATCH(
      new Request("https://oa.example.test/api/members/member-target", {
        method: "PATCH",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
      { params: Promise.resolve({ id: "member-target" }) },
    );
    assert.equal(patchResponse.status, 415, "管理员应通过权限门并进入请求格式校验");
    assert.equal(state.dbCalls, 0);

    state.dbCalls = 0;
    state.db = createReadDb({ lookupRows: [] });
    const deleteResponse = await memberDetailRoute.DELETE(deleteRequest(), {
      params: Promise.resolve({ id: "missing-member" }),
    });
    assert.equal(deleteResponse.status, 404, "管理员应通过权限门并进入成员查询");
    assert.equal(state.dbCalls, 1);
  });
});
