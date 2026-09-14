import { getLatestPublicKnowledgeSuggestionCandidates } from "../../../../../lib/knowledge-store";
import { isMigrationWriteFrozen } from "../../../../../lib/migration-freeze";
import { consumePublicLabAiSuggestionsRateLimit } from "../_lib/rate-limit";
import { buildPublicLabAiSuggestionsResponse, publicLabAiJson } from "../_lib/response-contract";
import { authorizePublicLabAiRequest } from "../_lib/service-auth";

const SUGGESTION_CANDIDATE_LIMIT = 12;

function errorResponse(error: string, status: number, headers?: HeadersInit): Response {
  return publicLabAiJson({ error }, { status, headers });
}

export async function GET(request: Request): Promise<Response> {
  const { env } = await import("cloudflare:workers");
  const publicEnv = env as typeof env & { PUBLIC_LAB_AI_SERVICE_TOKEN?: string };
  const authorization = authorizePublicLabAiRequest(request, publicEnv.PUBLIC_LAB_AI_SERVICE_TOKEN);
  if (authorization === "unauthorized") return errorResponse("服务凭证无效。", 401);
  if (authorization === "not_configured") return errorResponse("知识推荐话题暂不可用。", 503);
  if (isMigrationWriteFrozen(publicEnv as unknown as Record<string, unknown>)) {
    return errorResponse("OA 正在生成迁移快照，知识推荐话题暂时停止。", 503, { "retry-after": "300" });
  }
  if (new URL(request.url).search) return errorResponse("请求格式不正确。", 400);

  try {
    if (!(await consumePublicLabAiSuggestionsRateLimit(publicEnv.DB))) {
      return errorResponse("知识推荐请求过于频繁，请稍后再试。", 429, { "retry-after": "60" });
    }
    const candidates = await getLatestPublicKnowledgeSuggestionCandidates(SUGGESTION_CANDIDATE_LIMIT);
    return publicLabAiJson(buildPublicLabAiSuggestionsResponse(candidates));
  } catch {
    return errorResponse("知识推荐话题暂不可用。", 503);
  }
}
