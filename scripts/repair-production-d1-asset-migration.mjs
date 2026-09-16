import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { d1QueryRows } from "../lib/production-release.mjs";

const ASSET_OBJECTS = new Set([
  "table:knowledge_revision_assets",
  "index:knowledge_revision_assets_item_revision_idx",
  "index:knowledge_revision_assets_revision_path_unique",
  "index:knowledge_revision_assets_storage_key_unique",
  "index:knowledge_revision_assets_upload_idx",
  "trigger:knowledge_revision_assets_immutable",
  "trigger:knowledge_revision_assets_pending_insert",
  "trigger:knowledge_revision_assets_validate_insert",
]);

const DROP_ORDER = [
  ["trigger", "knowledge_revision_assets_pending_insert"],
  ["trigger", "knowledge_revision_assets_immutable"],
  ["trigger", "knowledge_revision_assets_validate_insert"],
  ["index", "knowledge_revision_assets_upload_idx"],
  ["index", "knowledge_revision_assets_item_revision_idx"],
  ["index", "knowledge_revision_assets_storage_key_unique"],
  ["index", "knowledge_revision_assets_revision_path_unique"],
  ["table", "knowledge_revision_assets"],
];

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || options[key.slice(2)]) throw new Error("Invalid production partial migration repair arguments");
    options[key.slice(2)] = value;
  }
  const allowed = ["ledger", "freeze", "schema", "config", "wrangler"];
  if (allowed.some((key) => !options[key]) || Object.keys(options).some((key) => !allowed.includes(key))) {
    throw new Error("Usage: repair-production-d1-asset-migration.mjs --ledger <json> --freeze <json> --schema <json> --config <wrangler.json> --wrangler <path>");
  }
  return options;
}

function sqlIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error("Unsafe SQL identifier");
  return "`" + value + "`";
}

function runWrangler({ wrangler }, args) {
  const result = spawnSync(wrangler, args, {
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`wrangler ${args.join(" ")} failed with exit ${result.status}`);
  const text = result.stdout.trim();
  if (!text) return [];
  const payload = JSON.parse(text);
  if (!Array.isArray(payload) || payload.some((entry) => entry?.success === false)) throw new Error("D1 repair query failed");
  return payload;
}

function activeFreezeCount(freezePayload) {
  const rows = d1QueryRows(freezePayload, "Production migration freeze query");
  if (rows.length !== 1) throw new Error("Production migration freeze result is malformed");
  return Number(rows[0].active_freezes);
}

function ledgerNames(ledgerPayload) {
  return d1QueryRows(ledgerPayload, "Production migration ledger").map((row) => row.name);
}

function schemaKeys(schemaPayload) {
  return d1QueryRows(schemaPayload, "Production schema query").map((row) => `${row.type}:${row.name}`);
}

const options = parseArguments(process.argv.slice(2));
const [ledgerPayload, freezePayload, schemaPayload] = await Promise.all([
  readFile(resolve(options.ledger), "utf8").then(JSON.parse),
  readFile(resolve(options.freeze), "utf8").then(JSON.parse),
  readFile(resolve(options.schema), "utf8").then(JSON.parse),
]);

const names = ledgerNames(ledgerPayload);
if (names.at(-1) !== "0030_large_knowledge_revision_parts.sql") process.exit(0);
if (activeFreezeCount(freezePayload) !== 0) throw new Error("Refusing to repair partial asset migration during an active migration freeze");

const keys = schemaKeys(schemaPayload);
const presentAssetObjects = keys.filter((key) => ASSET_OBJECTS.has(key));
if (!presentAssetObjects.length) process.exit(0);

const unknownAssetObjects = keys.filter((key) => key.includes(":knowledge_revision_assets") && !ASSET_OBJECTS.has(key));
if (unknownAssetObjects.length) {
  throw new Error(`Refusing to repair unknown partial asset objects: ${unknownAssetObjects.join(", ")}`);
}

const context = { wrangler: resolve(options.wrangler), config: resolve(options.config) };
const countPayload = runWrangler(context, [
  "d1", "execute", "DB", "--remote", "--json", "--config", context.config,
  "--command", "SELECT COUNT(*) AS asset_rows FROM knowledge_revision_assets",
]);
const rows = d1QueryRows(countPayload, "Production asset row count");
const assetRows = Number(rows[0]?.asset_rows);
if (!Number.isSafeInteger(assetRows) || assetRows !== 0) {
  throw new Error("Refusing to repair partial asset migration because knowledge_revision_assets is not empty");
}

for (const [type, name] of DROP_ORDER) {
  if (!presentAssetObjects.includes(`${type}:${name}`)) continue;
  const noun = type === "table" ? "TABLE" : type === "index" ? "INDEX" : "TRIGGER";
  runWrangler(context, [
    "d1", "execute", "DB", "--remote", "--json", "--config", context.config,
    "--command", `DROP ${noun} ${sqlIdentifier(name)}`,
  ]);
}

process.stdout.write("Repaired empty partial knowledge asset migration objects.\n");
