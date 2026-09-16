import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { normalizePublicLabAiServiceToken } from "../scripts/normalize-public-lab-ai-service-token.mjs";
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
const reviewedNames = Object.keys(REVIEWED_KNOWLEDGE_MIGRATIONS);
const knowledgeDefinitionsByMigration = Object.fromEntries(reviewedNames.map((name, index) => [
  Number(name.slice(0, 4)),
  productionKnowledgeDefinitions(migrationSqlByName, reviewedNames.slice(0, index + 1)),
]));
const notificationObjects = [
  "index:notification_outbox_due",
  "table:notification_control",
  "table:notification_outbox",
];
const schemaObjectsFor = (definitions) => [...notificationObjects, ...Object.keys(definitions)].sort();
const expectedSchemaObjects = schemaObjectsFor(expectedKnowledgeDefinitions);
const migration30KnowledgeDefinitions = knowledgeDefinitionsByMigration[30];
const migration30SchemaObjects = schemaObjectsFor(migration30KnowledgeDefinitions);


test("OA service token normalization matches the Chat release contract", () => {
  const exactToken = "A".repeat(43);
  assert.equal(normalizePublicLabAiServiceToken(exactToken, "cloudflare-api-token-long-enough"), exactToken);
  assert.equal(normalizePublicLabAiServiceToken(`\u00a0${exactToken}\u3000`, "rotated-cloudflare-api-token"), exactToken);
  const copiedValue = `${"A".repeat(42)}=`;
  const derived = normalizePublicLabAiServiceToken(copiedValue, "cloudflare-api-token-long-enough");
  assert.equal(derived, "1deoXJ_E6TPJy6PKS7aTztkKbUiXGr59FlLyiKRPFqE");
  assert.match(derived, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(normalizePublicLabAiServiceToken(copiedValue, "rotated-cloudflare-api-token"), derived);
  assert.match(
    normalizePublicLabAiServiceToken(`${"A".repeat(21)}\n${"A".repeat(22)}`, "cloudflare-api-token-long-enough"),
    /^[A-Za-z0-9_-]{43}$/u,
  );
  assert.throws(() => normalizePublicLabAiServiceToken(" \r\n ", "cloudflare-api-token-long-enough"), /is required/u);
  assert.throws(() => normalizePublicLabAiServiceToken("A".repeat(4_097), "cloudflare-api-token-long-enough"), /missing or invalid/u);
});

test("OA shell captures a derived service token without writing any credential", async () => {
  const commandDirectory = await mkdtemp(join(tmpdir(), "originmind-oa-token-command-"));
  const rawToken = `${"A".repeat(42)}=`;
  const derivedToken = "1deoXJ_E6TPJy6PKS7aTztkKbUiXGr59FlLyiKRPFqE";
  const apiToken = "cloudflare-api-token-long-enough";
  try {
    await symlink(process.execPath, join(commandDirectory, "node"));
    const run = spawnSync("/bin/bash", [join(projectRoot, "scripts", "release-production.sh"), "production"], {
      encoding: "utf8",
      env: {
        PATH: commandDirectory,
        ...validProductionEnvironment,
        CLOUDFLARE_ACCOUNT_ID: validProductionEnvironment.OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: apiToken,
        PUBLIC_LAB_AI_SERVICE_TOKEN: rawToken,
        OA_PRODUCTION_RELEASE_CONFIRM: `${validProductionEnvironment.OA_PRODUCTION_WORKER_NAME}:${validProductionEnvironment.OA_PRODUCTION_D1_DATABASE_ID}:${new URL(validProductionEnvironment.OA_PRODUCTION_PUBLIC_ORIGIN).hostname}`,
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: "a".repeat(40),
        GITHUB_RUN_ID: "12345",
        GITHUB_RUN_ATTEMPT: "1",
      },
    });
    assert.equal(run.status, 127);
    assert.match(run.stderr, /mkdir: command not found/u);
    for (const credential of [rawToken, derivedToken, apiToken]) {
      assert.ok(!`${run.stdout}${run.stderr}`.includes(credential));
    }
  } finally {
    await rm(commandDirectory, { recursive: true, force: true });
  }
});

function queryResult(rows) {
  return [{ success: true, results: rows, meta: { served_by: "test" } }];
}

function schemaPayload(names, definitions = expectedKnowledgeDefinitions) {
  return queryResult(names.map((entry) => {
    const separator = entry.indexOf(":");
    return {
      type: entry.slice(0, separator),
      name: entry.slice(separator + 1),
      sql: definitions[entry] || `CREATE ${entry.startsWith("index:") ? "INDEX" : "TABLE"} ${entry.slice(separator + 1)}`,
    };
  }));
}

function migrationSnapshot(appliedNames, schemaNames, activeFreezes = 0, definitions = expectedKnowledgeDefinitions) {
  return {
    ledgerPayload: queryResult(appliedNames.map((name, index) => ({ id: index + 1, name }))),
    freezePayload: queryResult([{ active_freezes: activeFreezes }]),
    schemaPayload: schemaPayload(schemaNames, definitions),
    expectedMigrationNames: migrationNames,
    expectedSchemaObjects,
    expectedKnowledgeDefinitions,
    knowledgeDefinitionsByMigration,
  };
}

test("production migration gate supports every exact reviewed prefix through the release", () => {
  assert.equal(migrationNames.length, Number(PRODUCTION_MIGRATION_NAME.slice(0, 4)) + 1);
  assert.equal(migrationNames.at(-1), PRODUCTION_MIGRATION_NAME);
  assert.equal(REVIEWED_KNOWLEDGE_MIGRATIONS[PRODUCTION_MIGRATION_NAME], PRODUCTION_MIGRATION_SHA256);
  assert.deepEqual(validateProductionMigrationManifest({ migrationNames, migrationSqlByName }), migrationNames);
  for (let lastMigration = 25; lastMigration < migrationNames.length; lastMigration += 1) {
    const definitions = lastMigration === 25 ? {} : knowledgeDefinitionsByMigration[lastMigration];
    const snapshot = migrationSnapshot(migrationNames.slice(0, lastMigration + 1), schemaObjectsFor(definitions), 0, definitions);
    const pending = migrationNames.slice(lastMigration + 1).map((name) => name.slice(0, 4));
    assert.equal(validateProductionMigrationState({ phase: "before", ...snapshot }), pending.length ? `pending-${pending.join("-")}` : "applied");
    if (pending.length) assert.throws(() => validateProductionMigrationState({ phase: "after", ...snapshot }), /must end exactly/u);
    else assert.equal(validateProductionMigrationState({ phase: "after", ...snapshot }), "applied");
  }
});


test("reviewed definitions match SQLite's forward migration result", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const name of Object.keys(REVIEWED_KNOWLEDGE_MIGRATIONS)) {
      for (const statement of migrationSqlByName[name].split(/--> statement-breakpoint\s*/u).map((value) => value.trim()).filter(Boolean)) {
        database.exec(statement);
      }
    }
    const actualKnowledgeRows = database.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name GLOB 'knowledge_*' ORDER BY type, name",
    ).all().map((row) => ({ ...row }));
    const notificationRows = notificationObjects.map((entry) => {
      const separator = entry.indexOf(":");
      return {
        type: entry.slice(0, separator),
        name: entry.slice(separator + 1),
        sql: `CREATE ${entry.startsWith("index:") ? "INDEX" : "TABLE"} ${entry.slice(separator + 1)}`,
      };
    });
    assert.equal(validateProductionMigrationState({
      phase: "after",
      ...migrationSnapshot(migrationNames, expectedSchemaObjects),
      schemaPayload: queryResult([...actualKnowledgeRows, ...notificationRows]),
    }), "applied");
  } finally {
    database.close();
  }
});

