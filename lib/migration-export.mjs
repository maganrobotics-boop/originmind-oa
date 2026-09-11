const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const MIGRATION_EXPORT_FORMAT = "originmind-oa-migration";
export const MIGRATION_ENVELOPE_FORMAT = "originmind-oa-migration-envelope";
export const MIGRATION_EXPORT_VERSION = 1;
export const MIGRATION_EXPORT_MAX_PLAINTEXT_BYTES = 6 * 1024 * 1024;
export const MIGRATION_EXPORT_MINIMUM_FREEZE_MS = 15 * 60 * 1000;
export const MIGRATION_SCHEMA_COLUMNS = Object.freeze(["type", "name", "tbl_name", "sql"]);
export const MIGRATION_SCHEMA_EXPECTED_OBJECT_COUNTS = Object.freeze({
  table: 19,
  index: 38,
  trigger: 62,
  total: 119,
});
export const MIGRATION_EXPORT_EXPECTED_MIGRATIONS = Object.freeze([
  "0000_fuzzy_warbound.sql",
  "0001_magenta_silver_fox.sql",
  "0002_aberrant_reptil.sql",
  "0003_glossy_rogue.sql",
  "0004_needy_rhino.sql",
  "0005_wide_whiplash.sql",
  "0006_nostalgic_the_initiative.sql",
  "0007_good_pandemic.sql",
  "0008_shiny_captain_america.sql",
  "0009_tidy_james_howlett.sql",
  "0010_tense_karnak.sql",
  "0011_naive_energizer.sql",
  "0012_amusing_susan_delgado.sql",
  "0013_legal_carlie_cooper.sql",
  "0014_ambiguous_squadron_sinister.sql",
  "0015_amused_scream.sql",
  "0016_bitter_jocasta.sql",
  "0017_brief_blue_shield.sql",
  "0018_bored_lady_mastermind.sql",
  "0019_supported_email_subject.sql",
  "0020_quiet_fabian_cortez.sql",
  "0021_striped_iceman.sql",
  "0022_exotic_shooting_star.sql",
  "0023_brainy_exodus.sql",
  "0024_retire_feishu.sql",
  "0025_restore_feishu_login.sql",
  "0026_rich_jocasta.sql",
  "0027_careless_winter_soldier.sql",
  "0028_needy_microchip.sql",
]);

export const MIGRATION_EXPORT_TABLES = Object.freeze([
  {
    name: "approvals",
    columns: ["id", "type", "title", "project", "requester_name", "requester_email", "client_creation_key", "business_key", "created_at", "updated_at", "status", "current_step", "current_reviewer_name", "current_reviewer_email", "summary", "owner", "amount", "period_key", "signers_json", "payload_json", "current_revision_no", "current_revision_hash"],
    orderBy: ["id"],
  },
  {
    name: "approval_events",
    columns: ["id", "approval_id", "actor_name", "actor_email", "action", "note", "created_at"],
    orderBy: ["id"],
  },
  {
    name: "approval_revisions",
    columns: ["revision_hash", "approval_id", "revision_no", "previous_revision_hash", "mutation_revision", "state_json", "state_hash", "event_json", "created_at"],
    orderBy: ["approval_id", "revision_no", "revision_hash"],
  },
  {
    name: "labor_source_claims",
    columns: ["id", "claimant_member_id", "claimant_email", "technical_approval_id", "labor_approval_id", "created_at"],
    orderBy: ["id"],
  },
  {
    name: "external_archives",
    columns: ["id", "approval_id", "destination", "manifest_hash", "content_hash", "file_name", "status", "file_token", "source_revision_hash", "lease_token", "lease_expires_at", "error_code", "created_at", "updated_at"],
    orderBy: ["id"],
  },
  {
    name: "members",
    columns: ["id", "full_name", "identity_number", "school_email", "chatgpt_account", "account_user_id", "pending_full_name", "pending_identity_number", "account_binding_previous_status", "role", "permissions_json", "department_code", "status", "nda_accepted_at", "nda_approval_id", "nda_agreement_version", "mutation_revision", "created_at", "last_seen_at"],
    orderBy: ["id"],
  },
  {
    name: "member_events",
    columns: ["id", "member_id", "actor_name", "actor_email", "action", "note", "created_at"],
    orderBy: ["id"],
  },
  {
    name: "auth_identities",
    columns: ["id", "member_id", "provider", "provider_subject", "login_snapshot", "verified_email_snapshot", "linked_at", "last_seen_at", "unlinked_at"],
    orderBy: ["id"],
  },
  {
    name: "account_profiles",
    columns: ["chatgpt_account", "avatar_data_url", "profile_json", "last_seen_at"],
    orderBy: ["chatgpt_account"],
  },
  {
    name: "direct_messages",
    columns: ["id", "sender_email", "sender_name", "recipient_email", "recipient_name", "body", "created_at"],
    orderBy: ["id"],
  },
  {
    name: "knowledge_items",
    columns: ["id", "project", "title", "category", "submitter_member_id", "submitter_name", "submitter_email", "status", "visibility", "current_revision_no", "current_revision_id", "active_revision_id", "mutation_revision", "created_at", "updated_at", "revoked_at"],
    orderBy: ["id"],
  },
  {
    name: "knowledge_revisions",
    columns: ["id", "item_id", "revision_no", "previous_revision_id", "title", "category", "content", "summary", "source_label", "source_url", "content_hash", "status", "created_by_member_id", "created_by_name", "created_by_email", "reviewed_by_member_id", "reviewed_by_name", "reviewed_by_email", "review_note", "created_at", "reviewed_at", "activated_at", "retired_at"],
    orderBy: ["item_id", "revision_no", "id"],
  },
  {
    name: "knowledge_chunks",
    columns: ["id", "item_id", "revision_id", "chunk_no", "section_title", "paragraph_ref", "content", "search_text", "is_active", "created_at"],
    orderBy: ["revision_id", "chunk_no", "id"],
  },
  {
    name: "knowledge_events",
    columns: ["id", "item_id", "revision_id", "actor_member_id", "actor_name", "actor_email", "action", "note", "created_at"],
    orderBy: ["item_id", "created_at", "id"],
  },
].map((table) => Object.freeze({ ...table, columns: Object.freeze(table.columns), orderBy: Object.freeze(table.orderBy) })));

