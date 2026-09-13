import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

import {
  decryptMigrationEnvelope,
  encryptMigrationPayload,
  MIGRATION_APPLICATION_TABLES,
  MIGRATION_EXPORT_MAX_PLAINTEXT_BYTES,
  MIGRATION_EXPORT_TABLES,
  MIGRATION_EXPORT_EXPECTED_MIGRATIONS,
  migrationArchiveActivitySelectSql,
  migrationFreezeMarkerSelectSql,
  migrationLedgerSelectSql,
  migrationSchemaFingerprint,
  migrationSchemaSelectSql,
  migrationExportSelectSql,
  parseCanonicalMigrationJson,
  verifyFreshMigrationPayload,
  verifyMigrationPayload,
} from "../lib/migration-export.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaMigrationExportTestState";
const originalEnvironment = Object.fromEntries([
  "OA_MIGRATION_EXPORT_ENABLED",
  "OA_MIGRATION_EXPORT_NOT_BEFORE",
  "OA_MIGRATION_EXPORT_NOT_AFTER",
  "OA_MIGRATION_EXPORT_AUTH_KEY",
  "OA_MIGRATION_EXPORT_EXPECTED_SCHEMA_SHA256",
  "OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK",
  "OA_MIGRATION_FREEZE_ID",
  "OA_MIGRATION_WRITE_FROZEN",
  "OA_PUBLIC_ORIGIN",
].map((key) => [key, process.env[key]]));

const keyPair = await crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["encrypt", "decrypt"],
);
const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
publicKeyJwk.alg = "RSA-OAEP-256";
publicKeyJwk.use = "enc";
publicKeyJwk.key_ops = ["encrypt"];
privateKeyJwk.alg = "RSA-OAEP-256";
privateKeyJwk.use = "enc";
privateKeyJwk.key_ops = ["decrypt"];
const authKey = Buffer.alloc(32, 0x5a).toString("base64url");

function valueFor(tableName, column, index) {
  if (tableName === "members" && column === "id") return "member-admin";
  if (tableName === "members" && column === "status") return "active";
  if (tableName === "members" && column === "account_user_id") return "email:admin@example.com";
  if (tableName === "auth_identities" && column === "member_id") return "member-admin";
  if (tableName === "auth_identities" && column === "provider") return "github";
  if (tableName === "auth_identities" && column === "provider_subject") return "583231";
  if (tableName === "auth_identities" && column === "unlinked_at") return null;
  if (column === "current_revision_no" || column === "revision_no" || column === "part_no") return index + 1;
  if (column === "id" && (tableName === "approval_events" || tableName === "member_events")) return index + 1;
  if (column === "payload_json") return JSON.stringify({ exactLongText: "迁移长文本".repeat(2_500) });
  if (column === "state_json") return JSON.stringify({ signedState: "签名状态".repeat(2_200) });
  if (column === "avatar_data_url") return `data:image/png;base64,${"A".repeat(8_000)}`;
  return `${tableName}:${column}:${index}`;
}

function successfulBatchResults() {
  return [
    ledgerResult,
    schemaResult,
    { success: true, results: [{ write_frozen_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(), ready: 1 }] },
    { success: true, results: [{ active_count: 0 }] },
    ...MIGRATION_EXPORT_TABLES.map((table, tableIndex) => ({
      success: true,
      results: table.name === "knowledge_chunks"
        ? []
        : [Object.fromEntries(table.columns.map((column) => [column, valueFor(table.name, column, tableIndex)]))],
    })),
  ];
}

function tableRow(tableName, overrides = {}, index = 0) {
  const table = MIGRATION_EXPORT_TABLES.find((candidate) => candidate.name === tableName);
  return {
    ...Object.fromEntries(table.columns.map((column) => [column, valueFor(table.name, column, index)])),
    ...overrides,
  };
}

const ledgerResult = {
  success: true,
  results: MIGRATION_EXPORT_EXPECTED_MIGRATIONS.map((name, index) => ({ id: index + 1, name })),
};

