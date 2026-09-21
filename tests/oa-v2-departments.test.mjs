import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { parseAssignDepartmentInput, parseCreateDepartmentInput } from "../lib/department-contract.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaV2DepartmentTests";
let database;

class Statement {
  constructor(sqlite, query, bindings = []) { this.sqlite = sqlite; this.query = query; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.sqlite, this.query, bindings); }
  execute() {
    const statement = this.sqlite.prepare(this.query);
    if (statement.columns().length) return { success: true, results: statement.all(...this.bindings) };
    const result = statement.run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async all() { return this.execute(); }
  async first() { return this.sqlite.prepare(this.query).get(...this.bindings) || null; }
  async run() { return this.execute(); }
}

function d1(sqlite) {
  return {
    prepare(query) { return new Statement(sqlite, query); },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

globalThis[stateKey] = {};
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "oa-v2-department-test",
    enforce: "pre",
    resolveId(source) {
      if (/\/_lib\/auth$/u.test(source)) return "\0test-oa-v2-department-auth";
      if (/^(?:\.\.\/)+db$/u.test(source)) return "\0test-oa-v2-department-db";
      if (/lib\/write-rate-limit$/u.test(source)) return "\0test-oa-v2-department-rate-limit";
      return null;
    },
    load(id) {
      if (id === "\0test-oa-v2-department-auth") return `
        export async function getAuthorizedUser(){return globalThis.${stateKey}.authorized;}
        export function isNdaAdmittedMember(member){return Boolean(member.accountUserId && member.ndaAcceptedAt && member.ndaAgreementVersion);}`;
      if (id === "\0test-oa-v2-department-db") return `
        export async function getDb(){return globalThis.${stateKey}.db;}
        export async function getD1Database(){return globalThis.${stateKey}.d1;}`;
      if (id === "\0test-oa-v2-department-rate-limit") return `export async function consumeWriteRateLimit(){return globalThis.${stateKey}.rateAllowed;}`;
      return null;
    },
  }],
});

const route = await vite.ssrLoadModule("/app/api/departments/route.ts");
const actor = (isAdmin = true) => ({
  user: { email: "admin@example.test", displayName: "管理员" },
  ndaCompleted: true,
  isAdmin,
  accountUserId: "account-admin",
  memberId: "member-admin",
  memberMutationRevision: "revision-member-admin",
});
const request = (method, value, headers = {}) => new Request("https://oa.example.test/api/departments", {
  method,
  headers: { "content-type": "application/json", origin: "https://oa.example.test", ...headers },
  body: JSON.stringify(value),
});

beforeEach(() => {
  database?.close();
  database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE members(
    id TEXT PRIMARY KEY,chatgpt_account TEXT,account_user_id TEXT,role TEXT,permissions_json TEXT,
    nda_accepted_at TEXT,nda_agreement_version TEXT,mutation_revision TEXT,status TEXT,department_code TEXT DEFAULT ''
  ); CREATE TABLE migration_control(freeze_id TEXT PRIMARY KEY,activated_at TEXT DEFAULT CURRENT_TIMESTAMP,deactivated_at TEXT);`);
  const insert = database.prepare(`INSERT INTO members(id,chatgpt_account,account_user_id,role,permissions_json,nda_accepted_at,nda_agreement_version,mutation_revision,status,department_code)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insert.run("member-admin", "admin@example.test", "account-admin", "project_owner", "[]", "2026-09-21", "NDA-2026-09", "revision-member-admin", "active", "agent_os");
  insert.run("member-a", "member-a@example.test", "account-member-a", "member", "[]", "2026-09-21", "NDA-2026-09", "revision-member-a", "active", "agent_hardware");
  const migration = readFileSync(new URL("../drizzle/0034_lab_oa_v2_foundation.sql", import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) database.exec(statement);
  globalThis[stateKey] = { authorized: actor(), rateAllowed: true, d1: d1(database), db: {} };
});

after(async () => {
  database?.close();
  await vite.close();
  delete globalThis[stateKey];
});

test("lists seeded departments and legacy primary memberships for admitted members", async () => {
  const response = await route.GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.canManage, true);
  assert.equal(body.departments.length, 3);
  assert.deepEqual(body.departments.find((department) => department.code === "agent_os").memberIds, ["member-admin"]);
  assert.deepEqual(body.departments.find((department) => department.code === "agent_hardware").memberIds, ["member-a"]);
  globalThis[stateKey].authorized = actor(false);
  const memberView = await (await route.GET()).json();
  assert.equal(memberView.canManage, false);
  assert.ok(memberView.departments.every((department) => department.memberIds.length === 0));
  globalThis[stateKey].authorized = { ...actor(false), ndaCompleted: false };
  assert.equal((await route.GET()).status, 403);
});

test("only a current same-origin administrator can create a bounded department", async () => {
  const created = await route.POST(request("POST", { code: "robot_learning", name: "机器人学习组", parentId: "department:agent_os" }));
  assert.equal(created.status, 201);
  assert.equal((await created.json()).department.name, "机器人学习组");
  assert.equal(database.prepare("SELECT parent_id FROM departments WHERE code='robot_learning'").get().parent_id, "department:agent_os");

  globalThis[stateKey].authorized = actor(false);
  assert.equal((await route.POST(request("POST", { code: "denied", name: "无权限" }))).status, 403);
  globalThis[stateKey].authorized = actor();
  assert.equal((await route.POST(request("POST", { code: "cross_site", name: "跨站" }, { origin: "https://other.example" }))).status, 403);
  assert.equal((await route.POST(request("POST", { code: "INVALID CODE", name: "错误编码" }))).status, 400);
});

test("primary assignment is atomic and preserves the old department when guards fail", async () => {
  const assigned = await route.PATCH(request("PATCH", {
    action: "assign_primary",
    memberId: "member-a",
    departmentId: "department:agent_application",
    title: "应用负责人",
  }));
  assert.equal(assigned.status, 200);
  assert.equal(database.prepare("SELECT department_id FROM department_memberships WHERE member_id='member-a' AND left_at IS NULL").get().department_id, "department:agent_application");

  const failed = await route.PATCH(request("PATCH", {
    action: "assign_primary",
    memberId: "member-a",
    departmentId: "department:missing",
  }));
  assert.equal(failed.status, 409);
  assert.equal(database.prepare("SELECT department_id FROM department_memberships WHERE member_id='member-a' AND left_at IS NULL").get().department_id, "department:agent_application");
});

test("department contracts reject unknown fields and ambiguous assignments", () => {
  assert.ok(parseCreateDepartmentInput({ code: "robotics", name: "机器人组" }));
  assert.equal(parseCreateDepartmentInput({ code: "robotics", name: "机器人组", isAdmin: true }), null);
  assert.ok(parseAssignDepartmentInput({ action: "assign_primary", memberId: "member-a", departmentId: "department:agent_os" }));
  assert.equal(parseAssignDepartmentInput({ action: "remove", memberId: "member-a", departmentId: "department:agent_os" }), null);
});