export const MIGRATION_APPLICATION_TABLES = Object.freeze([
  ...MIGRATION_EXPORT_TABLES.map((table) => table.name),
  "member_sessions",
  "oauth_sessions",
  "oauth_transactions",
  "write_rate_buckets",
  "migration_control",
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Migration JSON cannot contain a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainRecord(value)) {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError(`Migration JSON property ${key} is undefined`);
      output[key] = canonicalValue(value[key]);
    }
    return output;
  }
  throw new TypeError("Migration JSON contains an unsupported value");
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function assertJsonNestingLimit(serialized, maximumDepth = 64) {
  let depth = 0;
  let escaped = false;
  let inString = false;
  for (const character of serialized) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > maximumDepth) throw new Error("Migration JSON nesting is too deep");
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
}

export function parseCanonicalMigrationJson(serialized) {
  if (typeof serialized !== "string" || !serialized) throw new Error("Migration payload is not valid JSON");
  assertJsonNestingLimit(serialized);
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw new Error("Migration payload is not valid JSON");
  }
  if (canonicalJson(payload) !== serialized) throw new Error("Migration payload is not canonically encoded");
  return payload;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function base64UrlToBytes(value, maximumBytes = MIGRATION_EXPORT_MAX_PLAINTEXT_BYTES * 2) {
  if (typeof value !== "string" || !value || !BASE64URL_PATTERN.test(value)) throw new TypeError("Invalid base64url migration field");
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  if (binary.length > maximumBytes) throw new RangeError("Encrypted migration field is too large");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytesToBase64Url(bytes) !== value) throw new TypeError("Non-canonical base64url migration field");
  return bytes;
}

export async function sha256Hex(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactOrigin(value, key) {
  if (typeof value !== "string" || !value || value.length > 2_048 || CONTROL_CHARACTER_PATTERN.test(value)) throw new Error(`${key} must be an exact HTTPS origin`);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password || parsed.origin !== value) throw new Error();
    return parsed.origin;
  } catch {
    throw new Error(`${key} must be an exact HTTPS origin`);
  }
}

