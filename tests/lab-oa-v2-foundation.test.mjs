import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const migrationDirectory = new URL("../drizzle/", import.meta.url);
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .sort();

function applyMigrations() {
  const database = new DatabaseSync(":memory:");
  for (const name of migrationFiles) {
    const migration = readFileSync(new URL(name, migrationDirectory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      database.exec(statement);
    }
  }
  return database;
}

const v2Tables = [
  "conversation_events",
  "conversation_members",
  "conversation_messages",
  "conversations",
  "department_memberships",
  "departments",
  "project_links",
  "project_members",
  "projects",
];

test("V2 foundation creates only additive organization, project, and conversation tables", () => {
  const database = applyMigrations();
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
  for (const table of v2Tables) assert.ok(tables.includes(table), `${table} must exist`);
  assert.ok(tables.includes("direct_messages"), "legacy direct messages remain available during compatibility migration");
  assert.ok(tables.includes("approvals"), "existing approval evidence remains available");
  assert.deepEqual(
    database.prepare("SELECT code,name FROM departments WHERE created_by_member_id='migration:0034' ORDER BY sort_order").all()
      .map(({ code, name }) => ({ code, name })),
    [
      { code: "agent_hardware", name: "Agent Hardware" },
      { code: "agent_os", name: "Agent OS" },
      { code: "agent_application", name: "Agent Application" },
    ],
  );
  database.close();
});

test("every V2 business table participates in the existing migration write freeze", () => {
  const database = applyMigrations();
  const triggerNames = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((row) => row.name));
  for (const table of v2Tables) {
    for (const operation of ["insert", "update", "delete"]) {
      assert.ok(triggerNames.has(`${table}_migration_freeze_${operation}`), `${table} ${operation} must be fenced`);
    }
  }

  database.prepare("INSERT INTO migration_control (freeze_id) VALUES (?)").run("11111111-2222-4333-8444-555555555555");
  assert.throws(
    () => database.prepare("INSERT INTO projects (id, project_key, name, owner_member_id, created_by_member_id) VALUES (?, ?, ?, ?, ?)")
      .run("project-1", "originmind-arts", "联合研发项目", "member-owner", "member-owner"),
    /migration write freeze active/u,
  );
  database.prepare("UPDATE migration_control SET deactivated_at=CURRENT_TIMESTAMP WHERE freeze_id=?")
    .run("11111111-2222-4333-8444-555555555555");
  assert.equal(database.prepare("INSERT INTO projects (id, project_key, name, owner_member_id, created_by_member_id) VALUES (?, ?, ?, ?, ?)")
    .run("project-1", "originmind-arts", "联合研发项目", "member-owner", "member-owner").changes, 1);
  database.close();
});

test("conversation and membership constraints reject ambiguous access state", () => {
  const database = applyMigrations();
  assert.throws(
    () => database.prepare("INSERT INTO conversations (id, type, created_by_member_id) VALUES (?, 'direct', ?)").run("direct-1", "member-a"),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => database.prepare("INSERT INTO conversations (id, type, direct_key, created_by_member_id) VALUES (?, 'group', ?, ?)").run("group-1", "a|b", "member-a"),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => database.prepare("INSERT INTO conversations (id, type, created_by_member_id) VALUES (?, 'project', ?)").run("project-chat-1", "member-a"),
    /CHECK constraint failed/u,
  );

  database.prepare("INSERT INTO departments (id, code, name, created_by_member_id) VALUES (?, ?, ?, ?)")
    .run("department-1", "robotics", "机器人组", "member-owner");
  database.prepare("INSERT INTO departments (id, code, name, created_by_member_id) VALUES (?, ?, ?, ?)")
    .run("department-2", "ai", "人工智能组", "member-owner");
  database.prepare("INSERT INTO department_memberships (id, department_id, member_id, membership_type, created_by_member_id) VALUES (?, ?, ?, 'primary', ?)")
    .run("membership-1", "department-1", "member-a", "member-owner");
  assert.throws(
    () => database.prepare("INSERT INTO department_memberships (id, department_id, member_id, membership_type, created_by_member_id) VALUES (?, ?, ?, 'primary', ?)")
      .run("membership-2", "department-2", "member-a", "member-owner"),
    /UNIQUE constraint failed/u,
  );
  database.close();
});
