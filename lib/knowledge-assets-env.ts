export async function getKnowledgeAssetsBucket(): Promise<R2Bucket> {
  const { env } = await import("cloudflare:workers");
  if (!env.KNOWLEDGE_ASSETS) {
    throw new Error("Cloudflare R2 binding `KNOWLEDGE_ASSETS` is unavailable.");
  }
  return env.KNOWLEDGE_ASSETS;
}
