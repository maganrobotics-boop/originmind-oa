import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { stageKnowledgeAsset, finalizeKnowledgeAssets } = await vite.ssrLoadModule("/lib/knowledge-asset-upload.ts");
const { persistKnowledgeAssets, listKnowledgeRevisionAssets, referencedKnowledgeAssetPaths, assertKnowledgeRevisionAssetsReady } = await vite.ssrLoadModule("/lib/knowledge-assets.ts");
const migrations = await Promise.all(["0031_knowledge_assets", "0032_knowledge_asset_upload_state", "0033_knowledge_asset_finalization"].map((name) => readFile(new URL(`../drizzle/${name}.sql`, import.meta.url), "utf8")));

class D1Statement {
  constructor(database, sql, bindings = []) { Object.assign(this, { database, sql, bindings }); }
  bind(...bindings) { return new D1Statement(this.database, this.sql, bindings); }
  async first() { return this.database.sqlite.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return { success: true, results: this.database.sqlite.prepare(this.sql).all(...this.bindings) }; }
  async run() {
    if (this.database.failInsert && /INSERT INTO knowledge_revision_assets/.test(this.sql)) {
      this.database.failInsert = false;
      throw new Error("simulated D1 failure");
    }
    if (this.database.beforeUpdate && /UPDATE knowledge_revision_assets/.test(this.sql)) {
      const callback = this.database.beforeUpdate;
      this.database.beforeUpdate = null;
      await callback();
    }
    const result = this.database.sqlite.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class R2Bucket {
  objects = new Map();
  writes = 0;
  async put(key, bytes, options) {
    assert.deepEqual(options.onlyIf, { etagDoesNotMatch: "*" }, "every create must be conditional");
    if (this.objects.has(key)) return null;
    this.writes += 1;
    assert.equal(options.sha256, createHash("sha256").update(Buffer.from(bytes)).digest("hex"));
    const stored = { bytes: bytes.slice(0), httpMetadata: options.httpMetadata, customMetadata: options.customMetadata };
    this.objects.set(key, stored);
    return { key, size: bytes.byteLength };
  }
  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { ...object, size: object.bytes.byteLength, arrayBuffer: async () => object.bytes.slice(0) };
  }
  async delete() { assert.fail("upload retries must never delete immutable objects"); }
}

function fixture(t, through = 3) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`
    CREATE TABLE migration_control (id TEXT PRIMARY KEY, deactivated_at TEXT);
    CREATE TABLE knowledge_items (id TEXT PRIMARY KEY, current_revision_id TEXT, status TEXT);
    CREATE TABLE knowledge_revisions (id TEXT PRIMARY KEY, item_id TEXT, status TEXT, content TEXT DEFAULT '');
    CREATE TABLE knowledge_revision_parts (revision_id TEXT, item_id TEXT, part_no INTEGER, content TEXT);
    INSERT INTO knowledge_items VALUES ('item', 'revision', 'pending');
    INSERT INTO knowledge_revisions VALUES ('revision', 'item', 'pending', '');
  `);
  for (const migration of migrations.slice(0, through)) sqlite.exec(migration);
  const database = { sqlite, prepare(sql) { return new D1Statement(this, sql); } };
  return { sqlite, database, bucket: new R2Bucket() };
}

function input(overrides = {}) {
  return { itemId: "item", revisionId: "revision", uploadToken: "upload-1", path: "assets/figure.png", mimeType: "image/png", body: Uint8Array.from([137, 80, 78, 71]).buffer, ...overrides };
}
function manifest(overrides = {}) {
  return { itemId: "item", revisionId: "revision", uploadToken: "upload-1", expectedPaths: ["assets/figure.png"], ...overrides };
}
function assetRow(sqlite) { return sqlite.prepare("SELECT * FROM knowledge_revision_assets ORDER BY asset_path").get(); }

test("0032 fails immutable finalization; additive 0033 permits only staged to ready", async (t) => {
  const { sqlite, database, bucket } = fixture(t, 2);
  await stageKnowledgeAsset(database, bucket, input());
  assert.equal(assetRow(sqlite).sha256, createHash("sha256").update(Buffer.from(input().body)).digest("hex"));
  await assert.rejects(finalizeKnowledgeAssets(database, manifest()), /immutable/);
  sqlite.exec(migrations[2]);
  assert.deepEqual(await finalizeKnowledgeAssets(database, manifest()), { assetCount: 1 });
  assert.equal(assetRow(sqlite).upload_state, "ready");
  assert.deepEqual(await finalizeKnowledgeAssets(database, manifest()), { assetCount: 1 });
});

