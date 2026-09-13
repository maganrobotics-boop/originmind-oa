import {
  assertMigrationCombinedResultMatches,
  MIGRATION_APPLICATION_TABLES,
  MIGRATION_EXPORT_MAX_PLAINTEXT_BYTES,
  migrationCombinedVerificationSelectSql,
  migrationLedgerSelectSql,
  migrationNamesFromLedger,
  parseCanonicalMigrationJson,
  migrationSchemaFingerprint,
  migrationSchemaSelectSql,
  verifyFreshMigrationPayload,
} from "../lib/migration-export.mjs";
import {
  assertMigrationPayloadRelationships,
  materializeMigrationDerivedTables,
  type MigrationPayload,
} from "../lib/migration-import";
import {
  migrationAdministratorEmails,
  migrationImportD1QueryCount,
  migrationImportRowBatches,
  MIGRATION_IMPORT_FIXED_D1_QUERIES,
  MIGRATION_IMPORT_MAX_D1_QUERIES,
  MIGRATION_IMPORT_TABLE_ORDER,
} from "../lib/migration-import-plan.mjs";

interface Env {
  DB: D1Database;
  MIGRATION_IMPORT_TOKEN: string;
  MIGRATION_IMPORT_AUTH_KEY: string;
  MIGRATION_IMPORT_ADMIN_EMAILS: string;
  MIGRATION_IMPORT_EXPECTED_ORIGIN: string;
  MIGRATION_IMPORT_EXPECTED_SCHEMA_SHA256: string;
  MIGRATION_IMPORT_EXPECTED_FREEZE_ID: string;
  MIGRATION_IMPORT_READY_PROOF: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const TRANSIENT_TABLES = Object.freeze(["member_sessions", "oauth_sessions", "oauth_transactions", "write_rate_buckets", "migration_control"]);

function json(body: object, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  return difference === 0;
}

function quoteIdentifier(value: string) {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error("Unsafe migration identifier");
  return `"${value}"`;
}

function emptyTablesSelectSql() {
  return `SELECT ${MIGRATION_APPLICATION_TABLES.map((table) => `(SELECT COUNT(*) FROM ${quoteIdentifier(table)}) AS ${quoteIdentifier(table)}`).join(", ")}, (SELECT COALESCE(MAX(seq), 0) FROM sqlite_sequence WHERE name IN ('approval_events', 'member_events')) AS event_sequence`;
}

function transientStateSelectSql() {
  return `SELECT ${TRANSIENT_TABLES.map((table) => `(SELECT COUNT(*) FROM ${quoteIdentifier(table)}) AS ${quoteIdentifier(table)}`).join(", ")}, (SELECT COUNT(*) FROM write_rate_buckets WHERE bucket_key = ? AND actor_subject = ? AND scope = 'migration_import') AS matching_guard`;
}

function targetIsEmpty(result: D1Result) {
  const row = result.results?.[0] as Record<string, unknown> | undefined;
  if (!row) return false;
  return MIGRATION_APPLICATION_TABLES.every((table) => row[table] === 0) && row.event_sequence === 0;
}

function transientState(result: D1Result) {
  const row = result.results?.[0] as Record<string, unknown> | undefined;
  if (!row) return "conflict" as const;
  const sessionsEmpty = TRANSIENT_TABLES.filter((table) => table !== "write_rate_buckets").every((table) => row[table] === 0);
  if (sessionsEmpty && row.write_rate_buckets === 0 && row.matching_guard === 0) return "empty" as const;
  if (sessionsEmpty && row.write_rate_buckets === 1 && row.matching_guard === 1) return "guard" as const;
  return "conflict" as const;
}

function migrationTable(payload: MigrationPayload, name: string) {
  const table = payload.tables.find((candidate) => candidate.name === name);
  if (!table) throw new Error(`Migration table ${name} is missing`);
  return table;
}

function guardExistsSql() {
  return "EXISTS (SELECT 1 FROM write_rate_buckets WHERE bucket_key = ? AND actor_subject = ? AND scope = 'migration_import')";
}

function buildInsertStatements(db: D1Database, payload: MigrationPayload, guardKey: string, actorSubject: string) {
  const statements: D1PreparedStatement[] = [];
  const expectedChanges: number[] = [];
  for (const tableName of MIGRATION_IMPORT_TABLE_ORDER) {
    const table = migrationTable(payload, tableName);
    for (const rows of migrationImportRowBatches(table)) {
      const columnSql = table.columns.map(quoteIdentifier).join(", ");
      const valuesSql = table.columns.map((_, index) => `json_extract(row_json, '$[${index}]')`).join(", ");
      const sql = `WITH incoming(row_json) AS (SELECT value FROM json_each(?)) INSERT INTO ${quoteIdentifier(table.name)} (${columnSql}) SELECT ${valuesSql} FROM incoming WHERE ${guardExistsSql()}`;
      statements.push(db.prepare(sql).bind(JSON.stringify(rows), guardKey, actorSubject));
      expectedChanges.push(rows.length);
    }
  }
  return { statements, expectedChanges };
}

function configuredAdministratorEmails(env: Env) {
  try {
    return migrationAdministratorEmails(env.MIGRATION_IMPORT_ADMIN_EMAILS);
  } catch {
    return null;
  }
}

function safeConfiguration(env: Env) {
  return configuredAdministratorEmails(env) !== null
    && typeof env.MIGRATION_IMPORT_TOKEN === "string" && /^[A-Za-z0-9_-]{43}$/u.test(env.MIGRATION_IMPORT_TOKEN)
    && typeof env.MIGRATION_IMPORT_AUTH_KEY === "string" && /^[A-Za-z0-9_-]{43}$/u.test(env.MIGRATION_IMPORT_AUTH_KEY)
    && typeof env.MIGRATION_IMPORT_EXPECTED_SCHEMA_SHA256 === "string" && /^[a-f0-9]{64}$/u.test(env.MIGRATION_IMPORT_EXPECTED_SCHEMA_SHA256)
    && typeof env.MIGRATION_IMPORT_EXPECTED_FREEZE_ID === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(env.MIGRATION_IMPORT_EXPECTED_FREEZE_ID)
    && typeof env.MIGRATION_IMPORT_READY_PROOF === "string" && /^[A-Za-z0-9_-]{43}$/u.test(env.MIGRATION_IMPORT_READY_PROOF)
    && typeof env.MIGRATION_IMPORT_EXPECTED_ORIGIN === "string";
}

class MigrationImportStateError extends Error {
  constructor(readonly state: "commit_status_unknown" | "committed_unverified" | "committed_verified_cleanup_pending") {
    super(state);
  }
}

async function verifyTargetTables(env: Env, payload: MigrationPayload, guardKey: string, actorSubject: string) {
  const results = await env.DB.batch([
    env.DB.prepare(migrationCombinedVerificationSelectSql()),
    env.DB.prepare(transientStateSelectSql()).bind(guardKey, actorSubject),
  ]);
  await assertMigrationCombinedResultMatches(payload, results[0]);
  return transientState(results.at(-1) as D1Result);
}

async function clearVerifiedGuard(env: Env, guardKey: string, actorSubject: string) {
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM write_rate_buckets WHERE bucket_key = ? AND actor_subject = ? AND scope = 'migration_import'").bind(guardKey, actorSubject),
    env.DB.prepare(transientStateSelectSql()).bind(guardKey, actorSubject),
  ]);
  return results[0]?.meta?.changes === 1 && transientState(results[1]) === "empty";
}