test("production migration gate rejects drift, partial ledgers, and freezes", () => {
  const pending = migrationSnapshot(
    migrationNames.slice(0, 31),
    migration30SchemaObjects,
    0,
    migration30KnowledgeDefinitions,
  );
  assert.throws(() => validateProductionMigrationState({
    phase: "before",
    ...pending,
    freezePayload: queryResult([{ active_freezes: 1 }]),
  }), /active migration freeze/u);
  assert.throws(() => validateProductionMigrationState({ phase: "after", ...pending }), /must end exactly/u);
  assert.throws(() => validateProductionMigrationState({
    phase: "after",
    ...migrationSnapshot(
      migrationNames,
      expectedSchemaObjects.filter((name) => name !== "table:knowledge_revision_parts"),
    ),
  }), /does not match/u);
  assert.throws(() => validateProductionMigrationState({
    phase: "before",
    ...migrationSnapshot(migrationNames.slice(0, 31), migration30SchemaObjects.slice(1), 0, migration30KnowledgeDefinitions),
  }), /does not match|missing/u);
  assert.throws(() => validateProductionMigrationState({
    phase: "before",
    ...migrationSnapshot(migrationNames.slice(0, 26), [...notificationObjects, "table:knowledge_items"]),
  }), /unexpected or missing/u);
  assert.throws(() => validateProductionMigrationManifest({
    migrationNames,
    migrationSqlByName: { ...migrationSqlByName, [PRODUCTION_MIGRATION_NAME]: `${migrationSqlByName[PRODUCTION_MIGRATION_NAME]}\n-- drift` },
  }), /reviewed SHA-256/u);
});

