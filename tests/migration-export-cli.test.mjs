import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildMigrationPayload,
  canonicalJson,
  encryptMigrationPayload,
  MIGRATION_APPLICATION_TABLES,
  MIGRATION_EXPORT_TABLES,
  MIGRATION_EXPORT_EXPECTED_MIGRATIONS,
  migrationSchemaFingerprint,
} from "../lib/migration-export.mjs";

const execute = promisify(execFile);
const root = new URL("..", import.meta.url);

function schemaResult() {
  return {
    success: true,
    results: MIGRATION_APPLICATION_TABLES.map((table) => ({ type: "table", name: table, tbl_name: table, sql: `CREATE TABLE ${table} (...)` })),
  };
}

function emptyBatchResults(writeFrozenAt = new Date(Date.now() - 20 * 60_000).toISOString()) {
  return [
    { success: true, results: MIGRATION_EXPORT_EXPECTED_MIGRATIONS.map((name, index) => ({ id: index + 1, name })) },
    schemaResult(),
    { success: true, results: [{ write_frozen_at: writeFrozenAt, ready: 1 }] },
    { success: true, results: [{ active_count: 0 }] },
    ...MIGRATION_EXPORT_TABLES.map(() => ({ success: true, results: [] })),
  ];
}

async function runDecrypt({ input, privateKey, authKey, output }) {
  return execute(process.execPath, [
    fileURLToPath(new URL("scripts/decrypt-migration-export.mjs", root)),
    "--input", input,
    "--private-key", privateKey,
    "--auth-key-file", authKey,
    "--expected-origin", "https://oa.example.test",
    "--output", output,
  ]);
}

test("credential generator and decryptor keep secrets private and reject expired archives", async () => {
  const parent = await mkdtemp(join(tmpdir(), "originmind-migration-cli-"));
  const credentials = join(parent, "credentials");
  const generated = await execute(process.execPath, [fileURLToPath(new URL("scripts/generate-migration-export-credentials.mjs", root)), credentials]);
  const privateKeyPath = join(credentials, "private-key.jwk");
  const publicKeyPath = join(credentials, "public-key.jwk");
  const authKeyPath = join(credentials, "auth-key.txt");
  const freezeIdPath = join(credentials, "freeze-id.txt");
  if (process.platform !== "win32") {
    for (const path of [privateKeyPath, publicKeyPath, authKeyPath, freezeIdPath]) {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    assert.equal((await stat(credentials)).mode & 0o777, 0o700);
  }
  const [privateKey, publicKey, authKey] = await Promise.all([
    readFile(privateKeyPath, "utf8").then(JSON.parse),
    readFile(publicKeyPath, "utf8").then(JSON.parse),
    readFile(authKeyPath, "utf8").then((value) => value.trim()),
  ]);
  assert.doesNotMatch(generated.stdout, new RegExp(authKey, "u"));
  assert.doesNotMatch(generated.stdout, new RegExp(privateKey.d, "u"));
  assert.match((await readFile(freezeIdPath, "utf8")).trim(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);

  const now = Date.now();
  const expectedSchemaSha256 = await migrationSchemaFingerprint(schemaResult());
  const payload = await buildMigrationPayload({
    sourceOrigin: "https://oa.example.test",
    authKey,
    freezeId: "11111111-2222-4333-8444-555555555555",
    notBefore: new Date(now - 60_000).toISOString(),
    notAfter: new Date(now + 30 * 60_000).toISOString(),
    expectedSchemaSha256,
    batchResults: emptyBatchResults(),
    exportedAt: new Date(now).toISOString(),
  });
  const archivePath = join(parent, "migration.json.enc");
  await writeFile(archivePath, canonicalJson(await encryptMigrationPayload(payload, publicKey)), { mode: 0o600 });
  const outputPath = join(parent, "migration.json");
  const decrypted = await runDecrypt({ input: archivePath, privateKey: privateKeyPath, authKey: authKeyPath, output: outputPath });
  assert.match(decrypted.stdout, /14 tables \(0 rows\)/u);
  if (process.platform !== "win32") assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(outputPath, "utf8")).endsWith("\n"), false);

  const expiredPayload = await buildMigrationPayload({
    sourceOrigin: "https://oa.example.test",
    authKey,
    freezeId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    notBefore: new Date(now - 60 * 60_000).toISOString(),
    notAfter: new Date(now - 30 * 60_000).toISOString(),
    expectedSchemaSha256,
    batchResults: emptyBatchResults(new Date(now - 80 * 60_000).toISOString()),
    exportedAt: new Date(now - 45 * 60_000).toISOString(),
  });
  const expiredArchivePath = join(parent, "expired.json.enc");
  await writeFile(expiredArchivePath, canonicalJson(await encryptMigrationPayload(expiredPayload, publicKey)), { mode: 0o600 });
  const rejectedOutputPath = join(parent, "expired.json");
  await assert.rejects(
    runDecrypt({ input: expiredArchivePath, privateKey: privateKeyPath, authKey: authKeyPath, output: rejectedOutputPath }),
    /window has expired/u,
  );
  await assert.rejects(stat(rejectedOutputPath), { code: "ENOENT" });
});

test("credential generator resolves parent symlinks before its worktree check", { skip: process.platform === "win32" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "originmind-migration-symlink-"));
  const link = join(parent, "worktree-link");
  await symlink(fileURLToPath(new URL("..", import.meta.url)), link, "dir");
  await assert.rejects(
    execute(process.execPath, [fileURLToPath(new URL("scripts/generate-migration-export-credentials.mjs", root)), join(link, "credentials")]),
    /outside the Git worktree/u,
  );
});

test("credential generator refuses to place migration secrets in the Git worktree", async () => {
  const forbiddenPath = fileURLToPath(new URL(`../.migration-secret-test-${process.pid}`, import.meta.url));
  await assert.rejects(
    execute(process.execPath, [fileURLToPath(new URL("scripts/generate-migration-export-credentials.mjs", root)), forbiddenPath]),
    /outside the Git worktree/u,
  );
  await assert.rejects(stat(forbiddenPath), { code: "ENOENT" });
});
