import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaProfileNameTestState";

function authorizedUser() {
  return {
    user: { email: "member@example.com", displayName: "旧姓名", authProvider: "feishu" },
    role: "member",
    accountUserId: "email:member@example.com",
    memberId: "member-one",
    memberMutationRevision: "revision-one",
    canReviewMembers: false,
    canGrantMemberPermissions: false,
    isAdmin: false,
    isFinanceOwner: false,
    ndaCompleted: true,
    ndaAcceptedAt: "2026-09-01T00:00:00.000Z",
    ndaApprovalId: "nda-one",
    ndaAgreementVersion: "NDA-2026-09-R2",
  };
}

function initialState() {
  return {
    authorized: authorizedUser(),
    profileRows: [[{ chatgptAccount: "member@example.com", avatarDataUrl: "", profileJson: "{}", lastSeenAt: "2026-09-01T00:00:00.000Z" }]],
    memberRows: [[{ id: "member-one", fullName: "旧姓名", accountUserId: "email:member@example.com", mutationRevision: "revision-one", status: "active", departmentCode: "agent_os" }]],
    batches: [],
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
    name: "profile-name-test-dependencies",
    enforce: "pre",
    resolveId(source) {
      if (/^(?:\.\.\/)+db$/u.test(source)) return "\0profile-name-test-db";
      if (/(^|\/)api\/_lib\/auth$/u.test(source) || /(^|\/)_lib\/auth$/u.test(source)) return "\0profile-name-test-auth";
      return null;
    },
    load(id) {
      if (id === "\0profile-name-test-auth") return `
        import { sql } from "drizzle-orm";
        export async function getAuthorizedUser() { return globalThis.${stateKey}.authorized; }
        export function authorizedMemberGuard() { return sql\`1 = 1\`; }
        export function parseAccountProfile(value) {
          try { return { department: "", position: "", phone: "", bio: "", visibility: { department: false, position: false, phone: false, bio: false }, ...JSON.parse(value || "{}") }; }
          catch { return { department: "", position: "", phone: "", bio: "", visibility: { department: false, position: false, phone: false, bio: false } }; }
        }
      `;
      if (id === "\0profile-name-test-db") return `
        import { sql } from "drizzle-orm";
        const tableName = (table) => table?.[Symbol.for("drizzle:Name")] || "unknown";
        const operation = (kind, table, value) => ({
          kind,
          table: tableName(table),
          value,
          returning() { return { kind, table: tableName(table), value, returnsRows: true }; },
        });
        export async function getDb() {
          const state = globalThis.${stateKey};
          const takeRows = (table) => table === "account_profiles" ? state.profileRows.shift() || [] : table === "members" ? state.memberRows.shift() || [] : [];
          return {
            select() {
              let table = "unknown";
              const builder = {
                from(value) { table = tableName(value); return builder; },
                where() { return builder; },
                limit() { return Promise.resolve(takeRows(table)); },
                getSQL() { return sql\`SELECT 1\`; },
              };
              return builder;
            },
            update(table) { return { set(value) { return { where() { return operation("update", table, value); } }; } }; },
            insert(table) { return { select(value) { return operation("insert", table, value); } }; },
            async batch(operations) {
              state.batches.push(operations);
              return operations.map((operation) => operation.table === "member_events" ? [{ id: 1 }] : operation.table === "members" ? [{ id: "member-one" }] : [{ email: "member@example.com" }]);
            },
          };
        }
      `;
      return null;
    },
  }],
});

const route = await vite.ssrLoadModule("/app/api/profile/route.ts");

after(async () => {
  delete globalThis[stateKey];
  await vite.close();
});

function resetState(overrides = {}) {
  globalThis[stateKey] = { ...initialState(), ...overrides };
  return globalThis[stateKey];
}

function updateRequest(fullName) {
  return new Request("https://oa.example.test/api/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fullName, avatarDataUrl: "", profile: { position: "开发", phone: "", bio: "", visibility: { department: false, position: true, phone: false, bio: false } } }),
  });
}

test("an active member can change their name together with profile settings", async () => {
  const state = resetState();

  const response = await route.PATCH(updateRequest("新姓名"));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.officialName, "新姓名");
  assert.equal(payload.user.displayName, "新姓名");
  assert.equal(payload.profile.position, "开发");
  assert.equal(state.batches.length, 1);
  assert.deepEqual(state.batches[0].map((operation) => [operation.kind, operation.table]), [
    ["update", "members"],
    ["insert", "member_events"],
    ["update", "account_profiles"],
  ]);
  assert.equal(state.batches[0][0].value.fullName, "新姓名");
  assert.notEqual(state.batches[0][0].value.mutationRevision, "revision-one");
});

test("invalid names are rejected and the rename keeps an audit trail without rewriting history", async () => {
  resetState();
  const invalid = await route.PATCH(updateRequest("A"));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /2 至 40/u);

  const source = await readFile(new URL("../app/api/profile/route.ts", import.meta.url), "utf8");
  assert.match(source, /profile_name_changed/u);
  assert.match(source, /历史审批和签署快照保持不变/u);
  assert.match(source, /eq\(members\.mutationRevision, member\.mutationRevision\)/u);
});
