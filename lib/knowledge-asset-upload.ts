import { normalizeKnowledgeAssetPath, persistKnowledgeAsset, requirePendingKnowledgeAssetRevision, MAX_KNOWLEDGE_ASSETS } from "./knowledge-assets";

export function knowledgeAssetUploadToken(): string {
  return crypto.randomUUID();
}

export async function stageKnowledgeAsset(
  database: D1Database,
  bucket: R2Bucket,
  input: { itemId: string; revisionId: string; uploadToken: string; path: string; mimeType: string; body: ArrayBuffer },
) {
  if (!input.uploadToken.trim()) throw new Error("knowledge upload token is required");
  const stored = await persistKnowledgeAsset(database, bucket, input.itemId, input.revisionId,
    { path: input.path, mimeType: input.mimeType, bytes: input.body }, input.uploadToken, "staged");
  return { path: stored.assetPath, mimeType: stored.mimeType, byteSize: stored.byteSize };
}

export async function finalizeKnowledgeAssets(
  database: D1Database,
  input: { itemId: string; revisionId: string; uploadToken: string; expectedPaths: readonly string[] },
) {
  if (!input.uploadToken.trim()) throw new Error("knowledge upload token is required");
  const expected = input.expectedPaths.map(normalizeKnowledgeAssetPath).sort();
  if (!expected.length || expected.length > MAX_KNOWLEDGE_ASSETS
    || new Set(expected.map((path) => path.toLowerCase())).size !== expected.length) {
    throw new Error("knowledge asset manifest is invalid");
  }
  await requirePendingKnowledgeAssetRevision(database, input.itemId, input.revisionId);
  const readAssets = async () => {
    const result = await database.prepare(`
      SELECT asset_path, upload_token, upload_state FROM knowledge_revision_assets
      WHERE item_id = ? AND revision_id = ? ORDER BY asset_path
    `).bind(input.itemId, input.revisionId).all<{ asset_path: string; upload_token: string; upload_state: string }>();
    const rows = result.results || [];
    const actual = rows.map((row) => row.asset_path).sort();
    if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])
      || rows.some((row) => row.upload_token !== input.uploadToken || !["staged", "ready"].includes(row.upload_state))) {
      throw new Error("knowledge assets are incomplete or belong to another upload");
    }
    return rows;
  };
  await readAssets();
  await database.prepare(`
    UPDATE knowledge_revision_assets SET upload_state = 'ready'
    WHERE item_id = ? AND revision_id = ? AND upload_token = ? AND upload_state = 'staged'
      AND (SELECT count(*) FROM knowledge_revision_assets WHERE revision_id = ?) = ?
  `).bind(input.itemId, input.revisionId, input.uploadToken, input.revisionId, expected.length).run();
  const finalized = await readAssets();
  if (finalized.some((row) => row.upload_state !== "ready")) throw new Error("knowledge assets were not finalized");
  return { assetCount: finalized.length };
}
