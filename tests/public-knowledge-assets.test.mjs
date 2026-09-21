import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaPublicKnowledgeAssetsTestState";
const assetId = "11111111-2222-4333-8444-555555555555";
const staleAssetId = "99999999-2222-4333-8444-555555555555";
const image = Uint8Array.from([137, 80, 78, 71]);
const migrations = await Promise.all(["0031_knowledge_assets.sql", "0032_knowledge_asset_upload_state.sql"].map((name) => readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8")));

globalThis[stateKey] = {};
const vite = await createServer({
  appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "public-knowledge-assets-test-env", enforce: "pre",
    resolveId(source) { return source === "cloudflare:workers" ? "\0public-assets-env" : null; },
    load(id) { return id === "\0public-assets-env" ? `export const env = new Proxy({}, {get: (_, key) => globalThis.${stateKey}.env[key]});` : null; },
  }],
});
const assets = await vite.ssrLoadModule("/lib/public-knowledge-assets.ts");
const route = await vite.ssrLoadModule("/app/api/public/lab-ai/assets/[id]/route.ts");
const contract = await vite.ssrLoadModule("/app/api/public/lab-ai/_lib/response-contract.ts");

function installDatabase({ status = "active", visibility = "public", revisionStatus = "active", activeRevision = "revision-1", uploadState = "ready" } = {}) {
  globalThis[stateKey].sqlite?.close();
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE knowledge_items(id TEXT PRIMARY KEY, status TEXT, visibility TEXT, active_revision_id TEXT);
    CREATE TABLE knowledge_revisions(id TEXT PRIMARY KEY, item_id TEXT, status TEXT);`);
  for (const migration of migrations) sqlite.exec(migration);
  sqlite.prepare("INSERT INTO knowledge_items VALUES ('item-1', ?, ?, ?)").run(status, visibility, activeRevision);
  sqlite.prepare("INSERT INTO knowledge_revisions VALUES ('revision-1', 'item-1', ?)").run(revisionStatus);
  sqlite.prepare("INSERT INTO knowledge_revisions VALUES ('revision-old', 'item-1', 'superseded')").run();
  const addAsset = (id, revision, state) => sqlite.prepare(`INSERT INTO knowledge_revision_assets
    (id, item_id, revision_id, asset_path, storage_key, mime_type, byte_size, sha256, upload_state)
    VALUES (?, 'item-1', ?, 'assets/fig_01.png', ?, 'image/png', 4, ?, ?)`)
    .run(id, revision, `private-storage/${revision}/image.png`, "a".repeat(64), state);
  addAsset(assetId, "revision-1", uploadState);
  addAsset(staleAssetId, "revision-old", "ready");
  const state = globalThis[stateKey] = { sqlite, sqlCalls: 0, bucketKeys: [] };
  const DB = { prepare(sql) {
    state.sqlCalls += 1;
    return { bind(...bindings) { return {
      all: async () => ({ results: sqlite.prepare(sql).all(...bindings) }),
      first: async () => sqlite.prepare(sql).get(...bindings) || null,
    }; } };
  } };
  state.env = { DB, KNOWLEDGE_ASSETS: { get: async (key) => {
    state.bucketKeys.push(key);
    return { body: image, size: image.byteLength };
  } } };
  return state;
}

function chunk(id = "public-chunk-1") {
  return { id, itemId: "public-item-1", revisionId: "public-revision-1", title: "机械臂避障", category: "研究资料", sectionTitle: "避障实验", paragraphRef: "第 1 段", content: "机械臂避障实验。![避障过程](assets/fig_01.png)", searchText: "机械臂 避障", sourceLabel: "公开资料", sourceUrl: "", updatedAt: "2026-09-16", score: 10, assetScope: { itemId: "item-1", revisionId: "revision-1" } };
}

function getImage(id = assetId, suffix = "") {
  return route.GET(new Request(`https://oa.omindos.ai/api/public/lab-ai/assets/${id}${suffix}`), { params: Promise.resolve({ id }) });
}

beforeEach(() => installDatabase());
after(async () => { globalThis[stateKey].sqlite?.close(); delete globalThis[stateKey]; await vite.close(); });

test("only local Markdown images become references; code examples, remote URLs and traversal are excluded", () => {
  assert.deepEqual(assets.referencedKnowledgeImages("![remote](https://evil.test/a.png) ![data](data:image/png;base64,AAAA) ![escape](assets/../secret.png) `![code](assets/code.png)`\n```md\n![sample](assets/sample.png)\n```\n![避障过程](./assets/fig_01.png) ![重复](assets/fig_01.png) ![模型](<assets/model.webp> \"caption\")"), [
    { path: "assets/fig_01.png", alt: "避障过程" }, { path: "assets/model.webp", alt: "模型" },
  ]);
  assert.equal(assets.referencedKnowledgeImages(`![${"😀".repeat(150)}](assets/long.png)`)[0].alt.length, 200);
});

