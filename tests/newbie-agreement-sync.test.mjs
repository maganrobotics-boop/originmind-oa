import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { drizzle } from "drizzle-orm/d1";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaNewbieAgreementSyncTest";
const serviceToken = "A".repeat(43);
globalThis[stateKey] = {};

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "newbie-agreement-sync-test-dependencies",
    enforce: "pre",
    resolveId(source) {
      if (source === "cloudflare:workers") return "\0newbie-agreement-sync-env";
      if (/^(?:\.\.\/)+db$/u.test(source)) return "\0newbie-agreement-sync-db";
      return null;
    },
    load(id) {
      if (id === "\0newbie-agreement-sync-env") {
        return `export const env = new Proxy({}, { get: (_, key) => globalThis.${stateKey}.env[key] });`;
      }
      if (id === "\0newbie-agreement-sync-db") {
        return `export async function getDb() { return globalThis.${stateKey}.db; }`;
      }
      return null;
    },
  }],
});

const route = await vite.ssrLoadModule("/app/api/public/lab-ai/newbie-agreement/route.ts");
let sqlite;
let batchTail = Promise.resolve();

function d1Adapter(database) {
  function prepare(query, params = []) {
    const execute = () => ({
      success: true,
      results: database.prepare(query).all(...params),
      meta: { changes: Number(database.prepare("SELECT changes() n").get().n) },
    });
    return {
      bind(...values) { return prepare(query, values); },
      async all() { return execute(); },
      async run() { return execute(); },
      async raw() {
        const statement = database.prepare(query);
        statement.setReturnArrays(true);
        return statement.all(...params);
      },
    };
  }
  return {
    prepare,
    batch(statements) {
      const run = async () => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.all());
          database.exec("COMMIT");
          return results;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      };
      const result = batchTail.then(run, run);
      batchTail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

const agreement = {
  version: "2026-09-25-v2",
  title: "OriginMind × ARTS Robotics 新手村保密协议",
  effectiveDate: "2026-09-25",
  introduction: "进入学习任务前，请阅读并同意保密约定。",
  clauses: [{ title: "一、保密范围", text: "未公开代码、数据、设计和实验记录均属于保密信息。" }],
  privacyNotice: "签署记录保存在 Chat，并以自动归档记录同步到 OA。",
};

function agreementText(value = agreement) {
  return [
    value.title,
    `协议版本：${value.version}`,
    `生效日期：${value.effectiveDate}`,
    value.introduction,
    ...value.clauses.flatMap((clause) => [clause.title, clause.text]),
    `隐私说明：${value.privacyNotice}`,
  ].join("\n");
}

function payload(overrides = {}) {
  return {
    email: "student@stumail.sztu.edu.cn",
    signerName: "测试同学",
    acceptedAt: "2026-09-25T01:02:03.000Z",
    contentSha256: createHash("sha256").update(JSON.stringify(agreement)).digest("hex"),
    agreement,
    agreementText: agreementText(),
    ...overrides,
  };
}

function request(body = payload(), headers = {}) {
  return new Request("https://oa.omindos.ai/api/public/lab-ai/newbie-agreement", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-originmind-public-lab-ai-service-token": serviceToken,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sqlite?.close();
  sqlite = new DatabaseSync(":memory:");
  batchTail = Promise.resolve();
  const directory = new URL("../drizzle/", import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    for (const sql of readFileSync(new URL(file, directory), "utf8")
      .split("--> statement-breakpoint").filter((part) => part.trim())) sqlite.exec(sql);
  }
  globalThis[stateKey] = {
    env: { PUBLIC_LAB_AI_SERVICE_TOKEN: serviceToken },
    db: drizzle(d1Adapter(sqlite)),
  };
});

after(async () => {
  sqlite?.close();
  delete globalThis[stateKey];
  await vite.close();
});

test("private service route archives a verified newbie agreement with immutable audit evidence", async () => {
  const response = await route.POST(request());
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.approval.status, "已归档");
  assert.equal(body.idempotent, false);

  const approval = sqlite.prepare("SELECT * FROM approvals WHERE id=?").get(body.approval.id);
  assert.equal(approval.type, "保密协议");
  assert.equal(approval.requester_email, "student@stumail.sztu.edu.cn");
  assert.equal(approval.current_step, "已归档");
  assert.equal(approval.owner, "系统自动审核");
  assert.equal(approval.current_revision_no, 1);
  assert.match(approval.current_revision_hash, /^[a-f0-9]{64}$/u);
  const storedPayload = JSON.parse(approval.payload_json);
  assert.equal(storedPayload.agreementKind, "newbie");
  assert.equal(storedPayload.sourceSystem, "chat.omindos.ai/newbie-village");
  assert.equal(storedPayload.autoArchived, true);
  assert.equal(storedPayload.agreementTextSnapshot, agreementText());
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM approval_revisions WHERE approval_id=?").get(approval.id).n, 1);
  const event = sqlite.prepare("SELECT * FROM approval_events WHERE approval_id=?").get(approval.id);
  assert.equal(event.action, "auto_archived");
});

test("retries are idempotent and conflicting signer data fails closed", async () => {
  const first = await route.POST(request());
  const created = await first.json();
  assert.equal(first.status, 201);

  const retry = await route.POST(request());
  const retried = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retried.idempotent, true);
  assert.equal(retried.approval.id, created.approval.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM approvals").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM approval_events").get().n, 1);

  const conflict = await route.POST(request(payload({ signerName: "另一位同学" })));
  assert.equal(conflict.status, 409);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM approvals").get().n, 1);
});

test("authentication, migration freeze, and agreement integrity fail closed", async () => {
  assert.equal((await route.POST(request(payload(), {
    "x-originmind-public-lab-ai-service-token": "B".repeat(43),
  }))).status, 401);
  assert.equal((await route.POST(request(payload(), { cookie: "oa_session=forbidden" }))).status, 401);

  globalThis[stateKey].env.OA_MIGRATION_WRITE_FROZEN = "true";
  const frozen = await route.POST(request());
  assert.equal(frozen.status, 503);
  assert.equal(frozen.headers.get("retry-after"), "300");
  globalThis[stateKey].env.OA_MIGRATION_WRITE_FROZEN = "false";

  assert.equal((await route.POST(request(payload({ contentSha256: "0".repeat(64) })))).status, 400);
  assert.equal((await route.POST(request(payload({ agreementText: `${agreementText()}\n篡改` })))).status, 400);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM approvals").get().n, 0);
});