test("asset migration gate rejects SQL drift and partial application at each checkpoint", () => {
  assert.equal(Object.keys(knowledgeDefinitionsByMigration[30]).length, 51);
  assert.equal(Object.keys(knowledgeDefinitionsByMigration[31]).length, 57);
  assert.equal(Object.keys(knowledgeDefinitionsByMigration[32]).length, 58);
  assert.equal(Object.keys(knowledgeDefinitionsByMigration[33]).length, 59);
  for (const migration of [31, 32, 33]) {
    const definitions = knowledgeDefinitionsByMigration[migration];
    const snapshot = migrationSnapshot(migrationNames.slice(0, migration + 1), schemaObjectsFor(definitions), 0, definitions);
    const changed = structuredClone(snapshot);
    const table = changed.schemaPayload[0].results.find((row) => row.name === "knowledge_revision_assets");
    table.sql = table.sql.replace("`sha256` text NOT NULL", "`sha256` text");
    assert.throws(() => validateProductionMigrationState({ phase: "before", ...changed }), /schema SQL does not match/u);
    const partial = structuredClone(snapshot);
    partial.schemaPayload[0].results = partial.schemaPayload[0].results.filter((row) => row.name !== "knowledge_revision_assets_immutable");
    assert.throws(() => validateProductionMigrationState({ phase: "before", ...partial }), /does not match/u);
    const wrongLedger = structuredClone(snapshot);
    wrongLedger.ledgerPayload[0].results.at(-1).name = "0099_unreviewed.sql";
    assert.throws(() => validateProductionMigrationState({ phase: "before", ...wrongLedger }), /must end exactly/u);
  }
  for (const name of reviewedNames) {
    assert.throws(() => validateProductionMigrationManifest({
      migrationNames,
      migrationSqlByName: { ...migrationSqlByName, [name]: `${migrationSqlByName[name]}\n-- changed` },
    }), /reviewed SHA-256/u);
  }
  assert.throws(() => validateProductionMigrationManifest({
    migrationNames: [...migrationNames, "0034_unreviewed.sql"], migrationSqlByName,
  }), /exact migrations/u);
  assert.throws(() => productionKnowledgeDefinitions(migrationSqlByName, reviewedNames.slice(1)), /exact ordered prefix/u);
});

