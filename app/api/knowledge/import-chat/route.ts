import { isKnowledgeUploadOrigin } from "../../../../lib/knowledge-upload-origin";
import { getDb } from "../../../../db";
import { readBoundedJsonObject } from "../../../../lib/bounded-json-request";
import { chatImportIdentity, parseChatKnowledgeImport } from "../../../../lib/chat-knowledge-import";
import { knowledgeAssetUploadToken } from "../../../../lib/knowledge-asset-upload";
import {
  createChatImportedKnowledgeItem,
  findKnowledgeItem,
  knowledgeRevisionHashExists,
  resubmitKnowledgeItem,
  stageAdminKnowledgeEdit,
  type KnowledgeActor,
  type KnowledgeItemWithRevisionRow,
} from "../../../../lib/knowledge-store";
import { consumeWriteRateLimit } from "../../../../lib/write-rate-limit";
import { getAuthorizedUser } from "../../_lib/auth";

const CHAT_ORIGIN = "https://chat.omindos.ai";
const MAX_CHAT_IMPORT_REQUEST_BYTES = 12 * 1024 * 1024;
const SAFE_KNOWLEDGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function corsHeaders(): Record<string, string> { return { "access-control-allow-origin": CHAT_ORIGIN, "access-control-allow-credentials": "true", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "cache-control": "private, no-store, max-age=0", vary: "Origin, Cookie" }; }
function reply(data: unknown, status = 200) { return Response.json(data, { status, headers: corsHeaders() }); }
function allowedOrigin(request: Request) { return isKnowledgeUploadOrigin(request); }
function exactOwner(item: KnowledgeItemWithRevisionRow, actor: KnowledgeActor) { return item.submitter_member_id === actor.memberId && item.submitter_email.trim().toLowerCase() === actor.email.trim().toLowerCase(); }
function isAcknowledgedResubmission(item: KnowledgeItemWithRevisionRow, actor: KnowledgeActor, contentHash: string, expectedRevisionNo?: number) { const revisionNo = Number(item.current_revision_no); return exactOwner(item, actor) && item.status === "pending" && item.revision_status === "pending" && revisionNo >= 2 && (expectedRevisionNo === undefined || revisionNo === expectedRevisionNo) && Boolean(item.current_revision_id) && !item.active_revision_id && item.content_hash === contentHash; }
function isAcknowledgedAdminEdit(item: KnowledgeItemWithRevisionRow, actor: KnowledgeActor, contentHash: string) { return actor.isAdmin && item.status === "active" && item.revision_status === "pending" && Boolean(item.current_revision_id) && Boolean(item.active_revision_id) && item.current_revision_id !== item.active_revision_id && item.content_hash === contentHash; }
function acknowledgedReply(item: KnowledgeItemWithRevisionRow, partCount: number) { return reply({ received: true, item: { id: item.id, title: item.title, status: item.status, visibility: item.visibility, currentRevisionNo: Number(item.current_revision_no), mutationRevision: item.mutation_revision }, partCount, assetUpload: item.current_revision_id ? { revisionId: item.current_revision_id, uploadToken: knowledgeAssetUploadToken() } : undefined }); }
export async function OPTIONS(request: Request) { const requestedHeaders = (request.headers.get("access-control-request-headers") || "").toLowerCase().split(",").map((value) => value.trim()).filter(Boolean); if (!allowedOrigin(request) || request.headers.get("access-control-request-method") !== "POST" || requestedHeaders.some((value) => value !== "content-type")) return new Response(null, { status: 403 }); return new Response(null, { status: 204, headers: corsHeaders() }); }
export async function POST(request: Request) {
  if (!allowedOrigin(request)) return Response.json({ error: "请从 OA 或 Chat 管理页面提交。" }, { status: 403 });
  const authorized = await getAuthorizedUser();
  if (!authorized) return reply({ error: "请先在同一浏览器登录 OA，然后返回此页点击“提交 OA 待审”。Chat 草稿已保留。" }, 401);
  if (!authorized.ndaCompleted || !authorized.memberId || !authorized.accountUserId || !authorized.memberMutationRevision) return reply({ error: "请先完成 OA 成员激活、实名绑定及保密协议，再提交审核。Chat 草稿已保留。" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return reply({ error: "导入必须使用 JSON 格式。" }, 415);
  const parsed = await readBoundedJsonObject(request, MAX_CHAT_IMPORT_REQUEST_BYTES);
  if (!parsed.ok) return reply({ error: "导入数据格式不正确或超过大小限制。" }, parsed.reason === "too_large" ? 413 : 400);
  const envelopeKeys = Object.keys(parsed.value);
  if (!Object.hasOwn(parsed.value, "document") || envelopeKeys.some((key) => key !== "document" && key !== "returnedKnowledgeItemId" && key !== "adminKnowledgeItemId")) return reply({ error: "导入数据包含不支持的字段。" }, 400);
  let returnedKnowledgeItemId: string | undefined;
  if (Object.hasOwn(parsed.value, "returnedKnowledgeItemId")) { const candidate = parsed.value.returnedKnowledgeItemId; if (typeof candidate !== "string" || !SAFE_KNOWLEDGE_ID.test(candidate)) return reply({ error: "退回知识条目编号格式不正确。" }, 400); returnedKnowledgeItemId = candidate; }
  let adminKnowledgeItemId: string | undefined;
  if (Object.hasOwn(parsed.value, "adminKnowledgeItemId")) { const candidate = parsed.value.adminKnowledgeItemId; if (typeof candidate !== "string" || !SAFE_KNOWLEDGE_ID.test(candidate)) return reply({ error: "知识条目编号格式不正确。" }, 400); adminKnowledgeItemId = candidate; }
  if (returnedKnowledgeItemId && adminKnowledgeItemId) return reply({ error: "不能同时重提和管理员修改同一条知识。" }, 400);
  let imported; try { imported = parseChatKnowledgeImport({ document: parsed.value.document }); } catch (error) { return reply({ error: error instanceof Error ? error.message : "导入格式不正确。" }, 400); }
  if (request.headers.get("origin") === new URL(request.url).origin) imported.submissions[0] = { ...imported.submissions[0], sourceLabel: `OA 资料导入 · ${imported.submissions[0].title}` };
  const actor: KnowledgeActor = { memberId: authorized.memberId, accountUserId: authorized.accountUserId, memberMutationRevision: authorized.memberMutationRevision, name: authorized.user.displayName, email: authorized.user.email, isAdmin: authorized.isAdmin };
  try {
    const db = await getDb();
    if (!(await consumeWriteRateLimit(db, { actorSubject: actor.accountUserId, scope: "knowledge_submit", limit: 10 }))) return reply({ error: "导入过于频繁，请稍后再试。" }, 429);
    let submission = imported.submissions[0]; let identity: Awaited<ReturnType<typeof chatImportIdentity>>; let existing: KnowledgeItemWithRevisionRow | null = null;
    if (adminKnowledgeItemId) {
      if (!actor.isAdmin) return reply({ error: "只有 OA 系统管理员可以直接修改正式知识。" }, 403);
      existing = await findKnowledgeItem(adminKnowledgeItemId, actor, true);
      if (!existing) return reply({ error: "知识条目不存在或当前账号不可操作。" }, 404);
      identity = await chatImportIdentity(actor.accountUserId, imported.documentId, submission, 0);
      if (isAcknowledgedAdminEdit(existing, actor, identity.contentHash)) return acknowledgedReply(existing, imported.partCount);
      if (existing.status !== "active" || existing.current_revision_id !== existing.active_revision_id) return reply({ error: "该知识正在修改，请刷新后重试。" }, 409);
      if (await knowledgeRevisionHashExists(existing.id, identity.contentHash)) return reply({ error: "修改后的内容必须与历史版本不同。" }, 409);
    } else if (returnedKnowledgeItemId) {
      existing = await findKnowledgeItem(returnedKnowledgeItemId, actor); if (!existing || !exactOwner(existing, actor)) return reply({ error: "退回知识条目不存在或当前账号不可操作。" }, 404);
      submission = { ...submission, title: existing.title, category: existing.category, sourceLabel: existing.source_label || "", sourceUrl: existing.source_url || "" };
      identity = await chatImportIdentity(actor.accountUserId, imported.documentId, submission, 0);
      if (isAcknowledgedResubmission(existing, actor, identity.contentHash)) return acknowledgedReply(existing, imported.partCount);
      if (existing.status !== "returned") return reply({ error: "只有已退回的知识可以重新导入。" }, 409);
      if (Number(existing.content_part_count ?? 0) <= 1) return reply({ error: "该知识不是从 Chat 导入的大文档，请在 OA 中修改并重提。" }, 409);
      if (await knowledgeRevisionHashExists(existing.id, identity.contentHash)) return reply({ error: "请先修改文件内容；不能提交与旧版本相同的知识。" }, 409);
    } else identity = await chatImportIdentity(actor.accountUserId, imported.documentId, submission, 0);
    const contentParts = imported.parts.map((part) => part.content);
    const item = adminKnowledgeItemId && existing
      ? await stageAdminKnowledgeEdit(existing, actor, submission, identity.contentHash, contentParts)
      : existing ? await resubmitKnowledgeItem(existing, actor, submission, identity.contentHash, contentParts)
      : await createChatImportedKnowledgeItem(actor, submission, identity.contentHash, identity.itemId, contentParts);
    if (!item && existing) { const current = await findKnowledgeItem(existing.id, actor); if (current && isAcknowledgedResubmission(current, actor, identity.contentHash, Number(existing.current_revision_no) + 1)) return acknowledgedReply(current, imported.partCount); }
    if (!item) return reply({ error: existing ? "知识条目已更新，请从 OA 重新打开退回链接后再试。" : "成员或资料状态已变化，请刷新后重试；已接收的文件不会重复创建。" }, 409);
    const current = await findKnowledgeItem(item.id, actor);
    if (!current?.current_revision_id) return reply({ error: "OA 已接收正文，但未能建立图片上传会话，请重试。" }, 503);
    return reply({ received: true, item: { id: item.id, title: item.title, status: item.status, visibility: item.visibility, currentRevisionNo: item.currentRevisionNo, mutationRevision: current.mutation_revision }, partCount: imported.partCount, assetUpload: { revisionId: current.current_revision_id, uploadToken: knowledgeAssetUploadToken() } }, 201);
  } catch { return reply({ error: "OA 暂未确认完整接收，Chat 草稿或当前页面正文仍保留。请重试，已接收的文件不会重复创建。" }, 503); }
}