function normalizedPublicKeyJwk(serialized) {
  if (typeof serialized !== "string" || !serialized || serialized.length > 4_096 || CONTROL_CHARACTER_PATTERN.test(serialized)) throw new Error("OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK is invalid");
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK is not valid JSON");
  }
  if (!isPlainRecord(parsed) || parsed.kty !== "RSA" || typeof parsed.n !== "string" || typeof parsed.e !== "string") throw new Error("OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK is not an RSA public key");
  for (const privateField of ["d", "p", "q", "dp", "dq", "qi", "oth"]) {
    if (privateField in parsed) throw new Error("OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK must not contain private key material");
  }
  assertStrongRsaPublicComponents(parsed, "OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK");
  if (parsed.alg !== undefined && parsed.alg !== "RSA-OAEP-256") throw new Error("OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK has an incompatible algorithm");
  if (parsed.use !== undefined && parsed.use !== "enc") throw new Error("OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK has an incompatible use");
  if (parsed.key_ops !== undefined && (!Array.isArray(parsed.key_ops) || !parsed.key_ops.includes("encrypt"))) throw new Error("OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK cannot encrypt");
  return { kty: "RSA", n: parsed.n, e: parsed.e, alg: "RSA-OAEP-256", use: "enc", key_ops: ["encrypt"], ext: true };
}

function assertStrongRsaPublicComponents(key, label) {
  if (!isPlainRecord(key) || key.kty !== "RSA" || typeof key.n !== "string" || typeof key.e !== "string" || !BASE64URL_PATTERN.test(key.n) || !BASE64URL_PATTERN.test(key.e)) throw new Error(`${label} is malformed`);
  const modulus = base64UrlToBytes(key.n, 1_024);
  if (modulus.byteLength < 384 || modulus[0] < 0x80 || (modulus[modulus.byteLength - 1] & 1) !== 1 || key.e !== "AQAB") throw new Error(`${label} must use an odd, unpadded 3072-bit-or-stronger modulus and exponent 65537`);
}

export function isMigrationExportEnabled(environment = process.env) {
  return environment.OA_MIGRATION_EXPORT_ENABLED?.trim().toLowerCase() === "true";
}

export function isMigrationExportWindowOpen(environment = process.env, now = Date.now()) {
  if (!isMigrationExportEnabled(environment)) return false;
  if (environment.OA_MIGRATION_WRITE_FROZEN?.trim().toLowerCase() !== "true") return false;
  if (!UUID_V4_PATTERN.test(environment.OA_MIGRATION_FREEZE_ID?.trim() || "")) return false;
  const notBefore = Date.parse(environment.OA_MIGRATION_EXPORT_NOT_BEFORE?.trim() || "");
  const notAfter = Date.parse(environment.OA_MIGRATION_EXPORT_NOT_AFTER?.trim() || "");
  return Number.isFinite(notBefore)
    && Number.isFinite(notAfter)
    && notBefore <= now
    && notAfter > now
    && notAfter - notBefore <= 60 * 60 * 1000;
}

export function getMigrationExportConfig(environment = process.env, now = Date.now()) {
  if (!isMigrationExportWindowOpen(environment, now)) return null;
  const authKey = environment.OA_MIGRATION_EXPORT_AUTH_KEY?.trim() || "";
  if (!BASE64URL_PATTERN.test(authKey) || authKey.length !== 43 || base64UrlToBytes(authKey, 64).byteLength !== 32) throw new Error("OA_MIGRATION_EXPORT_AUTH_KEY must be a 256-bit base64url secret");
  const expectedSchemaSha256 = environment.OA_MIGRATION_EXPORT_EXPECTED_SCHEMA_SHA256?.trim().toLowerCase() || "";
  if (!SHA256_PATTERN.test(expectedSchemaSha256)) throw new Error("OA_MIGRATION_EXPORT_EXPECTED_SCHEMA_SHA256 must identify the verified target schema");
  const notBefore = new Date(environment.OA_MIGRATION_EXPORT_NOT_BEFORE.trim()).toISOString();
  const notAfter = new Date(environment.OA_MIGRATION_EXPORT_NOT_AFTER.trim()).toISOString();
  return {
    sourceOrigin: exactOrigin(environment.OA_PUBLIC_ORIGIN?.trim() || "", "OA_PUBLIC_ORIGIN"),
    authKey,
    expectedSchemaSha256,
    freezeId: environment.OA_MIGRATION_FREEZE_ID.trim().toLowerCase(),
    notBefore,
    notAfter,
    publicKeyJwk: normalizedPublicKeyJwk(environment.OA_MIGRATION_EXPORT_PUBLIC_KEY_JWK?.trim() || ""),
  };
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error("Unsafe migration export identifier");
  return `"${value}"`;
}

export function migrationExportSelectSql(table) {
  const columns = table.columns.map(quoteIdentifier).join(", ");
  const orderBy = table.orderBy.map((column) => `${quoteIdentifier(column)} ASC`).join(", ");
  return `SELECT ${columns} FROM ${quoteIdentifier(table.name)} ORDER BY ${orderBy}`;
}

