const BLOCKED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MIGRATION_PACKAGE_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const MIGRATION_FREEZE_ACTIVATE_SQL = "INSERT INTO migration_control (freeze_id, activated_at, deactivated_at) SELECT ?, CURRENT_TIMESTAMP, NULL WHERE NOT EXISTS (SELECT 1 FROM migration_control WHERE deactivated_at IS NULL) AND NOT EXISTS (SELECT 1 FROM external_archives WHERE status = 'pending')";
export function isMigrationWriteFrozen(environment: Record<string, unknown>) {
  return typeof environment.OA_MIGRATION_WRITE_FROZEN === "string"
    && environment.OA_MIGRATION_WRITE_FROZEN.trim().toLowerCase() === "true";
}

export function isMigrationUnfreezeEnabled(environment: Record<string, unknown>, now = Date.now()) {
  const packageExpiry = Date.parse(typeof environment.OA_MIGRATION_EXPORT_NOT_AFTER === "string" ? environment.OA_MIGRATION_EXPORT_NOT_AFTER.trim() : "");
  return isMigrationWriteFrozen(environment)
    && typeof environment.OA_MIGRATION_UNFREEZE_ENABLED === "string"
    && environment.OA_MIGRATION_UNFREEZE_ENABLED.trim().toLowerCase() === "true"
    && UUID_V4_PATTERN.test(typeof environment.OA_MIGRATION_FREEZE_ID === "string" ? environment.OA_MIGRATION_FREEZE_ID.trim() : "")
    && Number.isFinite(packageExpiry)
    && now > packageExpiry + MIGRATION_PACKAGE_CLOCK_SKEW_MS;
}

export function shouldBlockForMigrationFreeze(request: Request, environment: Record<string, unknown>) {
  if (!isMigrationWriteFrozen(environment)) return false;
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path === "/api/admin/migration-export") return false;
  if (request.method === "POST" && path === "/api/admin/migration-unfreeze") return false;
  if (request.method === "DELETE" && path === "/api/session") return false;
  if (path.startsWith("/api/auth/")) return true;
  return BLOCKED_METHODS.has(request.method);
}

export function migrationWriteFreezeId(environment: Record<string, unknown>) {
  const freezeId = typeof environment.OA_MIGRATION_FREEZE_ID === "string" ? environment.OA_MIGRATION_FREEZE_ID.trim().toLowerCase() : "";
  if (!UUID_V4_PATTERN.test(freezeId)) throw new Error("Migration freeze generation is unavailable");
  return freezeId;
}

export async function ensureMigrationWriteFreezeMarker(db: D1Database, environment: Record<string, unknown>) {
  if (!isMigrationWriteFrozen(environment)) return null;
  const freezeId = migrationWriteFreezeId(environment);
  await db.prepare(MIGRATION_FREEZE_ACTIVATE_SQL)
    .bind(freezeId)
    .run();
  return freezeId;
}
