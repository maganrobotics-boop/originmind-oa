import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PRODUCTION_MIGRATION_NAME,
  PRODUCTION_MIGRATION_SHA256,
  REVIEWED_KNOWLEDGE_MIGRATIONS,
  productionKnowledgeDefinitions,
  validateD1Bookmark,
  validateProductionCloudflareSnapshot,
  validateProductionMigrationManifest,
  validateProductionMigrationState,
} from "../lib/production-release.mjs";
import { buildStandaloneConfig, productionTarget } from "../lib/standalone-config.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationNames = (await readdir(join(projectRoot, "drizzle")))
  .filter((name) => /^\d{4}_[A-Za-z0-9_]+\.sql$/u.test(name))
  .sort();
const migrationSqlByName = Object.fromEntries(await Promise.all(
  Object.keys(REVIEWED_KNOWLEDGE_MIGRATIONS).map(async (name) => [name, await readFile(join(projectRoot, "drizzle", name), "utf8")]),
));
const releaseScript = await readFile(join(projectRoot, "scripts", "release-production.sh"), "utf8");
const smokeScript = await readFile(join(projectRoot, "scripts", "verify-production-live.mjs"), "utf8");
const workflow = await readFile(join(projectRoot, ".github", "workflows", "deploy-oa.yml"), "utf8");

const validProductionEnvironment = Object.freeze({
  OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  OA_PRODUCTION_WORKER_NAME: "legacy-worker-name",
  OA_PRODUCTION_D1_DATABASE_NAME: "originmind-oa-production",
  OA_PRODUCTION_D1_DATABASE_ID: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  OA_PRODUCTION_WEBSITE_D1_DATABASE_NAME: "website-visits",
  OA_PRODUCTION_WEBSITE_D1_DATABASE_ID: "68f91d4c-0b3a-4a92-b879-f355177a67f8",
  OA_PRODUCTION_PUBLIC_ORIGIN: "https://oa.example.com",
  OA_PRODUCTION_CRON: "* * * * *",
});
const target = productionTarget(validProductionEnvironment);
const expectedKnowledgeDefinitions = productionKnowledgeDefinitions(migrationSqlByName);
const previousKnowledgeDefinitions = productionKnowledgeDefinitions(migrationSqlByName, ["0026_rich_jocasta.sql"]);
const notificationObjects = [
  "index:notification_outbox_due",
  "table:notification_control",
  "table:notification_outbox",
];
const expectedSchemaObjects = [...notificationObjects, ...Object.keys(expectedKnowledgeDefinitions)].sort();
const previousSchemaObjects = [...notificationObjects, ...Object.keys(previousKnowledgeDefinitions)].sort();

function queryResult(rows) {
  return [{ success: true, results: rows, meta: { served_by: "test" } }];
}

function schemaPayload(names) {
  return queryResult(names.map((entry) => {
    const separator = entry.indexOf(":");
    return {
      type: entry.slice(0, separator),
      name: entry.slice(separator + 1),
      sql: expectedKnowledgeDefinitions[entry] || `CREATE ${entry.startsWith("index:") ? "INDEX" : "TABLE"} ${entry.slice(separator + 1)}`,
    };
  }));
}

function migrationSnapshot(appliedNames, schemaNames, activeFreezes = 0) {
  return {
    ledgerPayload: queryResult(appliedNames.map((name, index) => ({ id: index + 1, name }))),
    freezePayload: queryResult([{ active_freezes: activeFreezes }]),
    schemaPayload: schemaPayload(schemaNames),
    expectedMigrationNames: migrationNames,
    expectedSchemaObjects,
    expectedKnowledgeDefinitions,
    previousKnowledgeDefinitions,
  };
}

test("production migration gate supports exact 0025, 0026, and 0027 states", () => {
  assert.equal(migrationNames.length, 28);
  assert.equal(migrationNames.at(-1), PRODUCTION_MIGRATION_NAME);
  assert.equal(PRODUCTION_MIGRATION_SHA256, "a5648c380df4bafff324bdd088861e561baf6ed61cfc4c5f5ff0706951f5beaa");
  assert.deepEqual(validateProductionMigrationManifest({ migrationNames, migrationSqlByName }), migrationNames);
  assert.equal(validateProductionMigrationState({
    phase: "before",
    ...migrationSnapshot(migrationNames.slice(0, -2), notificationObjects),
  }), "pending-0026-0027");
  assert.equal(validateProductionMigrationState({
    phase: "before",
    ...migrationSnapshot(migrationNames.slice(0, -1), previousSchemaObjects),
  }), "pending-0027");
  assert.equal(validateProductionMigrationState({
    phase: "before",
    ...migrationSnapshot(migrationNames, expectedSchemaObjects),
  }), "applied");
  assert.equal(validateProductionMigrationState({
    phase: "after",
    ...migrationSnapshot(migrationNames, expectedSchemaObjects),
  }), "applied");
});

