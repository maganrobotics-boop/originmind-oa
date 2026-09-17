import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { referencedKnowledgeAssetPaths, assertKnowledgeRevisionAssetsReady } = await vite.ssrLoadModule("/lib/knowledge-assets.ts");
const migrations = await Promise.all(["0031_knowledge_assets", "0032_knowledge_asset_upload_state", "0033_knowledge_asset_finalization"].map((name) => readFile(new URL(`../drizzle/${name}.sql`, import.meta.url), "utf8")));

function fixture(t) {
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
  for (const migration of migrations) sqlite.exec(migration);
  const database = { prepare(sql) { return { bind(...values) { return {
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
  }; } }; } };
  return { sqlite, database };
}

test("OA readiness recognizes a mixed Word-exported document without losing Markdown validation", () => {
  assert.deepEqual(referencedKnowledgeAssetPaths([
    '<img src="assets/image31.png" style="width:4.1in" alt="小车">',
    '![侧视图](assets/image32.webp)',
    '<img src="./assets/image31.png">',
  ].join("\n")), ["assets/image31.png", "assets/image32.webp"]);
  assert.throws(() => referencedKnowledgeAssetPaths('![非法](assets/../private.png)'), /路径不合法/u);
});

for (const multipart of [false, true]) {
  test(`HTML image approval remains blocked until staged bytes are ready, multipart=${multipart}`, async (t) => {
    const { sqlite, database } = fixture(t);
    const content = '<img src="assets/image31.png" style="width:4.18557in;height:2.3in" alt="差速轮式小车正视与侧视" />';
    if (multipart) sqlite.prepare("INSERT INTO knowledge_revision_parts VALUES ('revision','item',1,?)").run(content);
    else sqlite.prepare("UPDATE knowledge_revisions SET content=? WHERE id='revision'").run(content);
    await assert.rejects(assertKnowledgeRevisionAssetsReady(database, "item", "revision"), /assets\/image31\.png/u);
    sqlite.prepare(`
      INSERT INTO knowledge_revision_assets
        (id,item_id,revision_id,asset_path,storage_key,mime_type,byte_size,sha256,upload_token,upload_state)
      VALUES ('asset','item','revision','assets/image31.png','fixture/image31.png','image/png',68,?,'fixture-token','staged')
    `).run("a".repeat(64));
    await assert.rejects(assertKnowledgeRevisionAssetsReady(database, "item", "revision"), /assets\/image31\.png/u);
    sqlite.exec("UPDATE knowledge_revision_assets SET upload_state='ready' WHERE id='asset'");
    await assert.doesNotReject(assertKnowledgeRevisionAssetsReady(database, "item", "revision"));
  });
}
