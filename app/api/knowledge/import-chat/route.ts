import { getDb } from "../../../../db";
import { readBoundedJsonObject } from "../../../../lib/bounded-json-request";
import { chatImportIdentity, parseChatKnowledgeImport } from "../../../../lib/chat-knowledge-import";
import { createChatImportedKnowledgeItem, type KnowledgeActor } from "../../../../lib/knowledge-store";
import { consumeWriteRateLimit } from "../../../../lib/write-rate-limit";
import { getAuthorizedUser } from "../../_lib/auth";

const CHAT_ORIGIN = "https://chat.omindos.ai";

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": CHAT_ORIGIN,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "private, no-store, max-age=0",
    vary: "Origin, Cookie",
  };
}

function reply(data: unknown, status = 200) {
  return Response.json(data, { status, headers: corsHeaders() });
}

function allowedOrigin(request: Request) {
  return request.headers.get("origin") === CHAT_ORIGIN;
}

export async function OPTIONS(request: Request) {
  const requestedHeaders = (request.headers.get("access-control-request-headers") || "").toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
  if (!allowedOrigin(request) || request.headers.get("access-control-request-method") !== "POST" || requestedHeaders.some((value) => value !== "content-type")) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function POST(request: Request) {
  // Only the intended Chat UI may make a credentialed cross-origin submission.
  // A public retrieval service token never authorizes this write route.
  if (!allowedOrigin(request)) return Response.json({ error: "请从 Chat 管理页面提交。" }, { status: 403 });
  const authorized = await getAuthorizedUser();
  if (!authorized) return reply({ error: "请先在同一浏览器登录 OA，然后返回此页点击“提交 OA 待审”。Chat 草稿已保留。" }, 401);
  if (!authorized.ndaCompleted || !authorized.memberId || !authorized.accountUserId || !authorized.memberMutationRevision) return reply({ error: "请先完成 OA 成员激活、实名绑定及保密协议，再提交审核。Chat 草稿已保留。" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return reply({ error: "导入必须使用 JSON 格式。" }, 415);
  const parsed = await readBoundedJsonObject(request, 125_000);
  if (!parsed.ok) return reply({ error: "导入数据格式不正确或超过大小限制。" }, parsed.reason === "too_large" ? 413 : 400);
  let imported;
  try {
    imported = parseChatKnowledgeImport(parsed.value);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "导入格式不正确。" }, 400);
  }
  const actor: KnowledgeActor = {
    memberId: authorized.memberId,
    accountUserId: authorized.accountUserId,
    memberMutationRevision: authorized.memberMutationRevision,
    name: authorized.user.displayName,
    email: authorized.user.email,
    isAdmin: authorized.isAdmin,
  };
  try {
    const db = await getDb();
    if (!(await consumeWriteRateLimit(db, { actorSubject: actor.accountUserId, scope: "knowledge_submit", limit: 10 }))) return reply({ error: "导入过于频繁，请稍后再试。" }, 429);
    const items = [];
    for (const [part, submission] of imported.submissions.entries()) {
      const identity = await chatImportIdentity(actor.accountUserId, imported.documentId, submission, part);
      const item = await createChatImportedKnowledgeItem(actor, submission, identity.contentHash, identity.itemId);
      if (!item) return reply({ error: "成员或资料状态已变化，请刷新后重试；已接收的分段不会重复创建。" }, 409);
      items.push({ id: item.id, title: item.title, status: item.status, visibility: item.visibility });
    }
    return reply({ received: true, items }, 201);
  } catch {
    return reply({ error: "OA 暂未确认完整接收，Chat 草稿仍保留。请重试，已接收的分段不会重复创建。" }, 503);
  }
}
