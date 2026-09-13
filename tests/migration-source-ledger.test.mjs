import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { EXPECTED_DRIZZLE_LEDGER, migrationSourceLedgerStatement } from "../lib/migration-source-ledger.mjs";
import { migrationNamesFromLedger, MIGRATION_EXPORT_EXPECTED_MIGRATIONS } from "../lib/migration-export.mjs";

test("source migration ledger pins and recognizes the immutable 0030 entry", async () => {
  assert.equal(EXPECTED_DRIZZLE_LEDGER.length, 31);
  assert.deepEqual(EXPECTED_DRIZZLE_LEDGER.at(-1), {
    name: "0030_large_knowledge_revision_parts.sql",
    createdAt: 1789272000000,
    hash: "7780dc59ced3b6bc07cc8f7c07e6d20af52ddd88fc61e3e76d8ac6e0c3f8c113",
  });
  assert.equal(
    createHash("sha256").update(readFileSync(new URL("../drizzle/0030_large_knowledge_revision_parts.sql", import.meta.url))).digest("hex"),
    EXPECTED_DRIZZLE_LEDGER.at(-1).hash,
  );
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE __drizzle_migrations (id INTEGER, hash TEXT NOT NULL, created_at NUMERIC)");
    const insert = db.prepare("INSERT INTO __drizzle_migrations VALUES (NULL, ?, ?)");
    for (const entry of EXPECTED_DRIZZLE_LEDGER) insert.run(entry.hash, entry.createdAt);
    const adapter = { prepare(sql) { return { async all() { return { success: true, results: db.prepare(sql).all().map((row) => ({ ...row })) }; } }; } };
    const query = await migrationSourceLedgerStatement(adapter);
    assert.deepEqual(migrationNamesFromLedger(await query.all()), MIGRATION_EXPORT_EXPECTED_MIGRATIONS);
  } finally {
    db.close();
  }
});

test("source Drizzle ledger requires exact file hashes, timestamps, and migration order", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE __drizzle_migrations (id INTEGER, hash TEXT NOT NULL, created_at NUMERIC)");
    const insert = db.prepare("INSERT INTO __drizzle_migrations VALUES (NULL, ?, ?)");
    for (const entry of EXPECTED_DRIZZLE_LEDGER) {
      assert.equal(entry.hash, createHash("sha256").update(readFileSync(new URL(`../drizzle/${entry.name}`, import.meta.url))).digest("hex"));
      insert.run(entry.hash, entry.createdAt);
    }
    const adapter = { prepare(sql) { return { async all() { return { success: true, results: db.prepare(sql).all().map((row) => ({ ...row })) }; } }; } };
    const query = await migrationSourceLedgerStatement(adapter);
    assert.deepEqual(migrationNamesFromLedger(await query.all()), MIGRATION_EXPORT_EXPECTED_MIGRATIONS);
    db.exec("UPDATE __drizzle_migrations SET hash = 'tampered' WHERE created_at = (SELECT MAX(created_at) FROM __drizzle_migrations)");
    const changed = await query.all();
    assert.throws(() => migrationNamesFromLedger(changed), /required application schema/);
  } finally { db.close(); }
});

for (const name of ["d1_migrations", "__appgarden_migrations"]) {
  test(`${name} requires the complete ordered migration ledger`, async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)`);
      for (const file of MIGRATION_EXPORT_EXPECTED_MIGRATIONS) db.prepare(`INSERT INTO ${name} (name) VALUES (?)`).run(file);
      const adapter = { prepare(sql) { return { async all() { return { success: true, results: db.prepare(sql).all().map((row) => ({ ...row })) }; } }; } };
      const query = await migrationSourceLedgerStatement(adapter);
      assert.deepEqual(migrationNamesFromLedger(await query.all()), MIGRATION_EXPORT_EXPECTED_MIGRATIONS);
      db.exec(`DELETE FROM ${name} WHERE id = (SELECT MAX(id) FROM ${name})`);
      const incomplete = await query.all();
      assert.throws(() => migrationNamesFromLedger(incomplete), /required application schema/);
    } finally { db.close(); }
  });
}
