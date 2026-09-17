import { knowledgeImageReferences } from "./knowledge-image-references.mjs";

const SAFE_ASSET_PATH = /^assets\/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:webp|png|jpe?g)$/i;
const ALLOWED_MIME = new Set(["image/webp", "image/png", "image/jpeg"]);
export const MAX_KNOWLEDGE_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_KNOWLEDGE_ASSETS = 128;

const MARKDOWN_IMAGE_REFERENCE = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/gu;

export function referencedKnowledgeAssetPaths(markdown: string): string[] {
  const references = new Set<string>();
  // Preserve the existing Markdown path validation, including invalid-path errors.
  for (const match of String(markdown || "").matchAll(MARKDOWN_IMAGE_REFERENCE)) {
    const raw = String(match[1] || match[2] || "").split(/[?#]/u, 1)[0];
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* keep raw path */ }
    if (/^assets\//iu.test(decoded)) references.add(normalizeKnowledgeAssetPath(decoded));
  }
  // Word/Pandoc exports keep <img> tags inside Markdown; these also require uploaded bytes.
  for (const path of knowledgeImageReferences(markdown).keys()) references.add(path);
  return [...references].sort((left, right) => left.localeCompare(right));
}

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

export async function knowledgeAssetSha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function requirePendingKnowledgeAssetRevision(database: D1Database, itemId: string, revisionId: string) {
  const revision = await database.prepare(`
    SELECT 1 AS allowed FROM knowledge_items i
    JOIN knowledge_revisions r ON r.id = i.current_revision_id AND r.item_id = i.id
    WHERE i.id = ? AND r.id = ? AND i.status = 'pending' AND r.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM migration_control WHERE deactivated_at IS NULL)
  `).bind(itemId, revisionId).first();
  if (!revision) throw new Error("knowledge revision is not pending or migration is frozen");
}

type AssetRow = {
  id: string; item_id: string; revision_id: string; asset_path: string; mime_type: string;
  byte_size: number; storage_key: string; sha256: string; upload_token: string; upload_state: string;
};

// R2 and D1 cannot commit together. Retain a successfully written object on a D1
// failure so the same upload can retry; never overwrite or delete another upload.
export async function persistKnowledgeAsset(
  database: D1Database,
  bucket: R2Bucket,
  itemId: string,
  revisionId: string,
  input: KnowledgeAssetInput,
  uploadToken = "",
  uploadState: "staged" | "ready" = "ready",
): Promise<StoredKnowledgeAsset> {
  const asset = validateKnowledgeAsset(input);
  await requirePendingKnowledgeAssetRevision(database, itemId, revisionId);
  const sha256 = await knowledgeAssetSha256(asset.bytes);
  const storageKey = knowledgeAssetStorageKey(itemId, revisionId, asset.path);
  const readRow = () => database.prepare(`
    SELECT * FROM knowledge_revision_assets WHERE revision_id = ? AND asset_path = ?
  `).bind(revisionId, asset.path).first<AssetRow>();
  const assertMatches = (row: AssetRow) => {
    if (row.item_id !== itemId || row.revision_id !== revisionId || row.storage_key !== storageKey
      || row.mime_type !== asset.mimeType || Number(row.byte_size) !== asset.bytes.byteLength
      || row.sha256 !== sha256 || row.upload_token !== uploadToken
      || !["staged", "ready"].includes(row.upload_state)
      || (uploadState === "ready" && row.upload_state !== "ready")) {
      throw new Error("knowledge asset conflicts with immutable upload");
    }
  };
  const existing = await readRow();
  if (existing) assertMatches(existing);
  const created = existing ? null : await bucket.put(storageKey, asset.bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: asset.mimeType },
    customMetadata: { sha256, uploadToken },
    sha256,
  });
  if (!created) {
    const object = await bucket.get(storageKey);
    if (!object || object.size !== asset.bytes.byteLength || object.httpMetadata?.contentType !== asset.mimeType
      || object.customMetadata?.uploadToken !== uploadToken
      || await knowledgeAssetSha256(await object.arrayBuffer()) !== sha256) {
      throw new Error("knowledge asset storage is missing or conflicts with upload");
    }
  }
  if (!existing) {
    await database.prepare(`
      INSERT INTO knowledge_revision_assets
        (id, item_id, revision_id, asset_path, mime_type, byte_size, storage_key, sha256, upload_token, upload_state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(revision_id, asset_path) DO NOTHING
    `).bind(crypto.randomUUID(), itemId, revisionId, asset.path, asset.mimeType, asset.bytes.byteLength,
      storageKey, sha256, uploadToken, uploadState, new Date().toISOString()).run();
  }
  const row = await readRow();
  if (!row) throw new Error("knowledge asset metadata was not saved");
  assertMatches(row);
  return { id: row.id, itemId, revisionId, assetPath: row.asset_path, mimeType: row.mime_type, byteSize: asset.bytes.byteLength, storageKey };
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
  for (const asset of normalized) {
    stored.push(await persistKnowledgeAsset(database, bucket, itemId, revisionId, asset));
  }
  return stored;
}

export async function listKnowledgeRevisionAssets(database: D1Database, revisionId: string): Promise<StoredKnowledgeAsset[]> {
  const result = await database.prepare(`
    SELECT id, item_id, revision_id, asset_path, mime_type, byte_size, storage_key
    FROM knowledge_revision_assets WHERE revision_id = ? AND upload_state = 'ready' ORDER BY asset_path
  `).bind(revisionId).all<{
    id: string; item_id: string; revision_id: string; asset_path: string; mime_type: string; byte_size: number; storage_key: string;
  }>();
  return (result.results || []).map((row) => ({
    id: row.id, itemId: row.item_id, revisionId: row.revision_id, assetPath: row.asset_path,
    mimeType: row.mime_type, byteSize: Number(row.byte_size), storageKey: row.storage_key,
  }));
}

export async function assertKnowledgeRevisionAssetsReady(database: D1Database, itemId: string, revisionId: string): Promise<void> {
  const contentResult = await database.prepare(`
    SELECT content FROM knowledge_revisions WHERE item_id = ? AND id = ?
  `).bind(itemId, revisionId).first<{ content: string | null }>();
  const partResult = await database.prepare(`
    SELECT content FROM knowledge_revision_parts WHERE item_id = ? AND revision_id = ? ORDER BY part_no
  `).bind(itemId, revisionId).all<{ content: string }>();
  const markdown = [contentResult?.content || "", ...(partResult.results || []).map((row) => row.content || "")].join("\n");
  const expected = referencedKnowledgeAssetPaths(markdown);
  if (!expected.length) return;
  const rows = await database.prepare(`
    SELECT asset_path FROM knowledge_revision_assets
    WHERE item_id = ? AND revision_id = ? AND upload_state = 'ready'
    ORDER BY asset_path
  `).bind(itemId, revisionId).all<{ asset_path: string }>();
  const actual = new Set((rows.results || []).map((row) => normalizeKnowledgeAssetPath(row.asset_path)));
  const missing = expected.filter((path) => !actual.has(path));
  if (missing.length) throw new Error(`知识图片尚未完整上传：${missing.join(", ")}`);
}
