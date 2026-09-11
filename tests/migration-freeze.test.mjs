import assert from "node:assert/strict";
import test from "node:test";

import { isMigrationUnfreezeEnabled, migrationWriteFreezeId, shouldBlockForMigrationFreeze } from "../lib/migration-freeze.ts";

const frozen = { OA_MIGRATION_WRITE_FROZEN: "true" };

function request(path, method = "GET") {
  return new Request(`https://oa.example.test${path}`, { method });
}

test("migration write freeze blocks business writes and OAuth callbacks", () => {
  assert.equal(shouldBlockForMigrationFreeze(request("/api/approvals", "POST"), frozen), true);
  assert.equal(shouldBlockForMigrationFreeze(request("/api/profile", "PATCH"), frozen), true);
  assert.equal(shouldBlockForMigrationFreeze(request("/api/auth/github/callback"), frozen), true);
  assert.equal(shouldBlockForMigrationFreeze(request("/api/auth/feishu/callback"), frozen), true);
  assert.equal(shouldBlockForMigrationFreeze(request("/api/auth/github/start"), frozen), true);
  assert.equal(shouldBlockForMigrationFreeze(request("/future-form", "POST"), frozen), true);
});

test("each freeze attempt requires a valid explicit database-gate generation", async () => {
  const first = migrationWriteFreezeId({
    OA_MIGRATION_FREEZE_ID: "11111111-2222-4333-8444-555555555555",
  });
  const second = migrationWriteFreezeId({
    OA_MIGRATION_FREEZE_ID: "66666666-7777-4888-8999-aaaaaaaaaaaa",
  });
  assert.notEqual(first, second);
  assert.throws(
    () => migrationWriteFreezeId({ OA_MIGRATION_FREEZE_ID: "reused-manually" }),
    /generation is unavailable/u,
  );
});

test("migration write freeze permits only snapshot download, reads, recovery, and logout", () => {
  assert.equal(shouldBlockForMigrationFreeze(request("/api/admin/migration-export", "POST"), frozen), false);
  assert.equal(shouldBlockForMigrationFreeze(request("/api/admin/feishu-crosswalk", "POST"), frozen), true);
  assert.equal(shouldBlockForMigrationFreeze(request("/api/approvals"), frozen), false);
  assert.equal(shouldBlockForMigrationFreeze(request("/api/session", "DELETE"), frozen), false);
  assert.equal(shouldBlockForMigrationFreeze(request("/api/admin/migration-unfreeze", "POST"), frozen), false);
  assert.equal(shouldBlockForMigrationFreeze(request("/api/approvals", "POST"), { OA_MIGRATION_WRITE_FROZEN: "false" }), false);
});

test("migration recovery stays hidden unless the exact frozen generation is explicitly enabled", () => {
  const expiredAt = "2026-09-02T00:00:00.000Z";
  const afterExpirySkew = Date.parse(expiredAt) + 5 * 60 * 1000 + 1;
  const enabled = { OA_MIGRATION_WRITE_FROZEN: "true", OA_MIGRATION_UNFREEZE_ENABLED: "true", OA_MIGRATION_FREEZE_ID: "11111111-2222-4333-8444-555555555555", OA_MIGRATION_EXPORT_NOT_AFTER: expiredAt };
  assert.equal(isMigrationUnfreezeEnabled({ ...enabled, OA_MIGRATION_UNFREEZE_ENABLED: "false" }, afterExpirySkew), false);
  assert.equal(isMigrationUnfreezeEnabled(enabled, Date.parse(expiredAt) + 5 * 60 * 1000), false);
  assert.equal(isMigrationUnfreezeEnabled(enabled, afterExpirySkew), true);
  assert.equal(isMigrationUnfreezeEnabled({ ...enabled, OA_MIGRATION_EXPORT_NOT_AFTER: "invalid" }, afterExpirySkew), false);
});
