import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  productionKnowledgeDefinitions,
  validateProductionMigrationManifest,
  validateProductionMigrationState,
} from "../lib/production-release.mjs";

function parseArguments(values) {
  const [phase, ...pairs] = values;
  const options = {};
  for (let index = 0; index < pairs.length; index += 2) {
    const key = pairs[index];
    const value = pairs[index + 1];
    if (!key?.startsWith("--") || !value || options[key.slice(2)]) throw new Error("Invalid production migration check arguments");
    options[key.slice(2)] = value;
  }
  const allowed = ["ledger", "freeze", "schema", "migrations-dir"];
  if (
    (phase !== "before" && phase !== "after")
    || allowed.some((key) => !options[key])
    || Object.keys(options).some((key) => !allowed.includes(key))
  ) throw new Error("Usage: check-production-migration-state.mjs before|after --ledger <json> --freeze <json> --schema <json> --migrations-dir <directory>");
  return { phase, options };
}

const { phase, options } = parseArguments(process.argv.slice(2));
const drizzleRoot = resolve(options["migrations-dir"]);
const migrationEntries = await readdir(drizzleRoot, { withFileTypes: true });
const sqlEntries = migrationEntries.filter((entry) => entry.name.endsWith(".sql"));
if (sqlEntries.some((entry) => !entry.isFile())) throw new Error("Every production migration must be a regular file, not a symlink or special file");
const migrationSqlByName = Object.fromEntries(await Promise.all([
  "0026_rich_jocasta.sql",
  "0027_careless_winter_soldier.sql",
  "0028_needy_microchip.sql",
  "0029_knowledge_visibility_reclassification.sql",
  "0030_large_knowledge_revision_parts.sql",
].map(async (name) => [name, await readFile(resolve(drizzleRoot, name), "utf8")])));
const expectedMigrationNames = validateProductionMigrationManifest({
  migrationNames: sqlEntries.map((entry) => entry.name).sort(),
  migrationSqlByName,
});
const migration26KnowledgeDefinitions = productionKnowledgeDefinitions(migrationSqlByName, ["0026_rich_jocasta.sql"]);
const migration27KnowledgeDefinitions = productionKnowledgeDefinitions(migrationSqlByName, [
  "0026_rich_jocasta.sql",
  "0027_careless_winter_soldier.sql",
]);
const migration28KnowledgeDefinitions = productionKnowledgeDefinitions(migrationSqlByName, [
  "0026_rich_jocasta.sql",
  "0027_careless_winter_soldier.sql",
  "0028_needy_microchip.sql",
]);
const migration29KnowledgeDefinitions = productionKnowledgeDefinitions(migrationSqlByName, [
  "0026_rich_jocasta.sql",
  "0027_careless_winter_soldier.sql",
  "0028_needy_microchip.sql",
  "0029_knowledge_visibility_reclassification.sql",
]);
const expectedKnowledgeDefinitions = productionKnowledgeDefinitions(migrationSqlByName);
const [ledgerPayload, freezePayload, schemaPayload] = await Promise.all([
  readFile(resolve(options.ledger), "utf8").then(JSON.parse),
  readFile(resolve(options.freeze), "utf8").then(JSON.parse),
  readFile(resolve(options.schema), "utf8").then(JSON.parse),
]);

const state = validateProductionMigrationState({
  phase,
  ledgerPayload,
  freezePayload,
  schemaPayload,
  expectedMigrationNames,
  expectedSchemaObjects: [
    ...Object.keys(expectedKnowledgeDefinitions),
    "index:notification_outbox_due",
    "table:notification_control",
    "table:notification_outbox",
  ].sort(),
  expectedKnowledgeDefinitions,
  migration26KnowledgeDefinitions,
  migration27KnowledgeDefinitions,
  migration28KnowledgeDefinitions,
  migration29KnowledgeDefinitions,
});
process.stdout.write(`${state}\n`);
