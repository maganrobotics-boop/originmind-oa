import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { MIGRATION_SCHEMA_EXPECTED_OBJECT_COUNTS, migrationLedgerSelectSql, migrationNamesFromLedger, migrationSchemaFingerprint, migrationSchemaSelectSql } from "../lib/migration-export.mjs";
import { deploymentTarget } from "../lib/standalone-config.mjs";

const execute = promisify(execFile);
const configPath = resolve(process.argv[2] || ".wrangler/generated/wrangler.staging.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const expected = deploymentTarget("staging", process.env);
const database = config.d1_databases?.find((entry) => entry.binding === "DB");
const expectedAccountId = process.env.OA_STAGING_CLOUDFLARE_ACCOUNT_ID?.trim().toLowerCase();
const expectedDatabaseId = process.env.OA_STAGING_D1_DATABASE_ID?.trim().toLowerCase();
if (!expectedAccountId || !expectedDatabaseId
  || config.account_id !== expectedAccountId
  || config.name !== expected.workerName
  || database?.database_name !== expected.databaseName
  || database?.database_id !== expectedDatabaseId) throw new Error("Staging schema fingerprint refused an unverified account or D1 target");

const wranglerPath = resolve("node_modules/.bin/wrangler");
async function query(sql) {
  const { stdout } = await execute(wranglerPath, [
    "d1", "execute", "DB", "--remote", "--config", configPath,
    "--command", sql, "--json",
  ], { cwd: resolve("."), maxBuffer: 4 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

migrationNamesFromLedger(await query(migrationLedgerSelectSql()));
const schema = await query(migrationSchemaSelectSql());
const counts = (schema.results || []).reduce((totals, row) => ({
  ...totals,
  [row.type]: (totals[row.type] || 0) + 1,
}), {});
if (counts.table !== MIGRATION_SCHEMA_EXPECTED_OBJECT_COUNTS.table
  || counts.index !== MIGRATION_SCHEMA_EXPECTED_OBJECT_COUNTS.index
  || counts.trigger !== MIGRATION_SCHEMA_EXPECTED_OBJECT_COUNTS.trigger
  || schema.results?.length !== MIGRATION_SCHEMA_EXPECTED_OBJECT_COUNTS.total) {
  throw new Error("Staging schema projection does not contain the exact expected table, index, and trigger set");
}
process.stdout.write(`${await migrationSchemaFingerprint(schema)}\n`);
