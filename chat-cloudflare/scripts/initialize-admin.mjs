import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_REPOSITORY = "maganrobotics-boop/originmind-oa";
export const DATABASE_NAME = "originmind-public-chat-production";
export const EXPECTED_CONFIRMATION = `${DATABASE_NAME}:initialize-admin:chat.omindos.ai`;
export const PASSWORD_ALGORITHM = "PBKDF2-SHA-256";
export const PASSWORD_ITERATIONS = 210_000;

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const API_ROOT = "https://api.cloudflare.com/client/v4";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CHAT_ROOT = resolve(dirname(SCRIPT_PATH), "..");
export const EVIDENCE_PATH = resolve(CHAT_ROOT, ".wrangler", "admin-initialization", "receipt.json");

const CHECK_ACCOUNT_SQL = "SELECT id, algorithm, iterations FROM admin_account WHERE id = ? LIMIT 1;";
const INSERT_ACCOUNT_SQL = "INSERT INTO admin_account(id, algorithm, iterations, salt, hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id, algorithm, iterations;";

export class AdminInitializationError extends Error {
  constructor(code, httpStatus = null) {
    super(code);
    this.name = "AdminInitializationError";
    this.code = code;
    this.httpStatus = Number.isInteger(httpStatus) ? httpStatus : null;
  }
}

function fail(code, httpStatus = null) {
  throw new AdminInitializationError(code, httpStatus);
}

function requiredText(environment, key, minimum, maximum) {
  const value = environment[key];
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    fail(`invalid-${key.toLowerCase().replaceAll("_", "-")}`);
  }
  return value;
}

export function validateAdminInitializationEnvironment(environment) {
  const accountId = requiredText(environment, "CLOUDFLARE_ACCOUNT_ID", 32, 32).toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(accountId) || /^0+$/u.test(accountId)) fail("invalid-cloudflare-account-id");

  const apiToken = requiredText(environment, "CLOUDFLARE_API_TOKEN", 20, 2_048);
  const adminPassword = requiredText(environment, "CHAT_ADMIN_PASSWORD", 12, 256);
  if (apiToken === adminPassword) fail("credentials-must-be-independent");
  if (requiredText(environment, "CHAT_ADMIN_INITIALIZATION_CONFIRM", 1, 256) !== EXPECTED_CONFIRMATION) {
    fail("invalid-confirmation");
  }
  if (requiredText(environment, "GITHUB_REPOSITORY", 1, 200) !== EXPECTED_REPOSITORY) {
    fail("invalid-repository");
  }
  if (requiredText(environment, "GITHUB_REF", 1, 200) !== "refs/heads/main") fail("invalid-git-ref");

  const commitSha = requiredText(environment, "GITHUB_SHA", 40, 40).toLowerCase();
  if (!COMMIT_SHA_PATTERN.test(commitSha)) fail("invalid-git-sha");
  const runId = requiredText(environment, "GITHUB_RUN_ID", 1, 32);
  const runAttempt = requiredText(environment, "GITHUB_RUN_ATTEMPT", 1, 6);
  if (!/^[1-9][0-9]*$/u.test(runId) || !/^[1-9][0-9]*$/u.test(runAttempt)) fail("invalid-github-run");

  return { accountId, apiToken, adminPassword, commitSha, runId, runAttempt };
}

export function consumeAdminInitializationEnvironment(environment = process.env) {
  const snapshot = {
    CLOUDFLARE_ACCOUNT_ID: environment.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: environment.CLOUDFLARE_API_TOKEN,
    CHAT_ADMIN_PASSWORD: environment.CHAT_ADMIN_PASSWORD,
    CHAT_ADMIN_INITIALIZATION_CONFIRM: environment.CHAT_ADMIN_INITIALIZATION_CONFIRM,
    GITHUB_REPOSITORY: environment.GITHUB_REPOSITORY,
    GITHUB_REF: environment.GITHUB_REF,
    GITHUB_SHA: environment.GITHUB_SHA,
    GITHUB_RUN_ID: environment.GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT: environment.GITHUB_RUN_ATTEMPT,
  };
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.CHAT_ADMIN_PASSWORD;
  return validateAdminInitializationEnvironment(snapshot);
}

export function selectExactDatabase(value) {
  if (!Array.isArray(value)) fail("invalid-database-list");
  const matches = value.filter((database) => database?.name === DATABASE_NAME);
  if (matches.length !== 1) fail("database-target-not-unique");
  const id = String(matches[0]?.uuid || "").toLowerCase();
  if (!UUID_PATTERN.test(id) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/u.test(id)) fail("invalid-database-id");
  return { id, name: DATABASE_NAME };
}

function parseD1Query(payload) {
  if (!payload || payload.success !== true || !Array.isArray(payload.result) || payload.result.length !== 1) {
    fail("invalid-d1-response");
  }
  const query = payload.result[0];
  if (!query || query.success !== true || !Array.isArray(query.results)) fail("d1-query-failed");
  return query;
}

function validateAccountRow(row) {
  if (
    !row ||
    Number(row.id) !== 1 ||
    row.algorithm !== PASSWORD_ALGORITHM ||
    Number(row.iterations) !== PASSWORD_ITERATIONS
  ) {
    fail("invalid-admin-account-record");
  }
  return { id: 1, algorithm: PASSWORD_ALGORITHM, iterations: PASSWORD_ITERATIONS };
}

