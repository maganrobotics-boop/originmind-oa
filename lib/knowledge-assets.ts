const SAFE_ASSET_PATH = /^assets\/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:webp|png|jpe?g)$/i;
const ALLOWED_MIME = new Set(["image/webp", "image/png", "image/jpeg"]);
export const MAX_KNOWLEDGE_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_KNOWLEDGE_ASSETS = 128;

export type KnowledgeAssetInput = {
  path: string;
  mimeType: string;
  bytes: ArrayBuffer;
};

export type StoredKnowledgeAsset = {
  id: string;
  itemId: string;
  revisionId: string;
  assetPath: string;
  mimeType: string;
  byteSize: number;
  storageKey: string;
};

export function normalizeKnowledgeAssetPath(path: string): string {
  const value = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!SAFE_ASSET_PATH.test(value) || value.includes("../") || value.includes("//")) {
    throw new Error("知识图片路径不合法。图片必须位于 assets/ 下。 ");
  }
  return value;
}

export function validateKnowledgeAsset(asset: KnowledgeAssetInput): KnowledgeAssetInput & { path: string } {
  const path = normalizeKnowledgeAssetPath(asset.path);
  const mimeType = asset.mimeType.trim().toLowerCase();
  if (!ALLOWED_MIME.has(mimeType)) throw new Error("仅支持 WebP、PNG、JPG 图片。 ");
  if (!asset.bytes.byteLength || asset.bytes.byteLength > MAX_KNOWLEDGE_ASSET_BYTES) throw new Error("单张知识图片大小不符合要求。 ");
  return { ...asset, path, mimeType };
}

export function knowledgeAssetStorageKey(itemId: string, revisionId: string, assetPath: string): string {
  const path = normalizeKnowledgeAssetPath(assetPath);
  return `knowledge/${itemId}/${revisionId}/${path.slice("assets/".length)}`;
}

export async function persistKnowledgeAssets(
  database: D1Database,
  bucket: R2Bucket,
  itemId: string,
  revisionId: string,
  assets: readonly KnowledgeAssetInput[],
): Promise<StoredKnowledgeAsset[]> {
  if (assets.length > MAX_KNOWLEDGE_ASSETS) throw new Error("单份知识资料图片数量过多。 ");
  const normalized = assets.map(validateKnowledgeAsset);
  if (new Set(normalized.map((asset) => asset.path.toLowerCase())).size !== normalized.length) throw new Error("ZIP 中存在重复图片路径。 ");
  const stored: StoredKnowledgeAsset[] = [];
  try {
    for (const asset of normalized) {
      const id = crypto.randomUUID();
      const storageKey = knowledgeAssetStorageKey(itemId, revisionId, asset.path);
      await bucket.put(storageKey, asset.bytes, { httpMetadata: { contentType: asset.mimeType } });
      await database.prepare(`
        INSERT INTO knowledge_revision_assets
          (id, item_id, revision_id, asset_path, mime_type, byte_size, storage_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, itemId, revisionId, asset.path, asset.mimeType, asset.bytes.byteLength, storageKey, new Date().toISOString()).run();
      stored.push({ id, itemId, revisionId, assetPath: asset.path, mimeType: asset.mimeType, byteSize: asset.bytes.byteLength, storageKey });
    }
    return stored;
  } catch (error) {
    await Promise.allSettled(stored.map((asset) => bucket.delete(asset.storageKey)));
    if (stored.length) {
      await database.prepare(`DELETE FROM knowledge_revision_assets WHERE revision_id = ?`).bind(revisionId).run().catch(() => undefined);
    }
    throw error;
  }
}

export async function listKnowledgeRevisionAssets(database: D1Database, revisionId: string): Promise<StoredKnowledgeAsset[]> {
  const result = await database.prepare(`
    SELECT id, item_id, revision_id, asset_path, mime_type, byte_size, storage_key
    FROM knowledge_revision_assets WHERE revision_id = ? ORDER BY asset_path
  `).bind(revisionId).all<{
    id: string; item_id: string; revision_id: string; asset_path: string; mime_type: string; byte_size: number; storage_key: string;
  }>();
  return (result.results || []).map((row) => ({
    id: row.id, itemId: row.item_id, revisionId: row.revision_id, assetPath: row.asset_path,
    mimeType: row.mime_type, byteSize: Number(row.byte_size), storageKey: row.storage_key,
  }));
}