test("migration CLI validates all reviewed immutable migration files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "originmind-oa-production-migrations-"));
  try {
    const migrationsDirectory = join(directory, "drizzle");
    await cp(join(projectRoot, "drizzle"), migrationsDirectory, { recursive: true });
    const pending = migrationSnapshot(
      migrationNames.slice(0, 31),
      migration30SchemaObjects,
      0,
      migration30KnowledgeDefinitions,
    );
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
    const run = (phase = "before") => spawnSync(process.execPath, [
      join(projectRoot, "scripts", "check-production-migration-state.mjs"),
      phase,
      "--ledger", paths.ledger,
      "--freeze", paths.freeze,
      "--schema", paths.schema,
      "--migrations-dir", migrationsDirectory,
    ], { encoding: "utf8" });
    const good = run();
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stdout.trim(), `pending-${migrationNames.slice(31).map((name) => name.slice(0, 4)).join("-")}`);
    await Promise.all([
      writeFile(paths.ledger, JSON.stringify(migrationSnapshot(migrationNames, expectedSchemaObjects).ledgerPayload)),
      writeFile(paths.schema, JSON.stringify(migrationSnapshot(migrationNames, expectedSchemaObjects).schemaPayload)),
    ]);
    const after = run("after");
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout.trim(), "applied");
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
      { name: "PUBLIC_LAB_AI_SERVICE_TOKEN", type: "secret_text" },
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
  assert.throws(() => validateProductionCloudflareSnapshot({
    ...cloudflareSnapshot(),
    secrets: cloudflareSnapshot().secrets.filter((entry) => entry.name !== "PUBLIC_LAB_AI_SERVICE_TOKEN"),
  }), /missing required secret PUBLIC_LAB_AI_SERVICE_TOKEN/u);
  const tokenNotYetConfigured = validateProductionCloudflareSnapshot({
    ...cloudflareSnapshot(),
    secrets: cloudflareSnapshot().secrets.filter((entry) => entry.name !== "PUBLIC_LAB_AI_SERVICE_TOKEN"),
    allowMissingPublicLabAiServiceToken: true,
  });
  assert.ok(!tokenNotYetConfigured.secretNames.includes("PUBLIC_LAB_AI_SERVICE_TOKEN"));
  assert.throws(() => validateProductionCloudflareSnapshot({
    ...cloudflareSnapshot(),
    secrets: cloudflareSnapshot().secrets.filter((entry) => entry.name !== "GITHUB_OAUTH_CLIENT_SECRET"),
    allowMissingPublicLabAiServiceToken: true,
  }), /missing required secret GITHUB_OAUTH_CLIENT_SECRET/u);
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
    await rm(join(drizzleRoot, PRODUCTION_MIGRATION_NAME));
    const missingLatestMigration = await run(base);
    assert.notEqual(missingLatestMigration.status, 0);
    assert.ok(missingLatestMigration.stderr.includes(PRODUCTION_MIGRATION_NAME));
    await writeFile(join(drizzleRoot, PRODUCTION_MIGRATION_NAME), migrationSqlByName[PRODUCTION_MIGRATION_NAME]);
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
  assert.equal([...workflow.matchAll(/^\s+PUBLIC_LAB_AI_SERVICE_TOKEN:/gmu)].length, 1);
  assert.doesNotMatch(`${workflow}\n${releaseScript}`, /oa\.omindos\.ai|41e8b3404be24e1dd288556d77ffc951|34af7e92-7da5-47cd-b7c0-1270e157c0e6/u);

  const invalid = spawnSync("/bin/bash", [join(projectRoot, "scripts", "release-production.sh"), "production"], {
    encoding: "utf8",
    env: {
      PATH: "/nonexistent",
      ...validProductionEnvironment,
      CLOUDFLARE_ACCOUNT_ID: validProductionEnvironment.OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "test-token",
      PUBLIC_LAB_AI_SERVICE_TOKEN: "A".repeat(43),
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

  const invalidServiceToken = "A".repeat(42) + "=";
  const invalidTokenRun = spawnSync("/bin/bash", [join(projectRoot, "scripts", "release-production.sh"), "production"], {
    encoding: "utf8",
    env: {
      PATH: "/nonexistent",
      ...validProductionEnvironment,
      CLOUDFLARE_ACCOUNT_ID: validProductionEnvironment.OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "test-token",
      PUBLIC_LAB_AI_SERVICE_TOKEN: invalidServiceToken,
      OA_PRODUCTION_RELEASE_CONFIRM: `${validProductionEnvironment.OA_PRODUCTION_WORKER_NAME}:${validProductionEnvironment.OA_PRODUCTION_D1_DATABASE_ID}:${new URL(validProductionEnvironment.OA_PRODUCTION_PUBLIC_ORIGIN).hostname}`,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "1",
    },
  });
  assert.notEqual(invalidTokenRun.status, 64);
  assert.doesNotMatch(invalidTokenRun.stderr, /PUBLIC_LAB_AI_SERVICE_TOKEN (?:must|is missing)/u);
  assert.ok(!`${invalidTokenRun.stdout}${invalidTokenRun.stderr}`.includes(invalidServiceToken));

  const clipboardToken = ` \n${"A".repeat(43)}\r\n`;
  const clipboardTokenRun = spawnSync("/bin/bash", [join(projectRoot, "scripts", "release-production.sh"), "production"], {
    encoding: "utf8",
    env: {
      PATH: "/nonexistent",
      ...validProductionEnvironment,
      CLOUDFLARE_ACCOUNT_ID: validProductionEnvironment.OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "test-token",
      PUBLIC_LAB_AI_SERVICE_TOKEN: clipboardToken,
      OA_PRODUCTION_RELEASE_CONFIRM: `${validProductionEnvironment.OA_PRODUCTION_WORKER_NAME}:${validProductionEnvironment.OA_PRODUCTION_D1_DATABASE_ID}:${new URL(validProductionEnvironment.OA_PRODUCTION_PUBLIC_ORIGIN).hostname}`,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "1",
    },
  });
  assert.notEqual(clipboardTokenRun.status, 64);
  assert.doesNotMatch(clipboardTokenRun.stderr, /PUBLIC_LAB_AI_SERVICE_TOKEN must/u);
  assert.ok(!`${clipboardTokenRun.stdout}${clipboardTokenRun.stderr}`.includes("A".repeat(43)));

  const internalWhitespaceToken = `${"A".repeat(21)}\n${"A".repeat(22)}`;
  const internalWhitespaceRun = spawnSync("/bin/bash", [join(projectRoot, "scripts", "release-production.sh"), "production"], {
    encoding: "utf8",
    env: {
      PATH: "/nonexistent",
      ...validProductionEnvironment,
      CLOUDFLARE_ACCOUNT_ID: validProductionEnvironment.OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "test-token",
      PUBLIC_LAB_AI_SERVICE_TOKEN: internalWhitespaceToken,
      OA_PRODUCTION_RELEASE_CONFIRM: `${validProductionEnvironment.OA_PRODUCTION_WORKER_NAME}:${validProductionEnvironment.OA_PRODUCTION_D1_DATABASE_ID}:${new URL(validProductionEnvironment.OA_PRODUCTION_PUBLIC_ORIGIN).hostname}`,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "1",
    },
  });
  assert.notEqual(internalWhitespaceRun.status, 64);
  assert.doesNotMatch(internalWhitespaceRun.stderr, /PUBLIC_LAB_AI_SERVICE_TOKEN (?:must|is missing)/u);
  assert.ok(!`${internalWhitespaceRun.stdout}${internalWhitespaceRun.stderr}`.includes(internalWhitespaceToken));

  const missingTokenRun = spawnSync("/bin/bash", [join(projectRoot, "scripts", "release-production.sh"), "production"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...validProductionEnvironment,
      CLOUDFLARE_ACCOUNT_ID: validProductionEnvironment.OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "test-token",
      PUBLIC_LAB_AI_SERVICE_TOKEN: " \r\n ",
      OA_PRODUCTION_RELEASE_CONFIRM: `${validProductionEnvironment.OA_PRODUCTION_WORKER_NAME}:${validProductionEnvironment.OA_PRODUCTION_D1_DATABASE_ID}:${new URL(validProductionEnvironment.OA_PRODUCTION_PUBLIC_ORIGIN).hostname}`,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "1",
    },
  });
  assert.equal(missingTokenRun.status, 64);
  assert.match(missingTokenRun.stderr, /PUBLIC_LAB_AI_SERVICE_TOKEN is required/u);

  assert.match(releaseScript, /run_wrangler deploy --dry-run --strict --keep-vars --config/u);
  assert.match(releaseScript, /run_wrangler deploy --strict --keep-vars --config/u);
  assert.match(releaseScript, /\^\[A-Za-z0-9_-\]\{43\}\$/u);
  assert.match(releaseScript, /normalize-public-lab-ai-service-token\.mjs/u);
  assert.match(releaseScript, /printf '%s' "\$\{public_lab_ai_service_token\}"[\s\\]*\| run_wrangler secret put PUBLIC_LAB_AI_SERVICE_TOKEN/u);
  assert.equal([...releaseScript.matchAll(/secret put PUBLIC_LAB_AI_SERVICE_TOKEN/gu)].length, 1);
  assert.equal([...releaseScript.matchAll(/--allow-missing-public-lab-ai-service-token true/gu)].length, 1);
  assert.ok(releaseScript.indexOf("target-before.json") < releaseScript.indexOf("secret put PUBLIC_LAB_AI_SERVICE_TOKEN"));
  assert.ok(releaseScript.indexOf("check-production-migration-state.mjs\" before") < releaseScript.indexOf("secret put PUBLIC_LAB_AI_SERVICE_TOKEN"));
  assert.ok(releaseScript.indexOf("target-secret-configured.json") < releaseScript.indexOf("deploy --dry-run --strict"));
  assert.match(releaseScript, /d1 time-travel info DB/u);
  assert.equal([...releaseScript.matchAll(/apply-production-d1-migrations\.mjs/gu)].length, 1);
  assert.ok(releaseScript.indexOf("d1 time-travel info DB") < releaseScript.indexOf("apply-production-d1-migrations.mjs"));
  assert.ok(releaseScript.indexOf("apply-production-d1-migrations.mjs") < releaseScript.indexOf("check-production-migration-state.mjs\" after"));
  assert.doesNotMatch(releaseScript, /d1 migrations apply DB/u);
  assert.doesNotMatch(releaseScript, /run_wrangler\s+(?:rollback|d1 time-travel restore)\b/u);
});