test("identical upload retry preserves identity and R2 bytes before and after finalization", async (t) => {
  const { sqlite, database, bucket } = fixture(t);
  await stageKnowledgeAsset(database, bucket, input());
  const first = { ...assetRow(sqlite) };
  assert.deepEqual(await listKnowledgeRevisionAssets(database, "revision"), []);
  await stageKnowledgeAsset(database, bucket, input());
  assert.deepEqual({ ...assetRow(sqlite) }, first);
  await finalizeKnowledgeAssets(database, manifest());
  await stageKnowledgeAsset(database, bucket, input());
  assert.equal(assetRow(sqlite).id, first.id);
  assert.equal(assetRow(sqlite).upload_state, "ready");
  assert.equal(bucket.writes, 1);
  assert.equal((await listKnowledgeRevisionAssets(database, "revision")).length, 1);
  await assert.rejects(stageKnowledgeAsset(database, bucket, input({ path: "assets/late.png" })), /finalized/);
});

test("different bytes, MIME, or upload token cannot overwrite immutable metadata or object", async (t) => {
  const { sqlite, database, bucket } = fixture(t);
  await stageKnowledgeAsset(database, bucket, input());
  const first = { ...assetRow(sqlite) };
  for (const change of [{ body: Uint8Array.from([1, 2, 3, 4]).buffer }, { mimeType: "image/jpeg" }, { uploadToken: "other" }]) {
    await assert.rejects(stageKnowledgeAsset(database, bucket, input(change)), /conflicts/);
  }
  assert.deepEqual({ ...assetRow(sqlite) }, first);
  assert.equal(bucket.writes, 1);
  assert.deepEqual(new Uint8Array((await bucket.get(first.storage_key)).bytes), new Uint8Array(input().body));
});

test("D1 failure retains conditional object for same-token retry; conflicting orphan is denied", async (t) => {
  const { sqlite, database, bucket } = fixture(t);
  database.failInsert = true;
  await assert.rejects(stageKnowledgeAsset(database, bucket, input()), /simulated D1 failure/);
  assert.equal(assetRow(sqlite), undefined);
  await assert.rejects(stageKnowledgeAsset(database, bucket, input({ uploadToken: "other" })), /conflicts/);
  await assert.rejects(stageKnowledgeAsset(database, bucket, input({ body: Uint8Array.from([9, 9, 9, 9]).buffer })), /conflicts/);
  await stageKnowledgeAsset(database, bucket, input());
  assert.equal(bucket.writes, 1);
  assert.equal(assetRow(sqlite).upload_state, "staged");
});

test("missing or modified existing R2 bytes fail retry without replacement", async (t) => {
  const { sqlite, database, bucket } = fixture(t);
  await stageKnowledgeAsset(database, bucket, input());
  const key = assetRow(sqlite).storage_key;
  bucket.objects.get(key).bytes = Uint8Array.from([0, 0, 0, 0]).buffer;
  await assert.rejects(stageKnowledgeAsset(database, bucket, input()), /missing or conflicts/);
  bucket.objects.delete(key);
  await assert.rejects(stageKnowledgeAsset(database, bucket, input()), /missing or conflicts/);
  assert.equal(bucket.writes, 1);
});

test("finalization denies empty, duplicate, missing, extra, and foreign-token manifests", async (t) => {
  const { sqlite, database, bucket } = fixture(t);
  await stageKnowledgeAsset(database, bucket, input());
  for (const change of [
    { expectedPaths: [] }, { expectedPaths: ["assets/figure.png", "assets/figure.png"] },
    { expectedPaths: ["assets/missing.png"] }, { expectedPaths: ["assets/figure.png", "assets/extra.png"] },
    { uploadToken: "other" }, { uploadToken: "" },
  ]) await assert.rejects(finalizeKnowledgeAssets(database, manifest(change)), /manifest|incomplete|token/);
  await stageKnowledgeAsset(database, bucket, input({ path: "assets/other.png", uploadToken: "other" }));
  await assert.rejects(finalizeKnowledgeAssets(database, manifest()), /incomplete/);
  await assert.rejects(finalizeKnowledgeAssets(database, manifest({ expectedPaths: ["assets/figure.png", "assets/other.png"] })), /another upload/);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM knowledge_revision_assets WHERE upload_state = 'ready'").get().n, 0);
});

test("concurrent manifest growth cannot partially finalize the earlier snapshot", async (t) => {
  const { sqlite, database, bucket } = fixture(t);
  await stageKnowledgeAsset(database, bucket, input());
  database.beforeUpdate = () => stageKnowledgeAsset(database, bucket, input({ path: "assets/extra.png" }));
  await assert.rejects(finalizeKnowledgeAssets(database, manifest()), /incomplete/);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM knowledge_revision_assets WHERE upload_state = 'ready'").get().n, 0);
});

