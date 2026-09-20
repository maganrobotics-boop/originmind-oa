import { getDb } from "../../../../db";
import { readBoundedJsonObject } from "../../../../lib/bounded-json-request";
import { answerOaChatQuestion, questionRequestsKnowledgeImages, type OaChatHistory } from "../../../../lib/oa-chat-client";
import { isWellFormedUnicode, rankKnowledgeChunks } from "../../../../lib/knowledge-policy";
import { getActiveKnowledgeChunks, type KnowledgeActor } from "../../../../lib/knowledge-store";
import { consumeWriteRateLimit } from "../../../../lib/write-rate-limit";
import { getAuthorizedUser } from "../../_lib/auth";

const MAX_ASK_REQUEST_BYTES = 25_000;
const MAX_QUESTIONS_PER_MINUTE = 20;
const MAX_QUESTION_LENGTH = 2_000;
type TimingStage = "lookup" | "answer";
type RequestTimings = Partial<Record<TimingStage, number>>;

function privateJson(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(data, { ...init, headers });
}
function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
async function measureWaiting<T>(timings: RequestTimings, stage: TimingStage, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try { return await operation(); }
  finally { timings[stage] = elapsedMilliseconds(startedAt); }
}
function withServerTiming(response: Response, timings: RequestTimings, totalStartedAt: number): Response {
  const metrics: string[] = [];
  for (const stage of ["lookup", "answer"] as const) {
    const duration = timings[stage];
    if (duration !== undefined) metrics.push(`${stage};dur=${duration}`);
  }
  metrics.push(`total;dur=${elapsedMilliseconds(totalStartedAt)}`);
  const headers = new Headers(response.headers);
  headers.set("server-timing", metrics.join(", "));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function normalizedQuestion(value: unknown): string | null {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) return null;
  const question = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return question.length >= 2 && question.length <= MAX_QUESTION_LENGTH ? question : null;
}
function parseHistory(value: unknown): OaChatHistory | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2) return null;
  const history: OaChatHistory = [];
  for (const message of value) {
    if (!message || typeof message !== "object" || Array.isArray(message) || Object.keys(message).some(key => !["role", "content"].includes(key)) || message.role !== "user") return null;
    const content = normalizedQuestion(message.content);
    if (!content) return null;
    history.push({ role: "user", content });
  }
  return history;
}

export async function POST(request: Request) {
  const totalStartedAt = performance.now();
  const timings: RequestTimings = {};
  const finish = (response: Response) => withServerTiming(response, timings, totalStartedAt);
  const authorized = await getAuthorizedUser();
  if (!authorized) return finish(privateJson({ error: "请先完成成员注册。" }, { status: 401 }));
  if (!authorized.ndaCompleted) return finish(privateJson({ error: "请先完成保密协议签署与归档。" }, { status: 403 }));
  if (!authorized.memberId || !authorized.accountUserId || !authorized.memberMutationRevision) return finish(privateJson({ error: "知识问答仅向已激活、实名绑定的 OA 成员开放。" }, { status: 403 }));
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") return finish(privateJson({ error: "仅支持在 OA 内提问。" }, { status: 403 }));
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return finish(privateJson({ error: "知识问答必须使用 JSON 格式提交。" }, { status: 415 }));
  const parsed = await readBoundedJsonObject(request, MAX_ASK_REQUEST_BYTES);
  if (!parsed.ok) return finish(privateJson({ error: parsed.reason === "too_large" ? "问题数据过大。" : "问题格式不正确。" }, { status: parsed.reason === "too_large" ? 413 : 400 }));
  // The browser may provide previous user questions, never evidence or access scope.
  if (Object.keys(parsed.value).some(key => !["question", "history"].includes(key))) return finish(privateJson({ error: "问题包含不支持的字段。" }, { status: 400 }));
  const question = normalizedQuestion(parsed.value.question);
  const history = parseHistory(parsed.value.history);
  if (!question || !history) return finish(privateJson({ error: "问题需为 2–2000 个字符，历史仅接受最近两条用户问题。" }, { status: 400 }));
  try {
    const db = await getDb();
    if (!(await consumeWriteRateLimit(db, { actorSubject: authorized.accountUserId, scope: "lab_ai_ask", limit: MAX_QUESTIONS_PER_MINUTE }))) return finish(privateJson({ error: "提问过于频繁，请稍后再试。" }, { status: 429, headers: { "retry-after": "60" } }));
    const actor: KnowledgeActor = {
      memberId: authorized.memberId, accountUserId: authorized.accountUserId, memberMutationRevision: authorized.memberMutationRevision,
      name: authorized.user.displayName, email: authorized.user.email, isAdmin: authorized.isAdmin,
    };
    const retrievalQuery = history.length && question.length <= 80 ? `${history.at(-1)!.content} ${question}` : question;
    const ranked = await measureWaiting(timings, "lookup", async () => {
      const candidates = await getActiveKnowledgeChunks(actor, retrievalQuery);
      // Image questions must inspect more than the three strongest text hits:
      // an older text-only article can otherwise hide a newer approved package
      // whose revision owns the requested images.
      return rankKnowledgeChunks(retrievalQuery, candidates, questionRequestsKnowledgeImages(question) ? 12 : 6);
    });
    const answer = await measureWaiting(timings, "answer", () => answerOaChatQuestion(question, ranked, history));
    return finish(privateJson(answer));
  } catch {
    return finish(privateJson({ error: "实验室知识问答暂不可用，请稍后重试。" }, { status: 500 }));
  }
}
