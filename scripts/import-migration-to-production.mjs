import { execFile as execFileCallback, spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  canonicalJson,
  decryptMigrationEnvelope,
  MIGRATION_EXPORT_MAX_ENCRYPTED_BYTES,
  MIGRATION_EXPORT_MAX_PLAINTEXT_BYTES,
  verifyFreshMigrationPayload,
} from "../lib/migration-export.mjs";
import {
  assertTargetAdministratorReentry,
  migrationImportD1QueryCount,
  MIGRATION_IMPORT_MAX_D1_QUERIES,
  targetAdministratorEmails,
} from "../lib/migration-import-plan.mjs";
import { waitForMigrationImporter } from "../lib/migration-import-readiness.mjs";
import { deploymentTarget } from "../lib/standalone-config.mjs";

const execFile = promisify(execFileCallback);
const projectRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const wranglerPath = resolve(projectRoot, "node_modules/.bin/wrangler");
const defaultConfigPath = resolve(projectRoot, ".wrangler/generated/wrangler.production.json");
const { workerName: expectedWorkerName, databaseName: expectedDatabaseName } = deploymentTarget("production", process.env);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/iu;

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || options[key.slice(2)]) throw new Error("Invalid arguments");
    options[key.slice(2)] = value;
  }
  return options;
}

function usage() {
  process.stderr.write(`Usage: OA_PRODUCTION_IMPORT_CONFIRM=${expectedWorkerName} node scripts/import-migration-to-production.mjs --input <encrypted-archive> --private-key <jwk> --auth-key-file <file> --freeze-id-file <file> --receipt <new-json-file> --expected-origin <https-origin> [--config <production-wrangler-json>]\n`);
  process.exitCode = 64;
}

