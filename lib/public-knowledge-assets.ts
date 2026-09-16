import { MAX_KNOWLEDGE_ASSET_BYTES, normalizeKnowledgeAssetPath } from "./knowledge-assets";
import type { RankedKnowledgeChunk } from "./knowledge-policy";

export const PUBLIC_KNOWLEDGE_ASSET_ORIGIN = "https://oa.omindos.ai";
export const PUBLIC_KNOWLEDGE_ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ALLOWED_MIME = new Set(["image/webp", "image/png", "image/jpeg"]);
const MAX_ASSETS_PER_CHUNK = 2;
const MAX_ASSETS_PER_RESPONSE = 6;

export type PublicKnowledgeAsset = { url: string; alt: string; mimeType: string };
type RequestedAsset = { chunkId: string; itemId: string; revisionId: string; path: string; alt: string };

export function referencedKnowledgeImages(markdown: string): Array<{ path: string; alt: string }> {
  const body = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/gu, "");
  const references: Array<{ path: string; alt: string }> = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/gu)) {
    try {
      const path = normalizeKnowledgeAssetPath(match[2] || match[3]);
      if (seen.has(path)) continue;
      seen.add(path);
      const alt = match[1].replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 200).replace(/[\uD800-\uDBFF]$/u, "");
      references.push({ path, alt: alt || "资料配图" });
      if (references.length === MAX_ASSETS_PER_CHUNK) break;
    } catch {
      // Only immutable local assets are eligible; remote/data/traversal links
      // never become public image URLs.
    }
  }
  return references;
}

export async function getPublicKnowledgeAssetsForChunks(
  database: D1Database,
  chunks: readonly RankedKnowledgeChunk[],
): Promise<Map<string, PublicKnowledgeAsset[]>> {
  const requested: RequestedAsset[] = chunks.slice(0, 6).flatMap((chunk) => chunk.assetScope
    ? referencedKnowledgeImages(chunk.content).map((image) => ({ chunkId: chunk.id, ...chunk.assetScope!, ...image }))
    : []);
  const assets = new Map<string, PublicKnowledgeAsset[]>();
  if (!requested.length) return assets;
  const result = await database.prepare(`
    SELECT q.key AS request_no, a.id, a.mime_type
    FROM json_each(?) AS q
    INNER JOIN knowledge_revision_assets AS a
      ON a.item_id = json_extract(q.value, '$.itemId')
      AND a.revision_id = json_extract(q.value, '$.revisionId')
      AND a.asset_path = json_extract(q.value, '$.path')
    INNER JOIN knowledge_items AS i ON i.id = a.item_id
    INNER JOIN knowledge_revisions AS r ON r.id = a.revision_id AND r.item_id = i.id
    WHERE i.status = 'active' AND i.visibility = 'public'
      AND r.status = 'active' AND i.active_revision_id = a.revision_id
      AND a.upload_state = 'ready'
      AND a.mime_type IN ('image/jpeg', 'image/png', 'image/webp')
      AND a.byte_size > 0 AND a.byte_size <= ?
    ORDER BY q.key
  `).bind(JSON.stringify(requested), MAX_KNOWLEDGE_ASSET_BYTES).all<{ request_no: number; id: string; mime_type: string }>();
  const seen = new Set<string>();
  for (const row of result.results || []) {
    const reference = requested[Number(row.request_no)];
    if (!reference || !PUBLIC_KNOWLEDGE_ASSET_ID_PATTERN.test(row.id) || !ALLOWED_MIME.has(row.mime_type) || seen.has(row.id)) continue;
    seen.add(row.id);
    const chunkAssets = assets.get(reference.chunkId) || [];
    chunkAssets.push({
      url: `${PUBLIC_KNOWLEDGE_ASSET_ORIGIN}/api/public/lab-ai/assets/${row.id}`,
      alt: reference.alt,
      mimeType: row.mime_type,
    });
    assets.set(reference.chunkId, chunkAssets);
    if (seen.size === MAX_ASSETS_PER_RESPONSE) break;
  }
  return assets;
}

export async function findPublicKnowledgeAsset(database: D1Database, assetId: string) {
  if (!PUBLIC_KNOWLEDGE_ASSET_ID_PATTERN.test(assetId)) return null;
  return database.prepare(`
    SELECT a.storage_key, a.mime_type, a.byte_size
    FROM knowledge_revision_assets AS a
    INNER JOIN knowledge_items AS i ON i.id = a.item_id
    INNER JOIN knowledge_revisions AS r ON r.id = a.revision_id AND r.item_id = i.id
    WHERE a.id = ? AND i.status = 'active' AND i.visibility = 'public'
      AND r.status = 'active' AND i.active_revision_id = a.revision_id
      AND a.upload_state = 'ready'
      AND a.mime_type IN ('image/jpeg', 'image/png', 'image/webp')
      AND a.byte_size > 0 AND a.byte_size <= ?
    LIMIT 1
  `).bind(assetId, MAX_KNOWLEDGE_ASSET_BYTES).first<{ storage_key: string; mime_type: string; byte_size: number }>();
}
