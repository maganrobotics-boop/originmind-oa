import { readBoundedJsonObject } from "../../../../../lib/bounded-json-request";
import { chatImportIdentity, parseChatKnowledgeImport } from "../../../../../lib/chat-knowledge-import";
import {
  findKnowledgeItem,
  type KnowledgeActor,
  type KnowledgeItemWithRevisionRow,
} from "../../../../../lib/knowledge-store";
import { getAuthorizedUser } from "../../../_lib/auth";

const CHAT_ORIGIN = "https://chat.omindos.ai";
// Status verification hashes the same complete document as the import route.
// Keep the JSON envelope bound aligned with that route so a valid 5 MiB import
// can still be recognized after the Chat management page is refreshed.
const MAX_CHAT_STATUS_REQUEST_BYTES = 12 * 1024 * 1024;

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

function exactOwner(item: KnowledgeItemWithRevisionRow, actor: KnowledgeActor) {
  return item.submitter_member_id === actor.memberId
    && item.submitter_email.trim().toLowerCase() === actor.email.trim().toLowerCase();
}

export async function OPTIONS(request: Request) {
  const requestedHeaders = (request.headers.get("access-control-request-headers") || "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowedOrigin(request)
    || request.headers.get("access-control-request-method") !== "POST"
    || requestedHeaders.some((value) => value !== "content-type")) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function POST(request: Request) {
  if (!allowedOrigin(request)) return Response.json({ error: "请从 Chat 管理页面核对。" }, { status: 403 });
  const authorized = await getAuthorizedUser({ readOnly: true, noTouch: true });
  if (!authorized) return reply({ error: "请先在同一浏览器登录 OA，再返回 Chat 管理页面刷新。" }, 401);
  if (!authorized.ndaCompleted || !authorized.memberId || !authorized.accountUserId || !authorized.memberMutationRevision) {
    return reply({ error: "请先完成 OA 成员激活、实名绑定及保密协议，再核对提交状态。" }, 403);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return reply({ error: "核对数据必须使用 JSON 格式。" }, 415);
  }
  const parsed = await readBoundedJsonObject(request, MAX_CHAT_STATUS_REQUEST_BYTES);
  if (!parsed.ok) return reply({ error: "核对数据格式不正确或超过大小限制。" }, parsed.reason === "too_large" ? 413 : 400);
  if (!Object.hasOwn(parsed.value, "document") || Object.keys(parsed.value).some((key) => key !== "document")) {
    return reply({ error: "核对数据包含不支持的字段。" }, 400);
  }
  let imported;
  try {
    imported = parseChatKnowledgeImport({ document: parsed.value.document });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "核对格式不正确。" }, 400);
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
    const submission = imported.submissions[0];
    const identity = await chatImportIdentity(actor.accountUserId, imported.documentId, submission, 0);
    const existing = await findKnowledgeItem(identity.itemId, actor);
    const submitted = Boolean(existing && exactOwner(existing, actor) && existing.content_hash === identity.contentHash);
    if (existing && !submitted) {
      return reply({ error: "OA 中存在同编号但版本不一致的资料，请在 OA 中核对。" }, 409);
    }
    return reply({
      documentId: imported.documentId,
      submitted,
      item: submitted && existing ? { id: existing.id, status: existing.status } : null,
    });
  } catch {
    return reply({ error: "暂时无法核对 OA 提交状态，请稍后重试。" }, 503);
  }
}