export function migrationCombinedVerificationSelectSql() {
  const selects = MIGRATION_EXPORT_TABLES.map((table, tableIndex) => {
    const orderColumns = [0, 1, 2].map((index) => table.orderBy[index] ? quoteIdentifier(table.orderBy[index]) : "NULL");
    const row = table.columns.map(quoteIdentifier).join(", ");
    return `SELECT ${tableIndex} AS table_index, ${orderColumns[0]} AS order_1, ${orderColumns[1]} AS order_2, ${orderColumns[2]} AS order_3, json_array(${row}) AS row_json FROM ${quoteIdentifier(table.name)}`;
  });
  return `SELECT table_index, row_json FROM (${selects.join(" UNION ALL ")}) ORDER BY table_index ASC, order_1 ASC, order_2 ASC, order_3 ASC`;
}

export function migrationSchemaSelectSql() {
  const tableNames = MIGRATION_APPLICATION_TABLES.map((table) => `'${table}'`).join(", ");
  return `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN (${tableNames}) AND type IN ('table', 'index', 'trigger') AND sql IS NOT NULL ORDER BY type ASC, name ASC`;
}

export function migrationLedgerSelectSql() {
  return "SELECT id, name FROM d1_migrations ORDER BY id ASC";
}

export function migrationFreezeMarkerSelectSql() {
  return "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', activated_at) AS write_frozen_at, CASE WHEN activated_at <= datetime('now', '-15 minutes') THEN 1 ELSE 0 END AS ready FROM migration_control WHERE freeze_id = ? AND deactivated_at IS NULL AND (SELECT COUNT(*) FROM migration_control WHERE deactivated_at IS NULL) = 1 LIMIT 1";
}

export function migrationArchiveActivitySelectSql() {
  return "SELECT COUNT(*) AS active_count FROM external_archives WHERE status = 'pending'";
}

function normalizeD1Value(value) {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value)) return value;
  throw new TypeError("Migration export encountered an unsupported D1 value");
}

async function hmacSha256Hex(value, base64UrlKey) {
  const rawKey = base64UrlToBytes(base64UrlKey, 64);
  if (rawKey.byteLength !== 32) throw new Error("Migration authentication key is invalid");
  try {
    const key = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
    return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    rawKey.fill(0);
  }
}

function normalizedSchemaRows(result) {
  if (!result || result.success === false || !Array.isArray(result.results)) throw new Error("Migration export could not verify its source schema");
  const rows = result.results.map((row) => {
    if (!isPlainRecord(row)) throw new Error("Migration source schema contains an invalid row");
    return MIGRATION_SCHEMA_COLUMNS.map((column) => {
      const value = row[column];
      if (typeof value !== "string" || !value) throw new Error(`Migration source schema omitted ${column}`);
      return value;
    });
  });
  const expectedTables = new Set(MIGRATION_APPLICATION_TABLES);
  const actualTables = rows.filter(([type, name, tableName]) => type === "table" && name === tableName).map(([, name]) => name);
  if (actualTables.length !== expectedTables.size || actualTables.some((name) => !expectedTables.has(name))) throw new Error("Migration source schema is incomplete");
  return rows;
}

export async function migrationSchemaFingerprint(result) {
  return sha256Hex(canonicalJson({ columns: MIGRATION_SCHEMA_COLUMNS, rows: normalizedSchemaRows(result) }));
}

export function migrationNamesFromLedger(result) {
  if (!result || result.success === false || !Array.isArray(result.results)) throw new Error("Migration export could not verify its migration ledger");
  const names = result.results.map((row, index) => {
    if (!isPlainRecord(row) || row.id !== index + 1 || typeof row.name !== "string") throw new Error("Migration ledger is malformed");
    return row.name;
  });
  if (canonicalJson(names) !== canonicalJson(MIGRATION_EXPORT_EXPECTED_MIGRATIONS)) throw new Error("Migration ledger does not match the required application schema");
  return names;
}