const schemaResult = {
  success: true,
  results: MIGRATION_APPLICATION_TABLES.map((table) => ({ type: "table", name: table, tbl_name: table, sql: `CREATE TABLE ${table} (...)` })),
};
const schemaSha256 = await migrationSchemaFingerprint(schemaResult);

function initialState(overrides = {}) {
  return {
    authorized: { isAdmin: true, memberId: "member-admin", accountUserId: "email:admin@example.com", ndaCompleted: true },
    authCalls: 0,
    authOptions: [],
    batchCalls: 0,
    batchResults: successfulBatchResults(),
    preparedSql: [],
    ...overrides,
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
    name: "migration-export-test-dependencies",
    enforce: "pre",
    resolveId(source) {
      if (source === "cloudflare:workers") return "\0migration-export-cloudflare";
      if (/(^|\/)api\/_lib\/auth$/u.test(source) || /(^|\/)\.\.\/\.\.\/_lib\/auth$/u.test(source)) return "\0migration-export-auth";
      return null;
    },
    load(id) {
      if (id === "\0migration-export-cloudflare") return `
        export const env = {
          DB: {
            prepare(sql) {
              globalThis.${stateKey}.preparedSql.push(sql);
              return {
                sql,
                bind() { return this; },
                async all() {
                  if (!sql.includes("FROM sqlite_master")) throw new Error("Unexpected standalone metadata query");
                  return { success: true, results: [{ name: "d1_migrations", sql: "CREATE TABLE d1_migrations (...)" }] };
                },
              };
            },
            async batch() {
              globalThis.${stateKey}.batchCalls += 1;
              return globalThis.${stateKey}.batchResults;
            },
          },
        };
      `;
      if (id === "\0migration-export-auth") return `
        export async function getAuthorizedUser(options) {
          globalThis.${stateKey}.authCalls += 1;
          globalThis.${stateKey}.authOptions.push(options);
          return globalThis.${stateKey}.authorized;
        }
      `;
      return null;
    },
  }],
});

const route = await vite.ssrLoadModule("/app/api/admin/migration-export/route.ts");

after(async () => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete globalThis[stateKey];
  await vite.close();
});

function configureEnabled() {
  process.env.OA_MIGRATION_EXPORT_ENABLED = "true";
  process.env.OA_MIGRATION_WRITE_FROZEN = "true";
  process.env.OA_MIGRATION_FREEZE_ID = "11111111-2222-4333-8444-555555555555";
  process.env.OA_MIGRATION_EXPORT_NOT_BEFORE = new Date(Date.now() - 60 * 1000).toISOString();
  process.env.OA_MIGRATION_EXPORT_NOT_AFTER = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  process.env.OA_MIGRATION_EXPORT_AUTH_KEY = authKey;
  process.env.OA_MIGRATION_EXPORT_EXPECTED_SCHEMA_SHA256 = schemaSha256;
  process.env.OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK = JSON.stringify(publicKeyJwk);
  process.env.OA_PUBLIC_ORIGIN = "https://oa.example.test";
}

function reset(overrides) {
  configureEnabled();
  globalThis[stateKey] = initialState(overrides);
  return globalThis[stateKey];
}

function exportRequest(headers = {}) {
  return new Request("https://oa.example.test/api/admin/migration-export", {
    method: "POST",
    headers: { origin: "https://oa.example.test", "sec-fetch-site": "same-origin", ...headers },
  });
}

test("migration export is indistinguishable from a missing route while disabled or expired", async () => {
  const state = reset();
  process.env.OA_MIGRATION_EXPORT_ENABLED = "false";
  let response = await route.POST(exportRequest());
  assert.equal(response.status, 404);
  process.env.OA_MIGRATION_EXPORT_ENABLED = "true";
  process.env.OA_MIGRATION_EXPORT_NOT_AFTER = new Date(Date.now() - 1_000).toISOString();
  response = await route.POST(exportRequest());
  assert.equal(response.status, 404);
  assert.equal(state.authCalls, 0);
  assert.equal(state.batchCalls, 0);
});