function assertOutsideWorktree(path, label) {
  const relativePath = relative(projectRoot, path);
  if (relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`))) throw new Error(`${label} must be outside the Git worktree`);
}

async function newOutsideWorktreePath(path, label) {
  const parent = await realpath(dirname(path));
  const resolvedPath = resolve(parent, basename(path));
  assertOutsideWorktree(resolvedPath, label);
  return resolvedPath;
}

async function assertRegularFile(path, label, maximumBytes, privatePermissions = false) {
  const details = await lstat(path);
  if (!details.isFile()) throw new Error(`${label} must be a regular file`);
  const resolvedPath = await realpath(path);
  assertOutsideWorktree(resolvedPath, label);
  if (details.size <= 0 || details.size > maximumBytes) throw new Error(`${label} has an unsafe size`);
  if (privatePermissions && (details.mode & 0o077) !== 0) throw new Error(`${label} must not be accessible to group or other users`);
  return resolvedPath;
}

function exactHttpsOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password || parsed.origin !== value) throw new Error("Expected source origin must be an exact HTTPS origin");
  return parsed.origin;
}

function productionBinding(config) {
  if (!config || config.name !== expectedWorkerName || !ACCOUNT_ID_PATTERN.test(config.account_id || "") || config.route || config.routes) throw new Error("Production Wrangler configuration is not the isolated authorized target");
  const bindings = Array.isArray(config.d1_databases) ? config.d1_databases.filter((entry) => entry?.binding === "DB") : [];
  if (bindings.length !== 1 || bindings[0].database_name !== expectedDatabaseName || !UUID_PATTERN.test(bindings[0].database_id || "")) throw new Error("Production D1 binding is invalid");
  return bindings[0];
}

async function jsonCommand(arguments_) {
  const { stdout } = await execFile(wranglerPath, arguments_, {
    cwd: projectRoot,
    env: { ...process.env, WRANGLER_WRITE_LOGS: "false" },
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function validateCloudflareTarget(configPath, config, binding) {
  const [identity, database] = await Promise.all([
    jsonCommand(["whoami", "--json"]),
    jsonCommand(["d1", "info", expectedDatabaseName, "--json", "--config", configPath]),
  ]);
  const authorizedAccounts = Array.isArray(identity.accounts) ? identity.accounts.map((account) => account.id) : [];
  if (identity.loggedIn !== true || !authorizedAccounts.includes(config.account_id)) throw new Error("Wrangler is not authorized for the configured production account");
  if (database.name !== expectedDatabaseName || database.uuid !== binding.database_id) throw new Error("Cloudflare returned a different production D1 database");
}

function randomBase64Url(bytes = 32) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

async function availableLocalPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  if (!port) throw new Error("Could not allocate a local importer port");
  return port;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch {
  usage();
}

if (options) {
  const required = ["input", "private-key", "auth-key-file", "freeze-id-file", "receipt", "expected-origin"];
  const allowed = [...required, "config"];
  if (required.some((key) => !options[key]) || Object.keys(options).some((key) => !allowed.includes(key))) {
    usage();
  } else if (process.env.OA_PRODUCTION_IMPORT_CONFIRM !== expectedWorkerName) {
    throw new Error(`Set OA_PRODUCTION_IMPORT_CONFIRM=${expectedWorkerName} for an intentional production import`);
  } else {
    const inputPath = await assertRegularFile(resolve(options.input), "Encrypted input", MIGRATION_EXPORT_MAX_ENCRYPTED_BYTES);
    const privateKeyPath = await assertRegularFile(resolve(options["private-key"]), "Private key", 16 * 1024, true);
    const authKeyPath = await assertRegularFile(resolve(options["auth-key-file"]), "Authentication key", 256, true);
    const freezeIdPath = await assertRegularFile(resolve(options["freeze-id-file"]), "Freeze generation", 256, true);
    const receiptPath = await newOutsideWorktreePath(resolve(options.receipt), "Recovery receipt");
    const configPath = options.config ? await realpath(resolve(options.config)) : await realpath(defaultConfigPath);
    if (configPath !== defaultConfigPath) throw new Error("Only the generated isolated production Wrangler configuration may be used");
    const expectedOrigin = exactHttpsOrigin(options["expected-origin"]);

    const [serializedEnvelope, serializedPrivateKey, serializedAuthKey, serializedFreezeId, serializedConfig] = await Promise.all([
      readFile(inputPath, "utf8"),
      readFile(privateKeyPath, "utf8"),
      readFile(authKeyPath, "utf8"),
      readFile(freezeIdPath, "utf8"),
      readFile(configPath, "utf8"),
    ]);
    const authKey = serializedAuthKey.trim();
    const freezeId = serializedFreezeId.trim().toLowerCase();
    if (!UUID_PATTERN.test(freezeId) || freezeId[14] !== "4") throw new Error("Freeze generation file is invalid");
    const payload = await decryptMigrationEnvelope(JSON.parse(serializedEnvelope), JSON.parse(serializedPrivateKey));
    await verifyFreshMigrationPayload(payload, { expectedAuthKey: authKey, expectedSourceOrigin: expectedOrigin });
    if (payload.freezeId !== freezeId) throw new Error("Encrypted archive belongs to a different freeze attempt");
    const queryCount = migrationImportD1QueryCount(payload);
    if (queryCount > MIGRATION_IMPORT_MAX_D1_QUERIES) throw new Error(`Migration needs ${queryCount} D1 queries; the production import was not started`);

    const config = JSON.parse(serializedConfig);
    const binding = productionBinding(config);
    const runtimeVariables = { ...process.env, ...(config.vars || {}) };
    const administratorEmails = targetAdministratorEmails(runtimeVariables);
    assertTargetAdministratorReentry(payload, runtimeVariables);
    const authorizedAccountId = process.env.OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID?.trim().toLowerCase() || "";
    const authorizedDatabaseId = process.env.OA_PRODUCTION_D1_DATABASE_ID?.trim().toLowerCase() || "";
    if (!ACCOUNT_ID_PATTERN.test(authorizedAccountId) || !UUID_PATTERN.test(authorizedDatabaseId)
      || config.account_id.toLowerCase() !== authorizedAccountId || binding.database_id.toLowerCase() !== authorizedDatabaseId) {
      throw new Error("Generated production configuration does not match the explicitly authorized Cloudflare account and D1 database");
    }
    await validateCloudflareTarget(configPath, config, binding);
    const recovery = await jsonCommand(["d1", "time-travel", "info", expectedDatabaseName, "--json", "--config", configPath]);
    if (typeof recovery.bookmark !== "string" || !recovery.bookmark) throw new Error("Could not record the production D1 recovery bookmark");

    const receipt = {
      createdAt: new Date().toISOString(),
      databaseId: binding.database_id,
      databaseName: binding.database_name,
      format: "originmind-oa-production-import-recovery",
      freezeId,
      manifestSha256: payload.manifestSha256,
      recoveryBookmark: recovery.bookmark,
      schemaSha256: payload.schemaSha256,
      state: "pre_import",
      version: 1,
    };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    process.stdout.write(`Created private pre-import recovery receipt at ${receiptPath}.\n`);

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "originmind-production-import-"));
    let child;
    try {
      const temporaryConfigPath = join(temporaryDirectory, "wrangler.import.json");
      const environmentPath = join(temporaryDirectory, ".import.env");
      const token = randomBase64Url();
      const readyProof = randomBase64Url();
      const temporaryConfig = {
        name: "originmind-oa-import-local",
        main: resolve(projectRoot, "scripts/migration-import-worker.ts"),
        compatibility_date: "2026-05-15",
        compatibility_flags: ["nodejs_compat"],
        account_id: config.account_id,
        d1_databases: [{
          binding: "DB",
          database_name: binding.database_name,
          database_id: binding.database_id,
          remote: true,
        }],
        vars: { MIGRATION_IMPORT_ADMIN_EMAILS: administratorEmails.join(",") },
      };
      await Promise.all([
        writeFile(temporaryConfigPath, `${JSON.stringify(temporaryConfig)}\n`, { mode: 0o600, flag: "wx" }),
        writeFile(environmentPath, [
          `MIGRATION_IMPORT_TOKEN=${token}`,
          `MIGRATION_IMPORT_AUTH_KEY=${authKey}`,
          `MIGRATION_IMPORT_EXPECTED_ORIGIN=${expectedOrigin}`,
          `MIGRATION_IMPORT_EXPECTED_SCHEMA_SHA256=${payload.schemaSha256}`,
          `MIGRATION_IMPORT_EXPECTED_FREEZE_ID=${freezeId}`,
          `MIGRATION_IMPORT_READY_PROOF=${readyProof}`,
          "",
        ].join("\n"), { mode: 0o600, flag: "wx" }),
      ]);
      const port = await availableLocalPort();
      const importerUrl = `http://127.0.0.1:${port}/import`;
      child = spawn(wranglerPath, [
        "dev",
        "--config", temporaryConfigPath,
        "--env-file", environmentPath,
        "--ip", "127.0.0.1",
        "--port", String(port),
        "--log-level", "error",
        "--show-interactive-dev-session=false",
      ], {
        cwd: projectRoot,
        env: { ...process.env, WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG_PATH: join(temporaryDirectory, "wrangler.log") },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let diagnosticBytes = 0;
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { diagnosticBytes += chunk.length; if (diagnosticBytes > 1024 * 1024) child.kill("SIGTERM"); });
      await waitForMigrationImporter(`http://127.0.0.1:${port}/ready`, readyProof, child);
      const serializedPayload = canonicalJson(payload);
      if (Buffer.byteLength(serializedPayload) > MIGRATION_EXPORT_MAX_PLAINTEXT_BYTES) throw new Error("Verified migration payload is too large");
      await writeFile(receiptPath, `${JSON.stringify({ ...receipt, requestStartedAt: new Date().toISOString(), state: "import_request_started" }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      const response = await fetch(importerUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: serializedPayload,
        signal: AbortSignal.timeout(120_000),
      });
      const responseText = await response.text();
      if (responseText.length > 256 * 1024) throw new Error("Local importer returned an oversized response");
      const result = JSON.parse(responseText);
      if (!response.ok || result.ok !== true) throw new Error(`Production import stopped with state ${result.state || "unknown"}: ${result.error || "no details"}`);
      const totalRows = result.tables.reduce((sum, table) => sum + table.rowCount, 0);
      await writeFile(receiptPath, `${JSON.stringify({ ...receipt, completedAt: new Date().toISOString(), state: result.state }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      process.stdout.write(`Production migration ${result.state}: ${result.tables.length} tables, ${totalRows} rows, ${queryCount} D1 queries.\n`);
    } finally {
      if (child) await stopChild(child);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
