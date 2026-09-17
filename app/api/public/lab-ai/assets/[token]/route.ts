import { readPublicKnowledgeAsset } from "../../../../../../lib/public-knowledge-assets.mjs";
import { isMigrationWriteFrozen } from "../../../../../../lib/migration-freeze";
import { publicLabAiJson } from "../../_lib/response-contract";
import { authorizePublicLabAiRequest } from "../../_lib/service-auth";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { env } = await import("cloudflare:workers");
  const publicEnv = env as typeof env & { PUBLIC_LAB_AI_SERVICE_TOKEN?: string; KNOWLEDGE_ASSETS?: R2Bucket };
  const authorization = authorizePublicLabAiRequest(request, publicEnv.PUBLIC_LAB_AI_SERVICE_TOKEN);
  if (authorization !== "authorized") return publicLabAiJson({ error: "知识图片暂不可用。" }, { status: authorization === "unauthorized" ? 401 : 503 });
  if (new URL(request.url).search) return publicLabAiJson({ error: "请求格式不正确。" }, { status: 400 });
  if (!publicEnv.KNOWLEDGE_ASSETS || isMigrationWriteFrozen(publicEnv as unknown as Record<string, unknown>)) {
    return publicLabAiJson({ error: "知识图片暂不可用。" }, { status: 503 });
  }
  try {
    const { token } = await params;
    return await readPublicKnowledgeAsset(token, publicEnv.PUBLIC_LAB_AI_SERVICE_TOKEN, publicEnv.DB, publicEnv.KNOWLEDGE_ASSETS)
      ?? publicLabAiJson({ error: "知识图片不存在或已撤回。" }, { status: 404 });
  } catch {
    return publicLabAiJson({ error: "知识图片暂不可用。" }, { status: 503 });
  }
}
