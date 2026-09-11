import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validateProductionCloudflareSnapshot } from "../lib/production-release.mjs";
import { productionTarget } from "../lib/standalone-config.mjs";

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || options[key.slice(2)]) throw new Error("Invalid production target check arguments");
    options[key.slice(2)] = value;
  }
  const required = ["identity", "database", "website-database", "secrets", "deployments", "versions", "receipt"];
  const allowed = [...required, "expected-version-message", "allow-missing-public-lab-ai-service-token"];
  if (required.some((key) => !options[key]) || Object.keys(options).some((key) => !allowed.includes(key))) {
    throw new Error("Usage: check-production-cloudflare-target.mjs --identity <json> --database <json> --website-database <json> --secrets <json> --deployments <json> --versions <json> --receipt <json> [--expected-version-message <message>] [--allow-missing-public-lab-ai-service-token true]");
  }
  if (options["allow-missing-public-lab-ai-service-token"] && options["allow-missing-public-lab-ai-service-token"] !== "true") {
    throw new Error("allow-missing-public-lab-ai-service-token must be exactly true when supplied");
  }
  return options;
}

async function jsonFile(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

const options = parseArguments(process.argv.slice(2));
const snapshot = validateProductionCloudflareSnapshot({
  target: productionTarget(process.env),
  identity: await jsonFile(options.identity),
  primaryDatabase: await jsonFile(options.database),
  websiteDatabase: await jsonFile(options["website-database"]),
  secrets: await jsonFile(options.secrets),
  deployments: await jsonFile(options.deployments),
  versions: await jsonFile(options.versions),
  expectedVersionMessage: options["expected-version-message"],
  allowMissingPublicLabAiServiceToken: options["allow-missing-public-lab-ai-service-token"] === "true",
});
const receiptPath = resolve(options.receipt);
await writeFile(receiptPath, `${JSON.stringify({
  format: "originmind-oa-production-target-check-v1",
  checkedAt: new Date().toISOString(),
  ...snapshot,
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
process.stdout.write("Verified the authorized Cloudflare production account, Worker, D1 databases, secrets, and rollback point.\n");