export async function buildMigrationPayload({ sourceOrigin, authKey, freezeId, notBefore, notAfter, expectedSchemaSha256, batchResults, exportedAt = new Date().toISOString() }) {
  const exactSourceOrigin = exactOrigin(sourceOrigin, "sourceOrigin");
  if (typeof authKey !== "string" || !BASE64URL_PATTERN.test(authKey) || authKey.length !== 43 || base64UrlToBytes(authKey, 64).byteLength !== 32) throw new Error("Migration authentication key is invalid");
  if (typeof freezeId !== "string" || !UUID_V4_PATTERN.test(freezeId)) throw new Error("Migration freeze generation is invalid");
  if (!Array.isArray(batchResults) || batchResults.length !== MIGRATION_EXPORT_TABLES.length + 4) throw new Error("Migration export returned an incomplete D1 batch");
  if (typeof exportedAt !== "string" || !Number.isFinite(Date.parse(exportedAt))) throw new Error("Migration export timestamp is invalid");
  if (typeof notBefore !== "string" || !Number.isFinite(Date.parse(notBefore))) throw new Error("Migration export start is invalid");
  if (typeof notAfter !== "string" || !Number.isFinite(Date.parse(notAfter))) throw new Error("Migration export expiry is invalid");
  const normalizedExportedAt = new Date(exportedAt).toISOString();
  const freezeRow = batchResults[2]?.results?.[0];
  if (!batchResults[2] || batchResults[2].success === false || !isPlainRecord(freezeRow)
    || typeof freezeRow.write_frozen_at !== "string" || !Number.isFinite(Date.parse(freezeRow.write_frozen_at))
    || freezeRow.ready !== 1) throw new Error("Migration write freeze has not completed its drain window");
  const normalizedWriteFrozenAt = new Date(freezeRow.write_frozen_at).toISOString();
  const archiveActivityRow = batchResults[3]?.results?.[0];
  if (!batchResults[3] || batchResults[3].success === false || !isPlainRecord(archiveActivityRow)
    || archiveActivityRow.active_count !== 0) throw new Error("Migration export found an active external archive operation");
  const normalizedNotBefore = new Date(notBefore).toISOString();
  const normalizedNotAfter = new Date(notAfter).toISOString();
  if (Date.parse(normalizedNotBefore) - Date.parse(normalizedWriteFrozenAt) < MIGRATION_EXPORT_MINIMUM_FREEZE_MS
    || Date.parse(normalizedNotBefore) > Date.parse(normalizedExportedAt)
    || Date.parse(normalizedNotAfter) < Date.parse(normalizedExportedAt)
    || Date.parse(normalizedNotAfter) - Date.parse(normalizedNotBefore) > 60 * 60 * 1000) throw new Error("Migration export is outside the one-hour window");
  const migrationNames = migrationNamesFromLedger(batchResults[0]);
  const schemaSha256 = await migrationSchemaFingerprint(batchResults[1]);
  if (!constantTimeTextEqual(schemaSha256, expectedSchemaSha256)) throw new Error("Migration source and verified target schemas do not match");

  const tables = [];
  for (let index = 0; index < MIGRATION_EXPORT_TABLES.length; index += 1) {
    const spec = MIGRATION_EXPORT_TABLES[index];
    const result = batchResults[index + 4];
    tables.push(await migrationTableFromD1Result(spec, result));
  }

  const body = {
    exportedAt: normalizedExportedAt,
    format: MIGRATION_EXPORT_FORMAT,
    freezeId: freezeId.toLowerCase(),
    migrationNames,
    schemaSha256,
    sourceOrigin: exactSourceOrigin,
    tables,
    version: MIGRATION_EXPORT_VERSION,
    writeFrozenAt: normalizedWriteFrozenAt,
    windowNotBefore: normalizedNotBefore,
    windowNotAfter: normalizedNotAfter,
  };
  const authenticatedBody = { ...body, manifestSha256: await sha256Hex(canonicalJson(body)) };
  const payload = { ...authenticatedBody, sourceHmacSha256: await hmacSha256Hex(canonicalJson(authenticatedBody), authKey) };
  const encoded = encoder.encode(canonicalJson(payload));
  if (encoded.byteLength > MIGRATION_EXPORT_MAX_PLAINTEXT_BYTES) throw new RangeError("Migration export exceeds the encrypted archive size limit");
  return payload;
}

async function migrationTableFromD1Result(spec, result) {
  if (!result || result.success === false || !Array.isArray(result.results)) throw new Error(`Migration export failed while reading ${spec.name}`);
  const rows = result.results.map((row) => {
    if (!isPlainRecord(row)) throw new TypeError(`Migration export returned an invalid ${spec.name} row`);
    return spec.columns.map((column) => {
      if (!(column in row)) throw new Error(`Migration export omitted ${spec.name}.${column}`);
      return normalizeD1Value(row[column]);
    });
  });
  const tableBody = { name: spec.name, columns: [...spec.columns], rows };
  return { ...tableBody, rowCount: rows.length, sha256: await sha256Hex(canonicalJson(tableBody)) };
}