test("production smoke uses the injected origin and keeps its POST probe unauthenticated and non-mutating", () => {
  assert.match(smokeScript, /productionTarget\(process\.env\)\.publicOrigin/u);
  assert.match(smokeScript, /request\("\/api\/session"/u);
  assert.match(smokeScript, /实验室 AI（内部）/u);
  assert.match(smokeScript, /chat\.omindos\.ai/u);
  assert.match(smokeScript, /\/api\/lab-ai\/ask/u);
  assert.doesNotMatch(smokeScript, /ARTS Robotics AI assistant/u);
  assert.match(smokeScript, /request\("\/api\/public\/lab-ai\/retrieve"/u);
  assert.equal([...smokeScript.matchAll(/method:\s*"POST"/gu)].length, 1);
  assert.match(smokeScript, /publicRetrieveAnonymousResponse\.status !== 401/u);
  assert.match(smokeScript, /publicRetrieveAnonymousStatus:\s*401/u);
  assert.match(smokeScript, /access-control-allow-origin/u);
  assert.match(smokeScript, /access-control-allow-credentials/u);
  assert.doesNotMatch(smokeScript, /x-originmind-public-lab-ai-service-token|PUBLIC_LAB_AI_SERVICE_TOKEN/u);
  assert.doesNotMatch(smokeScript, /method:\s*["'](?:PUT|PATCH|DELETE)["']/u);
});