test("migration freeze and non-current or non-pending revision deny writes", async (t) => {
  const { sqlite, database, bucket } = fixture(t);
  await stageKnowledgeAsset(database, bucket, input());
  for (const change of [
    "UPDATE knowledge_revisions SET status = 'active'", "UPDATE knowledge_items SET status = 'returned'",
    "UPDATE knowledge_items SET current_revision_id = 'new-revision'", "INSERT INTO migration_control VALUES ('freeze', NULL)",
  ]) {
    sqlite.exec(change);
    await assert.rejects(stageKnowledgeAsset(database, bucket, input({ path: "assets/denied.png" })), /not pending|frozen/);
    await assert.rejects(finalizeKnowledgeAssets(database, manifest()), /not pending|frozen/);
    assert.throws(() => sqlite.exec("UPDATE knowledge_revision_assets SET upload_state = 'ready'"), /immutable|freeze/);
    sqlite.exec("UPDATE knowledge_items SET status = 'pending', current_revision_id = 'revision'; UPDATE knowledge_revisions SET status = 'pending'; DELETE FROM migration_control;");
  }
  assert.equal(bucket.writes, 1);
});

test("SQL trigger preserves every immutable field and prevents ready to staged", async (t) => {
  const { sqlite, database, bucket } = fixture(t);
  await stageKnowledgeAsset(database, bucket, input());
  for (const [field, value] of Object.entries({ id: "other", item_id: "other", revision_id: "other", asset_path: "assets/other.png", storage_key: "other", mime_type: "image/jpeg", byte_size: 999, sha256: "b".repeat(64), created_at: "other", upload_token: "other" })) {
    assert.throws(() => sqlite.prepare(`UPDATE knowledge_revision_assets SET upload_state = 'ready', ${field} = ?`).run(value), /immutable/);
  }
  assert.equal(assetRow(sqlite).upload_state, "staged");
  await finalizeKnowledgeAssets(database, manifest());
  assert.throws(() => sqlite.exec("UPDATE knowledge_revision_assets SET upload_state = 'staged'"), /immutable/);
});

test("direct persistence writes SHA256 and a failed retry never deletes earlier assets", async (t) => {
  const { sqlite, database, bucket } = fixture(t);
  const assets = [{ path: input().path, mimeType: input().mimeType, bytes: input().body }];
  const first = await persistKnowledgeAssets(database, bucket, "item", "revision", assets);
  const repeated = await persistKnowledgeAssets(database, bucket, "item", "revision", assets);
  assert.deepEqual(first, repeated);
  await assert.rejects(persistKnowledgeAssets(database, bucket, "item", "revision", [assets[0], { ...assets[0], path: "assets/other.png", bytes: new ArrayBuffer(0) }]));
  assert.equal(assetRow(sqlite).id, first[0].id);
  assert.equal(assetRow(sqlite).sha256.length, 64);
  assert.equal(bucket.writes, 1);
});


test("knowledge approval asset readiness follows markdown references across revision parts", async (t) => {
  const { sqlite, database, bucket } = fixture(t);
  sqlite.prepare("UPDATE knowledge_revisions SET content = ? WHERE id = 'revision'").run("# 图文资料\n![图一](assets/figure.png)\n![带空格](<assets/second_image.webp>)");
  sqlite.prepare("INSERT INTO knowledge_revision_parts VALUES ('revision', 'item', 2, ?)").run("补充段落 ![图二](assets/extra.jpg?cache=1)");
  assert.deepEqual(referencedKnowledgeAssetPaths("![a](assets/figure.png) ![b](<assets/second_image.webp>)"), ["assets/figure.png", "assets/second_image.webp"]);
  await assert.rejects(assertKnowledgeRevisionAssetsReady(database, "item", "revision"), /assets\/figure\.png/);
  await stageKnowledgeAsset(database, bucket, input());
  await stageKnowledgeAsset(database, bucket, input({ path: "assets/second_image.webp", mimeType: "image/webp", body: Uint8Array.from([1, 2, 3]).buffer }));
  await stageKnowledgeAsset(database, bucket, input({ path: "assets/extra.jpg", mimeType: "image/jpeg", body: Uint8Array.from([4, 5, 6]).buffer }));
  await assert.rejects(assertKnowledgeRevisionAssetsReady(database, "item", "revision"), /尚未完整上传/);
  await finalizeKnowledgeAssets(database, manifest({ expectedPaths: ["assets/figure.png", "assets/second_image.webp", "assets/extra.jpg"] }));
  await assertKnowledgeRevisionAssetsReady(database, "item", "revision");
});
