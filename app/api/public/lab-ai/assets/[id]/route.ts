import { findPublicKnowledgeAsset, PUBLIC_KNOWLEDGE_ASSET_ID_PATTERN } from "../../../../../../lib/public-knowledge-assets";

const HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "cross-origin",
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const missing = () => new Response(null, { status: 404, headers: HEADERS });
  if (!PUBLIC_KNOWLEDGE_ASSET_ID_PATTERN.test(id) || new URL(request.url).search) return missing();
  try {
    const { env } = await import("cloudflare:workers");
    const asset = await findPublicKnowledgeAsset(env.DB, id);
    if (!asset || !env.KNOWLEDGE_ASSETS) return missing();
    const object = await env.KNOWLEDGE_ASSETS.get(asset.storage_key);
    if (!object || object.size !== Number(asset.byte_size)) return missing();
    return new Response(object.body, {
      headers: {
        ...HEADERS,
        "content-type": asset.mime_type,
        "content-length": String(asset.byte_size),
      },
    });
  } catch {
    return new Response(null, { status: 503, headers: HEADERS });
  }
}
