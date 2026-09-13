import { readBoundedJsonObject } from "../../../../../lib/bounded-json-request";
import {
  isWellFormedUnicode,
  MAX_KNOWLEDGE_QUESTION_LENGTH,
  rankKnowledgeChunks,
} from "../../../../../lib/knowledge-policy";
import { getPublicActiveKnowledgeChunks } from "../../../../../lib/knowledge-store";
import { isMigrationWriteFrozen } from "../../../../../lib/migration-freeze";
import { consumePublicLabAiRetrieveRateLimit } from "../_lib/rate-limit";
import { buildPublicLabAiRetrieveResponse, publicLabAiJson } from "../_lib/response-contract";
import { authorizePublicLabAiRequest } from "../_lib/service-auth";

const MAX_RETRIEVE_REQUEST_BYTES = 4_096;

function errorResponse(error: string, status: number, headers?: HeadersInit): Response {
  return publicLabAiJson({ error }, { status, headers });
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

export async function POST(request: Request): Promise<Response> {
  const { env } = await import("cloudflare:workers");
  const publicEnv = env as typeof env & { PUBLIC_LAB_AI_SERVICE_TOKEN?: string };
  const authorization = authorizePublicLabAiRequest(request, publicEnv.PUBLIC_LAB_AI_SERVICE_TOKEN);
  if (authorization === "unauthorized") return errorResponse("服务凭证无效。", 401);
  if (authorization === "not_configured") return errorResponse("公共知识检索暂不可用。", 503);
  if (isMigrationWriteFrozen(publicEnv as unknown as Record<string, unknown>)) {
    return errorResponse("OA 正在生成迁移快照，公共知识检索暂时停止。", 503, { "retry-after": "300" });
  }
  if (new URL(request.url).search) return errorResponse("请求格式不正确。", 400);
  if (!isJsonRequest(request)) return errorResponse("公共知识检索必须使用 JSON 格式提交。", 415);
  const parsedBody = await readBoundedJsonObject(request, MAX_RETRIEVE_REQUEST_BYTES);
  if (!parsedBody.ok) return errorResponse(
    parsedBody.reason === "too_large" ? "问题数据过大。" : "问题格式不正确。",
    parsedBody.reason === "too_large" ? 413 : 400,
  );
  if (Object.keys(parsedBody.value).some((key) => key !== "question") || typeof parsedBody.value.question !== "string") {
    return errorResponse("问题格式不正确。", 400);
  }
  if (!isWellFormedUnicode(parsedBody.value.question)) return errorResponse("问题包含无效的 Unicode 字符。", 400);
  const question = parsedBody.value.question.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (question.length < 2 || question.length > MAX_KNOWLEDGE_QUESTION_LENGTH) {
    return errorResponse(`问题需为 2–${MAX_KNOWLEDGE_QUESTION_LENGTH} 个字符。`, 400);
  }

  try {
    if (!(await consumePublicLabAiRetrieveRateLimit(publicEnv.DB))) {
      return errorResponse("检索过于频繁，请稍后再试。", 429, { "retry-after": "60" });
    }
    const candidates = await getPublicActiveKnowledgeChunks(question);
    const ranked = rankKnowledgeChunks(question, candidates, 6);
    return publicLabAiJson(buildPublicLabAiRetrieveResponse(ranked));
  } catch {
    return errorResponse("公共知识检索暂不可用。", 503);
  }
}
