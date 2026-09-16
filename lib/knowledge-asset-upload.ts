import { normalizeKnowledgeAssetPath, knowledgeAssetStorageKey, MAX_KNOWLEDGE_ASSET_BYTES } from "./knowledge-assets";

const ALLOWED_MIME = new Set(["image/webp", "image/png", "image/jpeg"]);

export function knowledgeAssetUploadToken(): string {
  return crypto.randomUUID();
}

export async function stageKnowledgeAsset(
  database: D1Database,
  bucket: R2Bucket,
  input: { itemId: string; revisionId: string; uploadToken: string; path: string; mimeType: string; body: ArrayBuffer },
) {
  const path = normalizeKnowledgeAssetPath(input.path);
  const mimeType = input.mimeType.trim().toLowerCase();
  if (!ALLOWED_MIME.has(mimeType)) throw new Error("unsupported knowledge asset type");
  if (!input.body.byteLength || input.body.byteLength > MAX_KNOWLEDGE_ASSET_BYTES) throw new Error("knowledge asset too large");
  const revision = await database.prepare(`
    SELECT i.id AS item_id, i.current_revision_id AS revision_id
    FROM knowledge_items i
    JOIN knowledge_revisions r ON r.id = i.current_revision_id
    WHERE i.id = ? AND i.current_revision_id = ? AND i.status = 'pending' AND r.status = 'pending'
  `).bind(input.itemId, input.revisionId).first<{ item_id: string; revision_id: string }>();
  if (!revision) throw new Error("knowledge revision is not pending");
  const storageKey = knowledgeAssetStorageKey(input.itemId, input.revisionId, path);
  await bucket.put(storageKey, input.body, { httpMetadata: { contentType: mimeType } });
  const id = crypto.randomUUID();
  await database.prepare(`
    INSERT INTO knowledge_revision_assets
      (id, item_id, revision_id, asset_path, mime_type, byte_size, storage_key, upload_token, upload_state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?)
    ON CONFLICT(revision_id, asset_path) DO UPDATE SET
      mime_type = excluded.mime_type, byte_size = excluded.byte_size, storage_key = excluded.storage_key,
      upload_token = excluded.upload_token, upload_state = 'staged'
  `).bind(id, input.itemId, input.revisionId, path, mimeType, input.body.byteLength, storageKey, input.uploadToken, new Date().toISOString()).run();
  return { path, mimeType, byteSize: input.body.byteLength };
}

export async function finalizeKnowledgeAssets(
  database: D1Database,
  input: { itemId: string; revisionId: string; uploadToken: string; expectedPaths: readonly string[] },
) {
  const expected = [...new Set(input.expectedPaths.map(normalizeKnowledgeAssetPath))].sort();
  const result = await database.prepare(`
    SELECT asset_path FROM knowledge_revision_assets
    WHERE item_id = ? AND revision_id = ? AND upload_token = ? AND upload_state = 'staged'
    ORDER BY asset_path
  `).bind(input.itemId, input.revisionId, input.uploadToken).all<{ asset_path: string }>();
  const actual = (result.results || []).map((row) => row.asset_path).sort();
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new Error("knowledge assets are incomplete");
  }
  await database.prepare(`
    UPDATE knowledge_revision_assets SET upload_state = 'ready'
    WHERE item_id = ? AND revision_id = ? AND upload_token = ? AND upload_state = 'staged'
  `).bind(input.itemId, input.revisionId, input.uploadToken).run();
  return { assetCount: actual.length };
}