export async function assertMigrationTableResultsMatch(payload, batchResults) {
  if (!Array.isArray(batchResults) || batchResults.length !== MIGRATION_EXPORT_TABLES.length) throw new Error("Target migration verification returned an incomplete D1 batch");
  for (let index = 0; index < MIGRATION_EXPORT_TABLES.length; index += 1) {
    const expected = payload.tables[index];
    const actual = await migrationTableFromD1Result(MIGRATION_EXPORT_TABLES[index], batchResults[index]);
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`Target migration table ${MIGRATION_EXPORT_TABLES[index].name} does not match its source snapshot`);
  }
  return true;
}

export async function assertMigrationCombinedResultMatches(payload, result) {
  if (!result || result.success === false || !Array.isArray(result.results)) throw new Error("Target migration verification returned an invalid combined result");
  const rowsByTable = MIGRATION_EXPORT_TABLES.map(() => []);
  for (const resultRow of result.results) {
    if (!isPlainRecord(resultRow) || !Number.isSafeInteger(resultRow.table_index)
      || resultRow.table_index < 0 || resultRow.table_index >= MIGRATION_EXPORT_TABLES.length
      || typeof resultRow.row_json !== "string") throw new Error("Target migration verification returned a malformed combined row");
    let values;
    try {
      values = JSON.parse(resultRow.row_json);
    } catch {
      throw new Error("Target migration verification returned malformed row JSON");
    }
    const spec = MIGRATION_EXPORT_TABLES[resultRow.table_index];
    if (!Array.isArray(values) || values.length !== spec.columns.length) throw new Error(`Target migration verification returned a malformed ${spec.name} row`);
    rowsByTable[resultRow.table_index].push(values.map(normalizeD1Value));
  }
  for (let index = 0; index < MIGRATION_EXPORT_TABLES.length; index += 1) {
    const spec = MIGRATION_EXPORT_TABLES[index];
    const tableBody = { name: spec.name, columns: [...spec.columns], rows: rowsByTable[index] };
    const actual = { ...tableBody, rowCount: tableBody.rows.length, sha256: await sha256Hex(canonicalJson(tableBody)) };
    if (canonicalJson(actual) !== canonicalJson(payload.tables[index])) throw new Error(`Target migration table ${spec.name} does not match its source snapshot`);
  }
  return true;
}

const ENVELOPE_ADDITIONAL_DATA = encoder.encode(`${MIGRATION_ENVELOPE_FORMAT}:${MIGRATION_EXPORT_VERSION}:RSA-OAEP-256:A256GCM`);

