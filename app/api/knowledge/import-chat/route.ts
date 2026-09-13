import { getDb } from "../../../../db";
import { readBoundedJsonObject } from "../../../../lib/bounded-json-request";
import { chatImportIdentity, parseChatKnowledgeImport } from "../../../../lib/chat-knowledge-import";
import {
  createChatImportedKnowledgeItem,
  findKnowledgeItem,
  knowledgeRevisionHashExists,
  resubmitKnowledgeItem,
  type KnowledgeActor,
  type KnowledgeItemWithRevisionRow,
} from "../../../../lib/knowledge-store";
import { consumeWriteRateLimit } from "../../../../lib/write-rate-limit";
import { getAuthorizedUser } from "../../_lib/auth";

const CHAT_ORIGIN = "https://chat.omindos.ai";
const MAX_CHAT_IMPORT_REQUEST_BYTES = 12 * 1024 * 1024;
const SAFE_KNOWLEDGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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

function isAcknowledgedResubmission(
  item: KnowledgeItemWithRevisionRow,
  actor: KnowledgeActor,
  contentHash: string,
  expectedRevisionNo?: number,
) {
  const revisionNo = Number(item.current_revision_no);
  return exactOwner(item, actor)
    && item.status === "pending"
    && item.revision_status === "pending"
    && revisionNo >= 2
    && (expectedRevisionNo === undefined || revisionNo === expectedRevisionNo)
    && Boolean(item.current_revision_id)
    && !item.active_revision_id
    && item.content_hash === contentHash;
}

function acknowledgedReply(item: KnowledgeItemWithRevisionRow, partCount: number) {
  return reply({
    received: true,
    item: {
      id: item.id,
      title: item.title,
      status: item.status,
      visibility: item.visibility,
      currentRevisionNo: Number(item.current_revision_no),
    },
    partCount,
  });
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
  const parsed = await readBoundedJsonObject(request, MAX_CHAT_IMPORT_REQUEST_BYTES);
  if (!parsed.ok) return reply({ error: "导入数据格式不正确或超过大小限制。" }, parsed.reason === "too_large" ? 413 : 400);
  const envelopeKeys = Object.keys(parsed.value);
  if (!Object.hasOwn(parsed.value, "document")
    || envelopeKeys.some((key) => key !== "document" && key !== "returnedKnowledgeItemId")) {
    return reply({ error: "导入数据包含不支持的字段。" }, 400);
  }
  let returnedKnowledgeItemId: string | undefined;
  if (Object.hasOwn(parsed.value, "returnedKnowledgeItemId")) {
    const candidate = parsed.value.returnedKnowledgeItemId;
    if (typeof candidate !== "string" || !SAFE_KNOWLEDGE_ID.test(candidate)) {
      return reply({ error: "退回知识条目编号格式不正确。" }, 400);
    }
    returnedKnowledgeItemId = candidate;
  }
  let imported;
  try {
    imported = parseChatKnowledgeImport({ document: parsed.value.document });
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
    let submission = imported.submissions[0];
    let identity: Awaited<ReturnType<typeof chatImportIdentity>>;
    let existing: KnowledgeItemWithRevisionRow | null = null;
    if (returnedKnowledgeItemId) {
      existing = await findKnowledgeItem(returnedKnowledgeItemId, actor);
      if (!existing) return reply({ error: "退回知识条目不存在或当前账号不可操作。" }, 404);
      if (!exactOwner(existing, actor)) return reply({ error: "退回知识条目不存在或当前账号不可操作。" }, 404);
      // The returned-item URL carries only the opaque item ID. Keep the OA
      // metadata authoritative so a new filename/default Chat fields cannot
      // silently overwrite the original title, category, date label or URL.
      submission = {
        ...submission,
        title: existing.title,
        category: existing.category,
        sourceLabel: existing.source_label || "",
        sourceUrl: existing.source_url || "",
      };
      identity = await chatImportIdentity(actor.accountUserId, imported.documentId, submission, 0);
      if (isAcknowledgedResubmission(existing, actor, identity.contentHash)) {
        return acknowledgedReply(existing, imported.partCount);
      }
      if (existing.status !== "returned") return reply({ error: "只有已退回的知识可以重新导入。" }, 409);
      if (Number(existing.content_part_count ?? 0) <= 1) return reply({ error: "该知识不是从 Chat 导入的大文档，请在 OA 中修改并重提。" }, 409);
      if (await knowledgeRevisionHashExists(existing.id, identity.contentHash)) {
        return reply({ error: "请先修改文件内容；不能提交与旧版本相同的知识。" }, 409);
      }
    } else {
      identity = await chatImportIdentity(actor.accountUserId, imported.documentId, submission, 0);
    }
    const contentParts = imported.parts.map((part) => part.content);
    const item = existing
      ? await resubmitKnowledgeItem(existing, actor, submission, identity.contentHash, contentParts)
      : await createChatImportedKnowledgeItem(actor, submission, identity.contentHash, identity.itemId, contentParts);
    if (!item && existing) {
      const current = await findKnowledgeItem(existing.id, actor);
      if (current && isAcknowledgedResubmission(current, actor, identity.contentHash, Number(existing.current_revision_no) + 1)) {
        return acknowledgedReply(current, imported.partCount);
      }
    }
    if (!item) return reply({ error: existing ? "知识条目已更新，请从 OA 重新打开退回链接后再试。" : "成员或资料状态已变化，请刷新后重试；已接收的文件不会重复创建。" }, 409);
    return reply({
      received: true,
      item: { id: item.id, title: item.title, status: item.status, visibility: item.visibility, currentRevisionNo: item.currentRevisionNo },
      partCount: imported.partCount,
    }, 201);
  } catch {
    return reply({ error: "OA 暂未确认完整接收，Chat 草稿或当前页面正文仍保留。请重试，已接收的文件不会重复创建。" }, 503);
  }
}