test("approved public retrieval resolves only matching revision assets and explicit JSON excludes storage and scope", async () => {
  const state = globalThis[stateKey];
  const ranked = [chunk()];
  const resolved = await assets.getPublicKnowledgeAssetsForChunks(state.env.DB, ranked);
  assert.deepEqual(resolved.get("public-chunk-1"), [{ url: `https://oa.omindos.ai/api/public/lab-ai/assets/${assetId}`, alt: "避障过程", mimeType: "image/png" }]);
  const response = contract.buildPublicLabAiRetrieveResponse(ranked, resolved);
  assert.equal(response.chunks[0].assets[0].alt, "避障过程");
  assert.doesNotMatch(JSON.stringify(response), /assetScope|revision-1|item-1|private-storage|storage_key/);
  assert.equal(await assets.findPublicKnowledgeAsset(state.env.DB, staleAssetId), null);
  assert.equal((await assets.getPublicKnowledgeAssetsForChunks(state.env.DB, [{ ...chunk(), assetScope: { itemId: "item-1", revisionId: "revision-old" } }])).size, 0);
  assert.equal((await assets.getPublicKnowledgeAssetsForChunks(state.env.DB, [{ ...chunk(), assetScope: { itemId: "another-item", revisionId: "revision-1" } }])).size, 0);
});

test("pending, returned, rejected, revoked, internal, stale and staged assets are never retrieved or served", async () => {
  for (const config of [
    { status: "pending" }, { status: "returned" }, { status: "rejected" }, { status: "revoked" },
    { visibility: "internal" }, { revisionStatus: "pending" }, { revisionStatus: "superseded" },
    { activeRevision: "revision-other" }, { uploadState: "staged" },
  ]) {
    const state = installDatabase(config);
    assert.equal((await assets.getPublicKnowledgeAssetsForChunks(state.env.DB, [chunk()])).size, 0, JSON.stringify(config));
    assert.equal((await getImage()).status, 404, JSON.stringify(config));
    assert.deepEqual(state.bucketKeys, [], "ineligible objects must not be read from R2");
  }
});

test("public image GET streams approved bytes with no-store and rechecks visibility on every request", async () => {
  const state = globalThis[stateKey];
  const response = await getImage();
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
  state.sqlite.exec("UPDATE knowledge_items SET visibility = 'internal'");
  assert.equal((await getImage()).status, 404);
  assert.equal(state.bucketKeys.length, 1);
});

test("malformed IDs, missing objects and changed object sizes fail closed", async () => {
  const state = globalThis[stateKey];
  assert.equal((await getImage("not-an-id")).status, 404);
  assert.equal((await getImage(assetId, "?debug=1")).status, 404);
  assert.equal(state.sqlCalls, 0);
  state.env.KNOWLEDGE_ASSETS.get = async () => null;
  assert.equal((await getImage()).status, 404);
  state.env.KNOWLEDGE_ASSETS.get = async () => ({ body: image, size: 999 });
  assert.equal((await getImage()).status, 404);
});

test("text-only retrieval needs no asset query and repeated images are deduplicated", async () => {
  const state = globalThis[stateKey];
  assert.equal((await assets.getPublicKnowledgeAssetsForChunks(state.env.DB, [{ ...chunk(), content: "没有图片的正文" }])).size, 0);
  assert.equal(state.sqlCalls, 0);
  const resolved = await assets.getPublicKnowledgeAssetsForChunks(state.env.DB, [chunk(), chunk("public-chunk-2")]);
  assert.equal([...resolved.values()].flat().length, 1);
});

test("public retrieval bounds images to two per chunk and six per response", async () => {
  const state = globalThis[stateKey];
  for (let index = 0; index < 18; index += 1) state.sqlite.prepare(`INSERT INTO knowledge_revision_assets
    (id, item_id, revision_id, asset_path, storage_key, mime_type, byte_size, sha256, upload_state)
    VALUES (?, 'item-1', 'revision-1', ?, ?, 'image/png', 4, ?, 'ready')`)
    .run(`22222222-2222-4333-8444-${String(index).padStart(12, "0")}`, `assets/${index}.png`, `private-storage/${index}.png`, "b".repeat(64));
  const chunks = Array.from({ length: 6 }, (_, index) => ({ ...chunk(`public-chunk-${index}`), content: Array.from({ length: 3 }, (_, imageIndex) => `![图](assets/${index * 3 + imageIndex}.png)`).join("\n") }));
  const resolved = await assets.getPublicKnowledgeAssetsForChunks(state.env.DB, chunks);
  assert.equal([...resolved.values()].flat().length, 6);
  assert.ok([...resolved.values()].every((images) => images.length <= 2));
});