function successBody(payload: MigrationPayload, state: "imported_verified" | "already_imported_verified" | "recovered_import_verified") {
  return {
    ok: true,
    state,
    manifestSha256: payload.manifestSha256,
    schemaSha256: payload.schemaSha256,
    tables: payload.tables.map((table) => ({ name: table.name, rowCount: table.rowCount, sha256: table.sha256 })),
  };
}

async function importPayload(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || url.pathname !== "/import" || request.method !== "POST") return json({ error: "Not found" }, 404);
  if (!safeConfiguration(env)) return json({ error: "Import configuration is invalid" }, 503);
  const authorization = request.headers.get("authorization") || "";
  if (!constantTimeEqual(authorization, `Bearer ${env.MIGRATION_IMPORT_TOKEN}`)) return json({ error: "Forbidden" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "Content type must be JSON" }, 415);
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MIGRATION_EXPORT_MAX_PLAINTEXT_BYTES) return json({ error: "Migration payload is too large" }, 413);
  const encoded = new Uint8Array(await request.arrayBuffer());
  if (!encoded.byteLength || encoded.byteLength > MIGRATION_EXPORT_MAX_PLAINTEXT_BYTES) return json({ error: "Migration payload is too large" }, 413);
  const serialized = decoder.decode(encoded);
  const payload = parseCanonicalMigrationJson(serialized) as MigrationPayload;
  await verifyFreshMigrationPayload(payload, {
    expectedAuthKey: env.MIGRATION_IMPORT_AUTH_KEY,
    expectedSourceOrigin: env.MIGRATION_IMPORT_EXPECTED_ORIGIN,
  });
  if (payload.freezeId !== env.MIGRATION_IMPORT_EXPECTED_FREEZE_ID.toLowerCase()) throw new Error("Migration freeze generation does not match the selected attempt");
  await assertMigrationPayloadRelationships(payload, {
    administratorEmails: migrationAdministratorEmails(env.MIGRATION_IMPORT_ADMIN_EMAILS),
  });
  const materializedPayload = await materializeMigrationDerivedTables(payload);

  const preflight = await env.DB.batch([
    env.DB.prepare(migrationLedgerSelectSql()),
    env.DB.prepare(migrationSchemaSelectSql()),
    env.DB.prepare(emptyTablesSelectSql()),
  ]);
  migrationNamesFromLedger(preflight[0]);
  const targetSchemaSha256 = await migrationSchemaFingerprint(preflight[1]);
  if (targetSchemaSha256 !== env.MIGRATION_IMPORT_EXPECTED_SCHEMA_SHA256 || targetSchemaSha256 !== payload.schemaSha256) throw new Error("Target schema does not match the authenticated source snapshot");
  const guardKey = `migration-import:${payload.manifestSha256}`;
  const actorSubject = `migration:${payload.manifestSha256}`;
  if (!targetIsEmpty(preflight[2])) {
    try {
      const existingState = await verifyTargetTables(env, materializedPayload, guardKey, actorSubject);
      if (existingState === "empty") return json(successBody(payload, "already_imported_verified"));
      if (existingState === "guard") {
        try {
          if (!await clearVerifiedGuard(env, guardKey, actorSubject)) throw new Error("guard cleanup was incomplete");
        } catch {
          throw new MigrationImportStateError("committed_verified_cleanup_pending");
        }
        return json(successBody(payload, "recovered_import_verified"));
      }
    } catch (error) {
      if (error instanceof MigrationImportStateError) throw error;
    }
    return json({ error: "Staging target is non-empty and does not exactly match this migration snapshot", state: "target_conflict" }, 409);
  }

  const now = new Date().toISOString();
  const emptyConditions = MIGRATION_APPLICATION_TABLES.map((table) => `NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(table)} LIMIT 1)`).join(" AND ");
  const guardInsert = env.DB.prepare(`INSERT INTO write_rate_buckets (bucket_key, actor_subject, scope, window_started_at, used, updated_at) SELECT ?, ?, 'migration_import', ?, 1, ? WHERE ${emptyConditions}`).bind(guardKey, actorSubject, now, now);
  const guardSelect = env.DB.prepare("SELECT bucket_key FROM write_rate_buckets WHERE bucket_key = ? AND actor_subject = ? AND scope = 'migration_import'").bind(guardKey, actorSubject);
  const inserts = buildInsertStatements(env.DB, materializedPayload, guardKey, actorSubject);
  const queryCount = migrationImportD1QueryCount(materializedPayload);
  if (queryCount > MIGRATION_IMPORT_MAX_D1_QUERIES || queryCount !== MIGRATION_IMPORT_FIXED_D1_QUERIES + inserts.statements.length) throw new Error("Migration payload requires too many D1 statements for an atomic free-plan import");

  let results: D1Result[];
  try {
    results = await env.DB.batch([guardInsert, guardSelect, ...inserts.statements]);
  } catch {
    throw new MigrationImportStateError("commit_status_unknown");
  }
  const guardResult = results[1];
  const guardRow = guardResult?.results?.[0] as Record<string, unknown> | undefined;
  if (guardRow?.bucket_key !== guardKey) return json({ error: "Staging target changed before import; no rows were imported", state: "target_changed" }, 409);
  const insertResults = results.slice(2, 2 + inserts.statements.length);
  for (let index = 0; index < insertResults.length; index += 1) {
    if (insertResults[index]?.meta?.changes !== inserts.expectedChanges[index]) throw new MigrationImportStateError("committed_unverified");
  }
  let verifiedState: "empty" | "guard" | "conflict";
  try {
    verifiedState = await verifyTargetTables(env, materializedPayload, guardKey, actorSubject);
  } catch {
    throw new MigrationImportStateError("committed_unverified");
  }
  if (verifiedState !== "guard") throw new MigrationImportStateError("committed_unverified");
  try {
    if (!await clearVerifiedGuard(env, guardKey, actorSubject)) throw new Error("guard cleanup was incomplete");
  } catch {
    throw new MigrationImportStateError("committed_verified_cleanup_pending");
  }
  return json(successBody(payload, "imported_verified"));
}

function readiness(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || url.pathname !== "/ready" || request.method !== "GET") return null;
  if (!safeConfiguration(env)) return json({ error: "Import configuration is invalid" }, 503);
  return json({ ready: env.MIGRATION_IMPORT_READY_PROOF });
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ready = readiness(request, env);
    if (ready) return ready;
    try {
      return await importPayload(request, env);
    } catch (error) {
      if (error instanceof MigrationImportStateError) {
        return json({ error: "Migration import requires read-only verification before any retry", state: error.state }, 500);
      }
      return json({ error: "Migration import was rejected before a verified commit", state: "not_committed" }, 500);
    }
  },
};

export default worker;
