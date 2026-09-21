import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim().toLowerCase();
const apiToken = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
const hostname = String(process.env.PREVIEW_HOSTNAME || "").trim().toLowerCase();
const worker = String(process.env.PREVIEW_WORKER_NAME || "").trim().toLowerCase();
const database = String(process.env.PREVIEW_DATABASE_NAME || "").trim().toLowerCase();
const oaWorker = String(process.env.OA_PRODUCTION_WORKER_NAME || "").trim().toLowerCase();
const adminEmail = String(process.env.CHAT_ADMIN_EMAIL || "").trim().toLowerCase();
if (!/^[a-f0-9]{32}$/u.test(accountId) || !apiToken || !/^preview\.omindos\.ai$/u.test(hostname) || !worker || !database || !oaWorker || !adminEmail) {
  throw new Error("Preview release environment is incomplete or invalid");
}

const root = new URL("..", import.meta.url).pathname;
const wrangler = join(root, "node_modules", ".bin", "wrangler");
const configPath = join(root, ".wrangler-preview.json");
const secretPath = join(root, ".wrangler-preview-secrets.json");

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(wrangler, args, { cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout)));
  });
}

async function api(path, method = "GET", body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method, headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const payload = await response.json();
  if (!response.ok || payload?.success !== true) throw new Error(`Cloudflare API ${method} ${path} failed`);
  return payload.result;
}

const databases = JSON.parse(await run(["d1", "list", "--json"]));
let target = databases.find((item) => item?.name === database);
if (!target) {
  await run(["d1", "create", database, "--location", "apac"]);
  target = JSON.parse(await run(["d1", "list", "--json"])).find((item) => item?.name === database);
}
const databaseId = String(target?.uuid || target?.id || "");
if (!/^[a-f0-9-]{36}$/u.test(databaseId)) throw new Error("Preview D1 database was not created");

const config = {
  account_id: accountId, name: worker, main: "src/index.mjs", compatibility_date: "2026-09-11",
  compatibility_flags: ["global_fetch_strictly_public"], workers_dev: false, preview_urls: false,
  assets: { directory: "public", binding: "ASSETS", html_handling: "none", not_found_handling: "none", run_worker_first: ["/*", "!/assets/*", "!/favicon.svg", "!/LICENSES.md"] },
  ai: { binding: "AI" }, services: [{ binding: "OA_SERVICE", service: oaWorker }],
  d1_databases: [{ binding: "DB", database_name: database, database_id: databaseId, migrations_dir: "migrations" }],
  vars: { APP_ORIGIN: `https://${hostname}`, ADMIN_EMAIL: adminEmail, RELEASE_ID: `preview-${process.env.GITHUB_SHA || "local"}` },
  routes: [{ pattern: `${hostname}/*`, zone_name: "omindos.ai" }],
};
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
await mkdir(join(root, ".wrangler"), { recursive: true });
await run(["d1", "migrations", "apply", "DB", "--remote", "--config", configPath]);
const zone = (await api(`/zones?name=omindos.ai&account.id=${accountId}&status=active&per_page=1`))[0];
if (!zone?.id) throw new Error("Active omindos.ai zone not found");
const records = await api(`/zones/${zone.id}/dns_records?name=${hostname}&per_page=10`);
if (!records.length) await api(`/zones/${zone.id}/dns_records`, "POST", { type: "CNAME", name: hostname, content: `${worker}.${(await api(`/accounts/${accountId}/workers/subdomain`)).subdomain}.workers.dev`, proxied: true, ttl: 1 });
const secrets = {
  PUBLIC_LAB_AI_SERVICE_TOKEN: process.env.PUBLIC_LAB_AI_SERVICE_TOKEN,
  APP_ENCRYPTION_KEY: process.env.CHAT_APP_ENCRYPTION_KEY,
  RATE_LIMIT_HMAC_KEY: process.env.CHAT_RATE_LIMIT_HMAC_KEY,
  ADMIN_PASSWORD: process.env.CHAT_ADMIN_PASSWORD,
};
if (Object.values(secrets).some((value) => !value)) throw new Error("Preview secrets are incomplete");
await writeFile(secretPath, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
await run(["secret", "bulk", "--config", configPath, "--secrets-file", secretPath]);
await run(["deploy", "--config", configPath, "--message", `preview-${process.env.GITHUB_SHA || "local"}`]);
const response = await fetch(`https://${hostname}/`, { redirect: "error", signal: AbortSignal.timeout(60_000) });
if (!response.ok) throw new Error(`Preview smoke check failed with HTTP ${response.status}`);
process.stdout.write(`Preview deployed successfully: https://${hostname}\n`);
