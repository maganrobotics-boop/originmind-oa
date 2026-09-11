import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { deploymentTarget } from "../lib/standalone-config.mjs";

const target = process.argv[2] || "";
if (target !== "staging") throw new Error("Only the isolated staging output may be checked");
const expected = deploymentTarget("staging", process.env);

const outputPath = resolve(process.cwd(), process.argv[3] || "dist/server/wrangler.json");
const config = JSON.parse(await readFile(outputPath, "utf8"));
const database = config.d1_databases?.find((entry) => entry.binding === "DB");
const expectedAccountId = process.env.OA_STAGING_CLOUDFLARE_ACCOUNT_ID?.trim().toLowerCase();
const expectedDatabaseId = process.env.OA_STAGING_D1_DATABASE_ID?.trim().toLowerCase();
const expectedPublicOrigin = new URL(process.env.OA_STAGING_PUBLIC_ORIGIN?.trim() || "https://invalid.example").origin;

if (config.name !== expected.workerName) throw new Error("Unexpected standalone Worker name");
if (config.main !== "index.js" || config.no_bundle !== true) throw new Error("Standalone Worker entrypoint is not the verified Vinext bundle");
if (config.account_id !== expectedAccountId) throw new Error("Standalone Cloudflare account does not match the authorized staging account");
if (database?.database_name !== expected.databaseName || database?.database_id !== expectedDatabaseId) throw new Error("Standalone DB binding does not match the authorized staging database");
const workerFirstRoutes = config.assets?.run_worker_first;
if (
  config.assets?.binding !== "ASSETS"
  || config.assets?.directory !== "../client"
  || config.assets?.not_found_handling !== "none"
  || JSON.stringify(workerFirstRoutes) !== JSON.stringify(["/api/*", "/_vinext/*", "/__vinext/*"])
) throw new Error("Standalone ASSETS binding is incomplete");
if (config.images?.binding !== "IMAGES") throw new Error("Standalone IMAGES binding is missing");
if (config.vars?.OA_PUBLIC_ORIGIN !== expectedPublicOrigin) throw new Error("Standalone public origin does not match the authorized staging origin");
if (config.vars?.GITHUB_LOGIN_ENABLED !== "true" || !config.vars?.GITHUB_OAUTH_CLIENT_ID) throw new Error("Standalone GitHub login variables are incomplete");
if (config.vars?.CHATGPT_LOGIN_ENABLED !== "false") throw new Error("Standalone ChatGPT login must be disabled");
if (config.vars?.FEISHU_LOGIN_ENABLED !== "true" || !config.vars?.FEISHU_LOGIN_APP_ID || !config.vars?.FEISHU_LOGIN_TENANT_KEY) throw new Error("Standalone Feishu login variables are incomplete");
if (config.vars?.FEISHU_PDF_ARCHIVE_ENABLED !== "true") throw new Error("Standalone Feishu PDF archive must be enabled");
if (config.vars?.OA_MIGRATION_EXPORT_ENABLED !== "false" || config.vars?.OA_MIGRATION_WRITE_FROZEN !== "false" || config.vars?.OA_MIGRATION_UNFREEZE_ENABLED !== "false") throw new Error("Standalone staging must not expose, freeze, or unfreeze the source migration window");
if (!config.vars?.OA_ADMIN_EMAILS || !config.vars?.OA_ADMIN_NAMES) throw new Error("Standalone administrator tuple is incomplete");
if (config.preview_urls !== false) throw new Error("Standalone preview URLs must be disabled");
if (config.workers_dev !== true) throw new Error("Standalone workers.dev staging must be enabled");
if (config.route || config.routes) throw new Error("Standalone staging must not attach a route or custom domain");
const requiredSecrets = [...(config.secrets?.required || [])].sort();
if (JSON.stringify(requiredSecrets) !== JSON.stringify(["FEISHU_LOGIN_APP_SECRET", "GITHUB_OAUTH_CLIENT_SECRET"])) {
  throw new Error("Standalone required-secret declaration is incomplete");
}

await access(resolve(dirname(outputPath), config.main));
await access(resolve(dirname(outputPath), config.assets.directory));

const serializedVars = JSON.stringify(config.vars || {}).toLowerCase();
if (serializedVars.includes("client_secret") || serializedVars.includes("api_token") || serializedVars.includes("app_secret")) {
  throw new Error("A secret-like key or value was emitted into public Worker vars");
}

process.stdout.write(`Verified ${target} standalone Worker output.\n`);