function accountFromQuery(query) {
  if (query.results.length === 0) return null;
  if (query.results.length !== 1) fail("admin-account-not-unique");
  return validateAccountRow(query.results[0]);
}

async function cloudflareRequest({ accountId, apiToken, fetchImpl }, path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetchImpl(`${API_ROOT}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("cloudflare-network-failure");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    fail("cloudflare-non-json-response", response.status);
  }
  if (!response.ok || payload?.success !== true) fail("cloudflare-api-failure", response.status);
  return payload;
}

async function findDatabase(credentials, fetchImpl) {
  const query = new URLSearchParams({ name: DATABASE_NAME, page: "1", per_page: "10" });
  const payload = await cloudflareRequest(
    { ...credentials, fetchImpl },
    `/accounts/${credentials.accountId}/d1/database?${query}`,
  );
  return selectExactDatabase(payload.result);
}

async function queryDatabase(credentials, databaseId, sql, params, fetchImpl) {
  const payload = await cloudflareRequest(
    { ...credentials, fetchImpl },
    `/accounts/${credentials.accountId}/d1/database/${databaseId}/query`,
    { method: "POST", body: { sql, params } },
  );
  return parseD1Query(payload);
}

function receipt(environment, outcome, secretApplied, completedAt) {
  return {
    format: "originmind-chat-admin-initialization-v2",
    outcome,
    secretApplied,
    database: DATABASE_NAME,
    adminId: 1,
    algorithm: PASSWORD_ALGORITHM,
    iterations: PASSWORD_ITERATIONS,
    commitSha: environment.commitSha,
    githubRun: `${environment.runId}-${environment.runAttempt}`,
    completedAt,
  };
}

export async function initializeChatAdmin({
  environment = process.env,
  fetchImpl = fetch,
  randomBytesImpl = randomBytes,
  pbkdf2Impl = pbkdf2Sync,
  now = () => new Date().toISOString(),
} = {}) {
  const validated = consumeAdminInitializationEnvironment(environment);
  const credentials = { accountId: validated.accountId, apiToken: validated.apiToken };
  const database = await findDatabase(credentials, fetchImpl);
  const before = accountFromQuery(await queryDatabase(credentials, database.id, CHECK_ACCOUNT_SQL, ["1"], fetchImpl));
  if (before) return receipt(validated, "already-exists-no-change", false, now());

  const salt = randomBytesImpl(32);
  if (!Buffer.isBuffer(salt) || salt.length !== 32) fail("invalid-random-salt");
  const hash = pbkdf2Impl(validated.adminPassword, salt, PASSWORD_ITERATIONS, 32, "sha256");
  if (!Buffer.isBuffer(hash) || hash.length !== 32) fail("invalid-password-hash");

  const inserted = await queryDatabase(
    credentials,
    database.id,
    INSERT_ACCOUNT_SQL,
    ["1", PASSWORD_ALGORITHM, String(PASSWORD_ITERATIONS), salt.toString("base64"), hash.toString("base64")],
    fetchImpl,
  );
  if (inserted.results.length !== 1) fail("admin-initialization-conflict");
  validateAccountRow(inserted.results[0]);

  const after = accountFromQuery(await queryDatabase(credentials, database.id, CHECK_ACCOUNT_SQL, ["1"], fetchImpl));
  if (!after) fail("admin-verification-failed");
  return receipt(validated, "created-and-verified", true, now());
}

function safeFailureReceipt(error, environment) {
  const commitSha = typeof environment.GITHUB_SHA === "string" && COMMIT_SHA_PATTERN.test(environment.GITHUB_SHA.toLowerCase())
    ? environment.GITHUB_SHA.toLowerCase()
    : null;
  return {
    format: "originmind-chat-admin-initialization-v2",
    outcome: "failed",
    failureCode: error instanceof AdminInitializationError ? error.code : "unexpected-failure",
    httpStatus: error instanceof AdminInitializationError ? error.httpStatus : null,
    database: DATABASE_NAME,
    commitSha,
    completedAt: new Date().toISOString(),
  };
}

async function writeEvidence(value) {
  await mkdir(dirname(EVIDENCE_PATH), { recursive: true, mode: 0o700 });
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

export async function runCli(environment = process.env) {
  try {
    const result = await initializeChatAdmin({ environment });
    await writeEvidence(result);
    process.stdout.write(`Chat administrator initialization: ${result.outcome}\n`);
    if (!result.secretApplied) {
      process.stderr.write("Administrator already exists; the supplied password was not applied.\n");
      process.exitCode = 2;
    }
  } catch (error) {
    const failure = safeFailureReceipt(error, environment);
    try {
      await writeEvidence(failure);
    } catch {
      // The fixed failure code below remains safe if evidence cannot be written.
    }
    process.stderr.write(`Chat administrator initialization failed: ${failure.failureCode}`);
    if (failure.httpStatus !== null) process.stderr.write(` (HTTP ${failure.httpStatus})`);
    process.stderr.write("\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) await runCli();
