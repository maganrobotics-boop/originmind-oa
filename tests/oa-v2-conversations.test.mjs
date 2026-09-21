import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { drizzle } from "drizzle-orm/d1";
import {
  CONVERSATION_MESSAGE_MAX_LENGTH,
  parseConversationMessageInput,
  parseCreateConversationInput,
} from "../lib/conversation-contract.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaV2ConversationTests";
let database;

class Statement {
  constructor(sqlite, query, bindings = []) {
    this.sqlite = sqlite;
    this.query = query;
    this.bindings = bindings;
  }
  bind(...bindings) { return new Statement(this.sqlite, this.query, bindings); }
  execute() {
    const statement = this.sqlite.prepare(this.query);
    if (statement.columns().length) return { success: true, results: statement.all(...this.bindings) };
    const result = statement.run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async all() { return this.execute(); }
  async first() { return this.sqlite.prepare(this.query).get(...this.bindings) || null; }
  async raw() {
    const statement = this.sqlite.prepare(this.query);
    statement.setReturnArrays(true);
    return statement.all(...this.bindings);
  }
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
    name: "oa-v2-conversation-test",
    enforce: "pre",
    resolveId(source) {
      if (/\/_lib\/auth$/u.test(source)) return "\0test-oa-v2-auth";
      if (/^(?:\.\.\/)+db$/u.test(source)) return "\0test-oa-v2-db";
      if (/lib\/write-rate-limit$/u.test(source)) return "\0test-oa-v2-rate-limit";
      return null;
    },
    load(id) {
      if (id === "\0test-oa-v2-auth") return `
        export async function getAuthorizedUser(){return globalThis.${stateKey}.authorized;}
        export function isNdaAdmittedMember(member){return Boolean(member.accountUserId && member.ndaAcceptedAt && member.ndaAgreementVersion);}`;
      if (id === "\0test-oa-v2-db") return `
        export async function getDb(){return globalThis.${stateKey}.db;}
        export async function getD1Database(){return globalThis.${stateKey}.d1;}`;
      if (id === "\0test-oa-v2-rate-limit") return `export async function consumeWriteRateLimit(){return globalThis.${stateKey}.rateAllowed;}`;
      return null;
    },
  }],
});

const conversationRoute = await vite.ssrLoadModule("/app/api/conversations/route.ts");
const messageRoute = await vite.ssrLoadModule("/app/api/conversations/[id]/messages/route.ts");
const ids = {
  conversation: "11111111-2222-4333-8444-555555555555",
  message: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
};
const actor = (id = "member-a", name = "成员甲") => ({
  user: { email: `${id}@example.test`, displayName: name },
  ndaCompleted: true,
  accountUserId: `account-${id}`,
  memberId: id,
  memberMutationRevision: `revision-${id}`,
});
const createRequest = (value, headers = {}) => new Request("https://oa.example.test/api/conversations", {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://oa.example.test", ...headers },
  body: JSON.stringify(value),
});
const messageRequest = (value, headers = {}) => new Request(`https://oa.example.test/api/conversations/${ids.conversation}/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://oa.example.test", ...headers },
  body: JSON.stringify(value),
});
const params = (id = ids.conversation) => ({ params: Promise.resolve({ id }) });

function addMember(id, name) {
  database.prepare(`INSERT INTO members(id,full_name,chatgpt_account,account_user_id,role,permissions_json,nda_accepted_at,nda_agreement_version,mutation_revision,status)
    VALUES (?,?,?,?,?,?,?,?,?,'active')`).run(id, name, `${id}@example.test`, `account-${id}`, "member", "[]", "2026-09-21", "NDA-2026-09", `revision-${id}`);
}

beforeEach(() => {
  database?.close();
  database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE members(
      id TEXT PRIMARY KEY,full_name TEXT,chatgpt_account TEXT,account_user_id TEXT,role TEXT,permissions_json TEXT,
      nda_accepted_at TEXT,nda_agreement_version TEXT,mutation_revision TEXT,status TEXT,department_code TEXT DEFAULT ''
    ); CREATE TABLE migration_control(freeze_id TEXT PRIMARY KEY,activated_at TEXT DEFAULT CURRENT_TIMESTAMP,deactivated_at TEXT);`);
  const migration = readFileSync(new URL("../drizzle/0034_lab_oa_v2_foundation.sql", import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) database.exec(statement);
  addMember("member-a", "成员甲");
  addMember("member-b", "成员乙");
  addMember("member-c", "成员丙");
  const binding = d1(database);
  globalThis[stateKey] = { authorized: actor(), rateAllowed: true, d1: binding, db: drizzle(binding) };
});

after(async () => {
  database?.close();
  await vite.close();
  delete globalThis[stateKey];
});

async function createGroup(overrides = {}, headers = {}) {
  return conversationRoute.POST(createRequest({
    type: "group",
    title: "机器人项目群",
    memberIds: ["member-b"],
    clientConversationId: ids.conversation,
    ...overrides,
  }, headers));
}

