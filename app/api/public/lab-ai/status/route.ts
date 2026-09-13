import { hasPublicActiveKnowledge } from "../../../../../lib/knowledge-store";
import { isMigrationWriteFrozen } from "../../../../../lib/migration-freeze";
import { isPublicLabAiRetrieveAvailable } from "../_lib/rate-limit";
import { publicLabAiJson } from "../_lib/response-contract";
import { authorizePublicLabAiRequest } from "../_lib/service-auth";

function errorResponse(error: string, status: number, headers?: HeadersInit): Response {
  return publicLabAiJson({ error }, { status, headers });
}

export async function GET(request: Request): Promise<Response> {
  const { env } = await import("cloudflare:workers");
  const publicEnv = env as typeof env & { PUBLIC_LAB_AI_SERVICE_TOKEN?: string };
  const authorization = authorizePublicLabAiRequest(request, publicEnv.PUBLIC_LAB_AI_SERVICE_TOKEN);
  if (authorization === "unauthorized") return errorResponse("服务凭证无效。", 401);
  if (authorization === "not_configured") return errorResponse("公共知识状态暂不可用。", 503);
  if (isMigrationWriteFrozen(publicEnv as unknown as Record<string, unknown>)) {
    return errorResponse("OA 正在生成迁移快照，公共知识状态暂不可用。", 503, { "retry-after": "300" });
  }
  if (new URL(request.url).search) return errorResponse("请求格式不正确。", 400);

  try {
    const [publicKnowledgeReady, retrievalReady] = await Promise.all([
      hasPublicActiveKnowledge(),
      isPublicLabAiRetrieveAvailable(publicEnv.DB),
    ]);
    return publicLabAiJson({
      oaReady: true,
      publicKnowledgeReady,
      retrievalReady,
    });
  } catch {
    return errorResponse("公共知识状态暂不可用。", 503);
  }
}