export async function encryptMigrationPayload(payload, publicKeyJwk) {
  const normalizedPublicKey = normalizedPublicKeyJwk(JSON.stringify(publicKeyJwk));
  const publicKey = await crypto.subtle.importKey("jwk", normalizedPublicKey, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const contentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const rawContentKey = new Uint8Array(await crypto.subtle.exportKey("raw", contentKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(canonicalJson(payload));
  if (plaintext.byteLength > MIGRATION_EXPORT_MAX_PLAINTEXT_BYTES) throw new RangeError("Migration export exceeds the encrypted archive size limit");
  try {
    const [wrappedKey, ciphertext] = await Promise.all([
      crypto.subtle.encrypt({ name: "RSA-OAEP", label: ENVELOPE_ADDITIONAL_DATA }, publicKey, rawContentKey),
      crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ENVELOPE_ADDITIONAL_DATA, tagLength: 128 }, contentKey, plaintext),
    ]);
    return {
      contentAlgorithm: "A256GCM",
      ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
      format: MIGRATION_ENVELOPE_FORMAT,
      iv: bytesToBase64Url(iv),
      keyAlgorithm: "RSA-OAEP-256",
      version: MIGRATION_EXPORT_VERSION,
      wrappedKey: bytesToBase64Url(new Uint8Array(wrappedKey)),
    };
  } finally {
    rawContentKey.fill(0);
  }
}

function assertEnvelope(envelope) {
  if (!isPlainRecord(envelope)
    || envelope.format !== MIGRATION_ENVELOPE_FORMAT
    || envelope.version !== MIGRATION_EXPORT_VERSION
    || envelope.keyAlgorithm !== "RSA-OAEP-256"
    || envelope.contentAlgorithm !== "A256GCM") throw new Error("Unsupported migration envelope");
}

export async function decryptMigrationEnvelope(envelope, privateKeyJwk) {
  assertEnvelope(envelope);
  assertStrongRsaPublicComponents(privateKeyJwk, "Migration private key");
  if (typeof privateKeyJwk.d !== "string" || !BASE64URL_PATTERN.test(privateKeyJwk.d)) throw new Error("Migration private key is malformed");
  const wrappedKey = base64UrlToBytes(envelope.wrappedKey, 2_048);
  const iv = base64UrlToBytes(envelope.iv, 32);
  const ciphertext = base64UrlToBytes(envelope.ciphertext);
  if (iv.byteLength !== 12 || ciphertext.byteLength < 17) throw new Error("Malformed migration envelope");
  const privateKey = await crypto.subtle.importKey("jwk", privateKeyJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
  const rawContentKey = new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP", label: ENVELOPE_ADDITIONAL_DATA }, privateKey, wrappedKey));
  let contentKey;
  try {
    if (rawContentKey.byteLength !== 32) throw new Error("Malformed migration content key");
    contentKey = await crypto.subtle.importKey("raw", rawContentKey, { name: "AES-GCM" }, false, ["decrypt"]);
  } finally {
    rawContentKey.fill(0);
  }
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: ENVELOPE_ADDITIONAL_DATA, tagLength: 128 }, contentKey, ciphertext);
  if (plaintext.byteLength > MIGRATION_EXPORT_MAX_PLAINTEXT_BYTES) throw new RangeError("Decrypted migration archive is too large");
  const decoded = decoder.decode(plaintext);
  return parseCanonicalMigrationJson(decoded);
}

function constantTimeTextEqual(left, right) {
  const leftBytes = encoder.encode(typeof left === "string" ? left : "");
  const rightBytes = encoder.encode(typeof right === "string" ? right : "");
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  return difference === 0;
}

function assertMigrationCell(value) {
  if (value === null || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value)) return;
  throw new Error("Migration payload contains an invalid D1 cell");
}

export async function verifyMigrationPayload(payload, { expectedAuthKey, expectedSourceOrigin }) {
  if (!isPlainRecord(payload)
    || payload.format !== MIGRATION_EXPORT_FORMAT
    || payload.version !== MIGRATION_EXPORT_VERSION
    || typeof payload.freezeId !== "string"
    || !UUID_V4_PATTERN.test(payload.freezeId)
    || canonicalJson(payload.migrationNames) !== canonicalJson(MIGRATION_EXPORT_EXPECTED_MIGRATIONS)
    || !SHA256_PATTERN.test(payload.schemaSha256 || "")
    || !Array.isArray(payload.tables)
    || payload.tables.length !== MIGRATION_EXPORT_TABLES.length
    || !SHA256_PATTERN.test(payload.manifestSha256 || "")
    || !SHA256_PATTERN.test(payload.sourceHmacSha256 || "")) throw new Error("Unsupported or incomplete migration payload");
  if (!constantTimeTextEqual(payload.sourceOrigin, exactOrigin(expectedSourceOrigin, "expectedSourceOrigin"))) throw new Error("Migration export source origin does not match");
  if (typeof payload.exportedAt !== "string" || !Number.isFinite(Date.parse(payload.exportedAt))) throw new Error("Migration export timestamp is invalid");
  if (typeof payload.windowNotAfter !== "string" || !Number.isFinite(Date.parse(payload.windowNotAfter))) throw new Error("Migration export expiry is invalid");
  if (typeof payload.windowNotBefore !== "string" || !Number.isFinite(Date.parse(payload.windowNotBefore))) throw new Error("Migration export start is invalid");
  if (typeof payload.writeFrozenAt !== "string" || !Number.isFinite(Date.parse(payload.writeFrozenAt))) throw new Error("Migration write-freeze timestamp is invalid");
  if (Date.parse(payload.windowNotBefore) - Date.parse(payload.writeFrozenAt) < MIGRATION_EXPORT_MINIMUM_FREEZE_MS
    || Date.parse(payload.windowNotBefore) > Date.parse(payload.exportedAt)
    || Date.parse(payload.windowNotAfter) < Date.parse(payload.exportedAt)
    || Date.parse(payload.windowNotAfter) - Date.parse(payload.windowNotBefore) > 60 * 60 * 1000) throw new Error("Migration export is outside the one-hour window");

  for (let index = 0; index < MIGRATION_EXPORT_TABLES.length; index += 1) {
    const spec = MIGRATION_EXPORT_TABLES[index];
    const table = payload.tables[index];
    if (!isPlainRecord(table)
      || table.name !== spec.name
      || canonicalJson(table.columns) !== canonicalJson(spec.columns)
      || !Array.isArray(table.rows)
      || table.rowCount !== table.rows.length
      || !Number.isSafeInteger(table.rowCount)
      || table.rowCount < 0
      || !SHA256_PATTERN.test(table.sha256 || "")) throw new Error(`Migration table ${spec.name} is malformed`);
    for (const row of table.rows) {
      if (!Array.isArray(row) || row.length !== spec.columns.length) throw new Error(`Migration table ${spec.name} has a malformed row`);
      for (const value of row) assertMigrationCell(value);
    }
    const expectedTableHash = await sha256Hex(canonicalJson({ name: table.name, columns: table.columns, rows: table.rows }));
    if (!constantTimeTextEqual(table.sha256, expectedTableHash)) throw new Error(`Migration table ${spec.name} failed its integrity check`);
  }

  const { manifestSha256, sourceHmacSha256, ...body } = payload;
  const expectedManifestHash = await sha256Hex(canonicalJson(body));
  if (!constantTimeTextEqual(manifestSha256, expectedManifestHash)) throw new Error("Migration manifest failed its integrity check");
  const expectedHmac = await hmacSha256Hex(canonicalJson({ ...body, manifestSha256 }), expectedAuthKey);
  if (!constantTimeTextEqual(sourceHmacSha256, expectedHmac)) throw new Error("Migration source authentication failed");
  return payload;
}