test("production migration gate rejects drift, partial ledgers, and freezes", () => {
  const pending = migrationSnapshot(migrationNames.slice(0, -1), previousSchemaObjects);
  assert.throws(() => validateProductionMigrationState({
    phase: "before",
    ...pending,
    freezePayload: queryResult([{ active_freezes: 1 }]),
  }), /active migration freeze/u);
  assert.throws(() => validateProductionMigrationState({ phase: "after", ...pending }), /must end exactly/u);
  assert.throws(() => validateProductionMigrationState({
    phase: "before",
    ...migrationSnapshot(migrationNames.slice(0, -1), previousSchemaObjects.slice(1)),
  }), /does not match|missing/u);
  assert.throws(() => validateProductionMigrationState({
    phase: "before",
    ...migrationSnapshot(migrationNames.slice(0, -2), [...notificationObjects, "table:knowledge_items"]),
  }), /unexpected or missing/u);
  assert.throws(() => validateProductionMigrationManifest({
    migrationNames,
    migrationSqlByName: { ...migrationSqlByName, [PRODUCTION_MIGRATION_NAME]: `${migrationSqlByName[PRODUCTION_MIGRATION_NAME]}\n-- drift` },
  }), /reviewed SHA-256/u);
});

test("migration CLI validates the immutable 0026 and 0027 files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "originmind-oa-production-migrations-"));
  try {
    const migrationsDirectory = join(directory, "drizzle");
    await cp(join(projectRoot, "drizzle"), migrationsDirectory, { recursive: true });
    const pending = migrationSnapshot(migrationNames.slice(0, -1), previousSchemaObjects);
    const paths = {
      ledger: join(directory, "ledger.json"),
      freeze: join(directory, "freeze.json"),
      schema: join(directory, "schema.json"),
    };
    await Promise.all([
      writeFile(paths.ledger, JSON.stringify(pending.ledgerPayload)),
      writeFile(paths.freeze, JSON.stringify(pending.freezePayload)),
      writeFile(paths.schema, JSON.stringify(pending.schemaPayload)),
    ]);
    const run = () => spawnSync(process.execPath, [
      join(projectRoot, "scripts", "check-production-migration-state.mjs"),
      "before",
      "--ledger", paths.ledger,
      "--freeze", paths.freeze,
      "--schema", paths.schema,
      "--migrations-dir", migrationsDirectory,
    ], { encoding: "utf8" });
    const good = run();
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stdout.trim(), "pending-0027");
    await writeFile(join(migrationsDirectory, PRODUCTION_MIGRATION_NAME), `${migrationSqlByName[PRODUCTION_MIGRATION_NAME]}\n-- drift\n`);
    const changed = run();
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /reviewed SHA-256/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("D1 recovery bookmark must be bounded and safe", () => {
  assert.equal(validateD1Bookmark({ bookmark: "00000000-00000000-00000000-00000000" }), "00000000-00000000-00000000-00000000");
  assert.throws(() => validateD1Bookmark({}), /safe recovery bookmark/u);
  assert.throws(() => validateD1Bookmark({ bookmark: "unsafe\nbookmark" }), /safe recovery bookmark/u);
});

function cloudflareSnapshot() {
  const releaseMessage = "production aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa run 12345.1";
  return {
    target,
    identity: { loggedIn: true, accounts: [{ id: target.accountId, name: "private account name" }] },
    primaryDatabase: { name: target.databaseName, uuid: target.databaseId },
    websiteDatabase: { name: target.websiteDatabaseName, uuid: target.websiteDatabaseId },
    secrets: [
      { name: "FEISHU_LOGIN_APP_SECRET", type: "secret_text" },
      { name: "GITHUB_OAUTH_CLIENT_SECRET", type: "secret_text" },
      { name: "OA_LAB_AI_API_KEY", type: "secret_text" },
      { name: "FUTURE_PROVIDER_SECRET", type: "secret_text" },
    ],
    deployments: [{
      id: "deployment-before-or-after",
      created_on: "2026-09-11T00:00:00.000Z",
      versions: [{ version_id: "released-version", percentage: 100 }],
    }],
    versions: [{
      id: "released-version",
      metadata: { created_on: "2026-09-11T00:00:00.000Z" },
      annotations: { "workers/message": releaseMessage },
    }],
    expectedVersionMessage: releaseMessage,
  };
}

test("production target gate is variable-backed and preserves additional secrets", () => {
  const result = validateProductionCloudflareSnapshot(cloudflareSnapshot());
  assert.equal(result.workerName, target.workerName);
  assert.equal(result.releasedVersionId, "released-version");
  assert.ok(result.secretNames.includes("FUTURE_PROVIDER_SECRET"));
  assert.throws(() => validateProductionCloudflareSnapshot({
    ...cloudflareSnapshot(),
    identity: { loggedIn: true, accounts: [{ id: "ffffffffffffffffffffffffffffffff" }] },
  }), /not authorized/u);
  assert.throws(() => validateProductionCloudflareSnapshot({
    ...cloudflareSnapshot(),
    secrets: cloudflareSnapshot().secrets.filter((entry) => entry.name !== "FEISHU_LOGIN_APP_SECRET"),
  }), /missing required secret/u);
});

test("compiled production config preserves provider-managed state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "originmind-oa-production-config-"));
  try {
    const serverRoot = join(directory, "dist", "server");
    const clientRoot = join(directory, "dist", "client");
    const drizzleRoot = join(directory, "drizzle");
    await Promise.all([mkdir(serverRoot, { recursive: true }), mkdir(clientRoot, { recursive: true }), mkdir(drizzleRoot, { recursive: true })]);
    await Promise.all([
      writeFile(join(serverRoot, "index.js"), "export default {};\n"),
      writeFile(join(clientRoot, "asset.js"), "export {};\n"),
      ...Object.entries(migrationSqlByName).map(([name, sql]) => writeFile(join(drizzleRoot, name), sql)),
    ]);
    const configPath = join(serverRoot, "wrangler.json");
    const base = buildStandaloneConfig("production", validProductionEnvironment);
    base.main = "index.js";
    base.no_bundle = true;
    base.assets.directory = "../client";
    const run = async (config) => {
      await writeFile(configPath, `${JSON.stringify(config)}\n`);
      return spawnSync(process.execPath, [join(projectRoot, "scripts", "check-standalone-output.mjs"), "production", configPath], {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, ...validProductionEnvironment },
      });
    };
    const good = await run(base);
    assert.equal(good.status, 0, good.stderr);
    for (const mutate of [
      (config) => { config.account_id = "ffffffffffffffffffffffffffffffff"; },
      (config) => { config.d1_databases[0].database_id = "00000000-0000-4000-8000-000000000000"; },
      (config) => { config.vars.EXTRA = "drift"; },
      (config) => { config.keep_vars = false; },
      (config) => { config.routes = [{ pattern: "oa.example.com", custom_domain: true }]; },
    ]) {
      const changed = structuredClone(base);
      mutate(changed);
      assert.notEqual((await run(changed)).status, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow and shell expose the token only to a confirmed manual main release", () => {
  const testJob = workflow.slice(workflow.indexOf("  test:"), workflow.indexOf("  reject-invalid-production-dispatch:"));
  const deployJob = workflow.slice(workflow.indexOf("  deploy:"));
  assert.doesNotMatch(workflow, /pull_request_target/u);
  assert.match(workflow, /permissions:\n  contents: read/u);
  assert.doesNotMatch(testJob, /CLOUDFLARE_API_TOKEN|release:standalone:production/u);
  assert.match(deployJob, /github\.event_name == 'workflow_dispatch'/u);
  assert.match(deployJob, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(deployJob, /vars\.OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID/u);
  assert.match(deployJob, /vars\.OA_PRODUCTION_PUBLIC_ORIGIN/u);
  assert.equal([...workflow.matchAll(/^\s+CLOUDFLARE_API_TOKEN:/gmu)].length, 1);
  assert.doesNotMatch(`${workflow}\n${releaseScript}`, /oa\.omindos\.ai|41e8b3404be24e1dd288556d77ffc951|34af7e92-7da5-47cd-b7c0-1270e157c0e6/u);

  const invalid = spawnSync("/bin/bash", [join(projectRoot, "scripts", "release-production.sh"), "production"], {
    encoding: "utf8",
    env: {
      PATH: "/nonexistent",
      ...validProductionEnvironment,
      CLOUDFLARE_ACCOUNT_ID: validProductionEnvironment.OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "test-token",
      OA_PRODUCTION_RELEASE_CONFIRM: "wrong",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "1",
    },
  });
  assert.equal(invalid.status, 64);
  assert.doesNotMatch(invalid.stderr, /command not found/u);
  assert.match(releaseScript, /run_wrangler deploy --dry-run --strict --keep-vars --config/u);
  assert.match(releaseScript, /run_wrangler deploy --strict --keep-vars --config/u);
  assert.match(releaseScript, /d1 time-travel info DB/u);
  assert.equal([...releaseScript.matchAll(/d1 migrations apply DB/g)].length, 1);
  assert.doesNotMatch(releaseScript, /run_wrangler\s+(?:rollback|d1 time-travel restore)\b/u);
});

test("production smoke uses the injected origin and remains read-only", () => {
  assert.match(smokeScript, /productionTarget\(process\.env\)\.publicOrigin/u);
  assert.match(smokeScript, /request\("\/api\/session"/u);
  assert.match(smokeScript, /ARTS Robotics AI Assistant/u);
  assert.match(smokeScript, /\/api\/lab-ai\/ask/u);
  assert.doesNotMatch(smokeScript, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/u);
});