test("migration export stays closed until the write freeze has drained in-flight requests", async () => {
  const batchResults = successfulBatchResults();
  batchResults[2] = { success: true, results: [{ write_frozen_at: new Date(Date.now() - 60 * 1000).toISOString(), ready: 0 }] };
  const state = reset({ batchResults });
  const response = await route.POST(exportRequest());
  assert.equal(response.status, 500);
  assert.equal(state.authCalls, 1);
  assert.deepEqual(state.authOptions, [{ readOnly: true }]);
  assert.equal(state.batchCalls, 1);
});

test("migration export refuses a snapshot while an external archive request is still active", async () => {
  const batchResults = successfulBatchResults();
  batchResults[3] = { success: true, results: [{ active_count: 1 }] };
  const state = reset({ batchResults });
  const response = await route.POST(exportRequest());
  assert.equal(response.status, 500);
  assert.equal(state.batchCalls, 1);
  assert.match(migrationArchiveActivitySelectSql(), /status = 'pending'/u);
  assert.doesNotMatch(migrationArchiveActivitySelectSql(), /lease_expires_at/u);
});

test("migration export rejects cross-origin and non-admin requests before reading D1", async () => {
  let state = reset();
  let response = await route.POST(exportRequest({ origin: "https://evil.example" }));
  assert.equal(response.status, 403);
  assert.equal(state.authCalls, 0);
  assert.equal(state.batchCalls, 0);

  state = reset({ authorized: { isAdmin: false, memberId: "member-admin", accountUserId: "email:admin@example.com", ndaCompleted: true } });
  response = await route.POST(exportRequest());
  assert.equal(response.status, 403);
  assert.equal(state.authCalls, 1);
  assert.deepEqual(state.authOptions, [{ readOnly: true }]);
  assert.equal(state.batchCalls, 0);
});