export async function verifyFreshMigrationPayload(payload, expectations, now = Date.now()) {
  await verifyMigrationPayload(payload, expectations);
  const exportedAt = Date.parse(payload.exportedAt);
  const notBefore = Date.parse(payload.windowNotBefore);
  const notAfter = Date.parse(payload.windowNotAfter);
  const clockSkewMs = 5 * 60 * 1000;
  if (exportedAt > now + clockSkewMs) throw new Error("Migration export timestamp is in the future");
  if (now < notBefore - clockSkewMs) throw new Error("Migration export window has not started");
  if (now > notAfter + clockSkewMs) throw new Error("Migration export window has expired");
  return payload;
}

export function assertMigrationAdministratorCanReenter(payload, administratorMemberId, administratorAccountUserId) {
  if (typeof administratorMemberId !== "string" || !administratorMemberId
    || typeof administratorAccountUserId !== "string" || !administratorAccountUserId) throw new Error("Migration administrator identity is missing");
  const membersTable = payload.tables.find((table) => table.name === "members");
  const identitiesTable = payload.tables.find((table) => table.name === "auth_identities");
  if (!membersTable || !identitiesTable) throw new Error("Migration identity tables are missing");
  const memberIdIndex = membersTable.columns.indexOf("id");
  const memberStatusIndex = membersTable.columns.indexOf("status");
  const memberAccountUserIdIndex = membersTable.columns.indexOf("account_user_id");
  const activeMember = membersTable.rows.some((row) => row[memberIdIndex] === administratorMemberId
    && row[memberStatusIndex] === "active"
    && row[memberAccountUserIdIndex] === administratorAccountUserId);
  const identityMemberIndex = identitiesTable.columns.indexOf("member_id");
  const providerIndex = identitiesTable.columns.indexOf("provider");
  const providerSubjectIndex = identitiesTable.columns.indexOf("provider_subject");
  const unlinkedAtIndex = identitiesTable.columns.indexOf("unlinked_at");
  const activeExternalIdentity = identitiesTable.rows.some((row) => {
    if (row[identityMemberIndex] !== administratorMemberId || row[unlinkedAtIndex] !== null) return false;
    const provider = row[providerIndex];
    const subject = row[providerSubjectIndex];
    if (provider === "github") return typeof subject === "string" && /^[1-9]\d{0,31}$/u.test(subject);
    return provider === "feishu" && typeof subject === "string" && /^[A-Za-z0-9_-]{4,128}:[A-Za-z0-9_-]{4,128}:ou[-_][A-Za-z0-9_-]{4,125}$/u.test(subject);
  });
  if (!activeMember || !activeExternalIdentity) throw new Error("The exporting administrator must bind an active GitHub or Feishu identity before migration");
}