test("creates a guarded group and lists it only for active members", async () => {
  const response = await createGroup();
  assert.equal(response.status, 201);
  assert.equal(database.prepare("SELECT count(*) AS count FROM conversations").get().count, 1);
  const memberships = database.prepare("SELECT member_id,role FROM conversation_members ORDER BY member_id").all()
    .map(({ member_id, role }) => ({ member_id, role }));
  assert.deepEqual(memberships, [{ member_id: "member-a", role: "owner" }, { member_id: "member-b", role: "member" }]);
  const mine = await conversationRoute.GET();
  assert.equal((await mine.json()).conversations[0].title, "机器人项目群");
  globalThis[stateKey].authorized = actor("member-c", "成员丙");
  assert.deepEqual((await (await conversationRoute.GET()).json()).conversations, []);
});

test("rejects forged, ineligible, cross-site, solo, and duplicate group creation", async () => {
  assert.equal((await createGroup({ senderMemberId: "member-c" })).status, 400);
  assert.equal((await createGroup({}, { origin: "https://other.example" })).status, 403);
  assert.equal((await createGroup({ memberIds: ["member-a"] })).status, 400);
  database.exec("UPDATE members SET status='departed' WHERE id='member-b'");
  assert.equal((await createGroup()).status, 409);
  database.exec("UPDATE members SET status='active' WHERE id='member-b'");
  assert.equal((await createGroup()).status, 201);
  assert.equal((await createGroup()).status, 409);
  assert.equal(database.prepare("SELECT count(*) AS count FROM conversation_members").get().count, 2);
});

test("members exchange full messages while outsiders learn no history", async () => {
  assert.equal((await createGroup()).status, 201);
  const body = "完整实验记录。".repeat(800);
  const sent = await messageRoute.POST(messageRequest({ body, clientMessageId: ids.message }), params());
  assert.equal(sent.status, 201);
  assert.equal((await sent.json()).message.body, body);
  globalThis[stateKey].authorized = actor("member-b", "成员乙");
  const received = await messageRoute.GET(new Request(`https://oa.example.test/api/conversations/${ids.conversation}/messages`), params());
  assert.equal((await received.json()).messages[0].body, body);
  globalThis[stateKey].authorized = actor("member-c", "成员丙");
  const hidden = await messageRoute.GET(new Request(`https://oa.example.test/api/conversations/${ids.conversation}/messages`), params());
  assert.deepEqual((await hidden.json()).messages, []);
  assert.equal((await messageRoute.POST(messageRequest({ body: "越权消息" }), params())).status, 409);
  assert.equal(database.prepare("SELECT count(*) AS count FROM conversation_messages").get().count, 1);
});

test("message retries are idempotent and cannot change sender, room, or body", async () => {
  await createGroup();
  const first = await messageRoute.POST(messageRequest({ body: "同一条消息", clientMessageId: ids.message }), params());
  const retry = await messageRoute.POST(messageRequest({ body: "同一条消息", clientMessageId: ids.message }), params());
  const changed = await messageRoute.POST(messageRequest({ body: "替换正文", clientMessageId: ids.message }), params());
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(changed.status, 409);
  assert.equal(database.prepare("SELECT count(*) AS count FROM conversation_messages").get().count, 1);
});

test("removal, archival, mutation changes, rate limits, and malformed input fail closed", async () => {
  await createGroup();
  database.exec("UPDATE conversation_members SET left_at='2026-09-21T00:00:00.000Z' WHERE member_id='member-b'");
  globalThis[stateKey].authorized = actor("member-b", "成员乙");
  assert.equal((await messageRoute.POST(messageRequest({ body: "已离群" }), params())).status, 409);
  globalThis[stateKey].authorized = actor();
  database.exec("UPDATE conversations SET archived_at='2026-09-21T00:00:00.000Z'");
  assert.equal((await messageRoute.POST(messageRequest({ body: "已归档" }), params())).status, 409);
  database.exec("UPDATE conversations SET archived_at=NULL; UPDATE members SET mutation_revision='new-revision' WHERE id='member-a'");
  assert.equal((await messageRoute.POST(messageRequest({ body: "账号已变化" }), params())).status, 409);
  globalThis[stateKey].authorized = actor();
  database.exec("UPDATE members SET mutation_revision='revision-member-a' WHERE id='member-a'");
  globalThis[stateKey].rateAllowed = false;
  assert.equal((await messageRoute.POST(messageRequest({ body: "限流" }), params())).status, 429);
  globalThis[stateKey].rateAllowed = true;
  assert.equal((await messageRoute.POST(messageRequest({ body: "甲".repeat(CONVERSATION_MESSAGE_MAX_LENGTH + 1) }), params())).status, 400);
  assert.equal((await messageRoute.POST(messageRequest({ body: "恶意\u0000正文" }), params())).status, 400);
  assert.equal((await messageRoute.POST(messageRequest({ body: "格式" }, { "content-type": "text/plain" }), params())).status, 415);
});

test("shared contracts accept only bounded group and message shapes", () => {
  assert.ok(parseCreateConversationInput({ type: "group", title: "实验室群", memberIds: ["member-b"] }));
  assert.equal(parseCreateConversationInput({ type: "group", title: "实验室群", memberIds: [] }), null);
  assert.equal(parseCreateConversationInput({ type: "direct", title: "实验室群", memberIds: ["member-b"] }), null);
  assert.ok(parseConversationMessageInput({ body: "甲".repeat(CONVERSATION_MESSAGE_MAX_LENGTH) }));
  assert.equal(parseConversationMessageInput({ body: "", senderName: "AI" }), null);
});