test("admin receives an authenticated encrypted snapshot with exact long values", async () => {
  const state = reset();
  const response = await route.POST(exportRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.match(response.headers.get("content-disposition") || "", /^attachment; filename="originmind-oa-migration-/u);
  assert.equal(response.headers.get("content-type"), "application/vnd.originmind.oa-migration+json");
  assert.deepEqual(state.preparedSql, [
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE '%migration%' ORDER BY name",
    migrationLedgerSelectSql(),
    migrationSchemaSelectSql(),
    migrationFreezeMarkerSelectSql(),
    migrationArchiveActivitySelectSql(),
    ...MIGRATION_EXPORT_TABLES.map(migrationExportSelectSql),
  ]);
  assert.equal(state.batchCalls, 1);
  assert.deepEqual(state.authOptions, [{ readOnly: true }]);

  const serializedEnvelope = await response.text();
  assert.doesNotMatch(serializedEnvelope, /迁移长文本/u);
  assert.doesNotMatch(serializedEnvelope, new RegExp(authKey, "u"));
  const payload = await decryptMigrationEnvelope(JSON.parse(serializedEnvelope), privateKeyJwk);
  await verifyMigrationPayload(payload, { expectedAuthKey: authKey, expectedSourceOrigin: "https://oa.example.test" });
  const approvals = payload.tables.find((table) => table.name === "approvals");
  const payloadIndex = approvals.columns.indexOf("payload_json");
  assert.equal(approvals.rows[0][payloadIndex], valueFor("approvals", "payload_json", 0));
  const revisions = payload.tables.find((table) => table.name === "approval_revisions");
  const stateIndex = revisions.columns.indexOf("state_json");
  assert.equal(revisions.rows[0][stateIndex], valueFor("approval_revisions", "state_json", 2));
  const knowledgeParts = payload.tables.find((table) => table.name === "knowledge_revision_parts");
  assert.deepEqual(knowledgeParts.columns, ["id", "item_id", "revision_id", "part_no", "content", "created_at"]);
  assert.equal(knowledgeParts.rows[0][knowledgeParts.columns.indexOf("content")], valueFor("knowledge_revision_parts", "content", 12));
  assert.deepEqual(payload.derivedTables, ["knowledge_chunks"]);
  assert.equal(payload.tables.find((table) => table.name === "knowledge_chunks").rowCount, 0);
  assert.equal(MIGRATION_EXPORT_MAX_PLAINTEXT_BYTES, 48 * 1024 * 1024);
  assert.equal("challenge" in payload, false);
});

test("historical retired-provider identities remain in the encrypted snapshot", async () => {
  const batchResults = successfulBatchResults();
  const identityTableIndex = MIGRATION_EXPORT_TABLES.findIndex((table) => table.name === "auth_identities") + 4;
  batchResults[identityTableIndex].results.push(tableRow("auth_identities", {
    id: "identity-retired-history",
    member_id: "member-admin",
    provider: "feishu",
    provider_subject: "cli_old_app:tenant_old:ou_history_1234",
    login_snapshot: "ou_history_1234",
    unlinked_at: "2026-09-04T00:00:00.000Z",
  }, 25));
  reset({ batchResults });

  const response = await route.POST(exportRequest());
  assert.equal(response.status, 200);
  const payload = await decryptMigrationEnvelope(JSON.parse(await response.text()), privateKeyJwk);
  const identities = payload.tables.find((table) => table.name === "auth_identities");
  const idIndex = identities.columns.indexOf("id");
  assert.ok(identities.rows.some((row) => row[idIndex] === "identity-retired-history"));
});

test("wrong local authentication key cannot accept a public-key-encrypted forgery", async () => {
  reset();
  const response = await route.POST(exportRequest());
  const payload = await decryptMigrationEnvelope(JSON.parse(await response.text()), privateKeyJwk);
  await assert.rejects(
    verifyMigrationPayload(payload, { expectedAuthKey: Buffer.alloc(32, 0x22).toString("base64url"), expectedSourceOrigin: "https://oa.example.test" }),
    /source authentication failed/u,
  );
});

test("the public encryption key cannot forge source authentication", async () => {
  reset();
  const response = await route.POST(exportRequest());
  const payload = await decryptMigrationEnvelope(JSON.parse(await response.text()), privateKeyJwk);
  const forgedEnvelope = await encryptMigrationPayload({ ...payload, sourceHmacSha256: "0".repeat(64) }, publicKeyJwk);
  const forgedPayload = await decryptMigrationEnvelope(forgedEnvelope, privateKeyJwk);
  await assert.rejects(
    verifyMigrationPayload(forgedPayload, { expectedAuthKey: authKey, expectedSourceOrigin: "https://oa.example.test" }),
    /source authentication failed/u,
  );
});

test("envelope ciphertext, IV, wrapped key, and private-key substitutions are rejected", async () => {
  reset();
  const response = await route.POST(exportRequest());
  const envelope = JSON.parse(await response.text());
  const mutate = (value) => `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
  for (const field of ["ciphertext", "iv", "wrappedKey"]) {
    await assert.rejects(decryptMigrationEnvelope({ ...envelope, [field]: mutate(envelope[field]) }, privateKeyJwk));
  }
  const otherPair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  const otherPrivateKey = await crypto.subtle.exportKey("jwk", otherPair.privateKey);
  await assert.rejects(decryptMigrationEnvelope(envelope, otherPrivateKey));
});

test("migration JSON rejects excessive nesting before recursive canonicalization", () => {
  const nested = `${"[".repeat(65)}null${"]".repeat(65)}`;
  assert.throws(() => parseCanonicalMigrationJson(nested), /nesting is too deep/u);
});

test("verified exports cannot be replayed after their short migration window", async () => {
  reset();
  const response = await route.POST(exportRequest());
  const payload = await decryptMigrationEnvelope(JSON.parse(await response.text()), privateKeyJwk);
  await assert.rejects(
    verifyFreshMigrationPayload(payload, { expectedAuthKey: authKey, expectedSourceOrigin: "https://oa.example.test" }, Date.parse(payload.windowNotAfter) + 5 * 60 * 1000 + 1),
    /window has expired/u,
  );
});

test("export requires an active GitHub identity for the active administrator", async () => {
  const batchResults = successfulBatchResults();
  const identityTableIndex = MIGRATION_EXPORT_TABLES.findIndex((table) => table.name === "auth_identities") + 4;
  batchResults[identityTableIndex] = { success: true, results: [] };
  const state = reset({ batchResults });
  const response = await route.POST(exportRequest());
  assert.equal(response.status, 500);
  assert.equal(state.batchCalls, 1);

  const retiredOnlyResults = successfulBatchResults();
  const retiredIdentityIndex = MIGRATION_EXPORT_TABLES.findIndex((table) => table.name === "auth_identities") + 4;
  Object.assign(retiredOnlyResults[retiredIdentityIndex].results[0], {
    provider: "feishu",
    provider_subject: "cli_old_app:tenant_old:ou_history_1234",
    login_snapshot: "ou_history_1234",
    unlinked_at: "2026-09-04T00:00:00.000Z",
  });
  const retiredOnlyState = reset({ batchResults: retiredOnlyResults });
  const retiredOnlyResponse = await route.POST(exportRequest());
  assert.equal(retiredOnlyResponse.status, 500);
  assert.equal(retiredOnlyState.batchCalls, 1);
});

test("export pins the administrator account subject and validates provider subjects", async () => {
  let batchResults = successfulBatchResults();
  const memberTableIndex = MIGRATION_EXPORT_TABLES.findIndex((table) => table.name === "members") + 4;
  const memberAccountIndex = MIGRATION_EXPORT_TABLES.find((table) => table.name === "members").columns.indexOf("account_user_id");
  batchResults[memberTableIndex].results[0].account_user_id = "email:another@example.com";
  let state = reset({ batchResults });
  let response = await route.POST(exportRequest());
  assert.equal(response.status, 500);
  assert.equal(state.batchCalls, 1);

  batchResults = successfulBatchResults();
  const identityTableIndex = MIGRATION_EXPORT_TABLES.findIndex((table) => table.name === "auth_identities") + 4;
  batchResults[identityTableIndex].results[0].provider_subject = "github-login-name";
  state = reset({ batchResults });
  response = await route.POST(exportRequest());
  assert.equal(response.status, 500);
  assert.equal(state.batchCalls, 1);
  assert.ok(memberAccountIndex >= 0);
});

test("a source database still on migration 0025 is rejected", async () => {
  const batchResults = successfulBatchResults();
  batchResults[0] = { success: true, results: ledgerResult.results.slice(0, -1) };
  const state = reset({ batchResults });
  const response = await route.POST(exportRequest());
  assert.equal(response.status, 500);
  assert.equal(state.batchCalls, 1);
});

test("incomplete D1 batch and unsafe export configuration fail closed", async () => {
  let state = reset({ batchResults: successfulBatchResults().slice(1) });
  let response = await route.POST(exportRequest());
  assert.equal(response.status, 500);
  assert.equal(state.batchCalls, 1);

  state = reset();
  process.env.OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK = JSON.stringify({ ...publicKeyJwk, d: "private" });
  response = await route.POST(exportRequest());
  assert.equal(response.status, 500);
  assert.equal(state.batchCalls, 0);
  assert.doesNotMatch(await response.text(), /private|JWK|RSA/u);

  state = reset();
  const paddedModulus = Buffer.concat([Buffer.from([0]), Buffer.from(publicKeyJwk.n, "base64url")]).toString("base64url");
  process.env.OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK = JSON.stringify({ ...publicKeyJwk, n: paddedModulus });
  response = await route.POST(exportRequest());
  assert.equal(response.status, 500);
  assert.equal(state.batchCalls, 0);

  state = reset();
  process.env.OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK = JSON.stringify({ ...publicKeyJwk, n: Buffer.alloc(128, 0xff).toString("base64url") });
  response = await route.POST(exportRequest());
  assert.equal(response.status, 500);
  assert.equal(state.batchCalls, 0);

  state = reset();
  process.env.OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK = JSON.stringify({ ...publicKeyJwk, e: "AQ" });
  response = await route.POST(exportRequest());
  assert.equal(response.status, 500);
  assert.equal(state.batchCalls, 0);

  state = reset();
  const evenModulus = Buffer.from(publicKeyJwk.n, "base64url");
  evenModulus[evenModulus.length - 1] &= 0xfe;
  process.env.OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK = JSON.stringify({ ...publicKeyJwk, n: evenModulus.toString("base64url") });
  response = await route.POST(exportRequest());
  assert.equal(response.status, 500);
  assert.equal(state.batchCalls, 0);
});
