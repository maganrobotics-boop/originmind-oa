import { getDb } from "../../../../db";
import { readBoundedJsonObject } from "../../../../lib/bounded-json-request";
import { answerLabQuestion } from "../../../../lib/lab-ai-client";
import { isWellFormedUnicode, MAX_KNOWLEDGE_QUESTION_LENGTH, rankKnowledgeChunks } from "../../../../lib/knowledge-policy";
import { getActiveKnowledgeChunks, type KnowledgeActor } from "../../../../lib/knowledge-store";
import { consumeWriteRateLimit } from "../../../../lib/write-rate-limit";
import { getAuthorizedUser } from "../../_lib/auth";

const MAX_ASK_REQUEST_BYTES = 4_096;
const MAX_QUESTIONS_PER_MINUTE = 20;

function privateJson(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store, max-age=0");
  return Response.json(data, { ...init, headers });
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

export async function POST(request: Request) {
  const authorized = await getAuthorizedUser();
  if (!authorized) return privateJson({ error: "请先完成成员注册。" }, { status: 401 });
  if (!authorized.ndaCompleted) return privateJson({ error: "请先完成保密协议签署与归档。" }, { status: 403 });
  if (!authorized.memberId || !authorized.accountUserId || !authorized.memberMutationRevision) {
    return privateJson({ error: "知识问答仅向已激活、实名绑定的 OA 成员开放。" }, { status: 403 });
  }
  if (!isJsonRequest(request)) return privateJson({ error: "知识问答必须使用 JSON 格式提交。" }, { status: 415 });
  const parsedBody = await readBoundedJsonObject(request, MAX_ASK_REQUEST_BYTES);
  if (!parsedBody.ok) return privateJson(
    { error: parsedBody.reason === "too_large" ? "问题数据过大。" : "问题格式不正确。" },
    { status: parsedBody.reason === "too_large" ? 413 : 400 },
  );
  if (Object.keys(parsedBody.value).some((key) => key !== "question") || typeof parsedBody.value.question !== "string") {
    return privateJson({ error: "问题格式不正确。" }, { status: 400 });
  }
  if (!isWellFormedUnicode(parsedBody.value.question)) return privateJson({ error: "问题包含无效的 Unicode 字符。" }, { status: 400 });
  const question = parsedBody.value.question.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (question.length < 2 || question.length > MAX_KNOWLEDGE_QUESTION_LENGTH) {
    return privateJson({ error: `问题需为 2–${MAX_KNOWLEDGE_QUESTION_LENGTH} 个字符。` }, { status: 400 });
  }

  try {
    const db = await getDb();
    if (!(await consumeWriteRateLimit(db, { actorSubject: authorized.accountUserId, scope: "lab_ai_ask", limit: MAX_QUESTIONS_PER_MINUTE }))) {
      return privateJson({ error: "提问过于频繁，请稍后再试。" }, { status: 429, headers: { "retry-after": "60" } });
    }
    const actor: KnowledgeActor = {
      memberId: authorized.memberId,
      accountUserId: authorized.accountUserId,
      memberMutationRevision: authorized.memberMutationRevision,
      name: authorized.user.displayName,
      email: authorized.user.email,
      isAdmin: authorized.isAdmin,
    };
    const candidates = await getActiveKnowledgeChunks(actor, question);
    const ranked = rankKnowledgeChunks(question, candidates, 6);
    return privateJson(await answerLabQuestion(question, ranked));
  } catch {
    return privateJson({ error: "实验室知识问答暂不可用，请稍后重试。" }, { status: 500 });
  }
}
