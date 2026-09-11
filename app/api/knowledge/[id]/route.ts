import { getDb } from "../../../../db";
import { readBoundedJsonObject } from "../../../../lib/bounded-json-request";
import {
  hashKnowledgeSubmission,
  isPublicKnowledgeConfirmation,
  knowledgeActionAllowed,
  parseKnowledgeReviewAction,
  parseKnowledgeSubmission,
  parseKnowledgeVisibility,
  parseReviewNote,
} from "../../../../lib/knowledge-policy";
import {
  findKnowledgeItem,
  getKnowledgeItemDetail,
  knowledgeRevisionHashExists,
  resubmitKnowledgeItem,
  reviewKnowledgeItem,
  type KnowledgeActor,
} from "../../../../lib/knowledge-store";
import { consumeWriteRateLimit } from "../../../../lib/write-rate-limit";
import { getAuthorizedUser, isProjectOwner, type AuthorizedUser } from "../../_lib/auth";

const MAX_KNOWLEDGE_PATCH_BYTES = 80_000;
const MAX_KNOWLEDGE_WRITES_PER_MINUTE = 20;
const SAFE_KNOWLEDGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function privateJson(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store, max-age=0");
  return Response.json(data, { ...init, headers });
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function canReviewKnowledge(authorized: AuthorizedUser): boolean {
  return authorized.isAdmin || authorized.role === "project_owner";
}

function knowledgeActor(authorized: AuthorizedUser): KnowledgeActor | null {
  if (!authorized.ndaCompleted || !authorized.memberId || !authorized.accountUserId || !authorized.memberMutationRevision) return null;
  return {
    memberId: authorized.memberId,
    accountUserId: authorized.accountUserId,
    memberMutationRevision: authorized.memberMutationRevision,
    name: authorized.user.displayName,
    email: authorized.user.email,
    isAdmin: authorized.isAdmin,
    configuredReviewer: isProjectOwner(authorized.user.email, authorized.accountUserId),
  };
}

async function authorizeKnowledgeAccess() {
  const authorized = await getAuthorizedUser();
  if (!authorized) return { response: privateJson({ error: "请先完成成员注册。" }, { status: 401 }) } as const;
  if (!authorized.ndaCompleted) return { response: privateJson({ error: "请先完成保密协议签署与归档。" }, { status: 403 }) } as const;
  const actor = knowledgeActor(authorized);
  if (!actor) return { response: privateJson({ error: "知识库仅向已激活、实名绑定的 OA 成员开放。" }, { status: 403 }) } as const;
  return { authorized, actor } as const;
}

async function safeId(params: Promise<{ id: string }>) {
  const { id } = await params;
  return SAFE_KNOWLEDGE_ID.test(id) ? id : null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await authorizeKnowledgeAccess();
  if ("response" in access) return access.response;
  const id = await safeId(params);
  if (!id) return privateJson({ error: "知识条目不存在。" }, { status: 404 });
  try {
    const detail = await getKnowledgeItemDetail(id, access.actor, canReviewKnowledge(access.authorized));
    return detail ? privateJson(detail) : privateJson({ error: "知识条目不存在或当前账号无权查看。" }, { status: 404 });
  } catch {
    return privateJson({ error: "知识详情暂不可用，请稍后重试。" }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await authorizeKnowledgeAccess();
  if ("response" in access) return access.response;
  const id = await safeId(params);
  if (!id) return privateJson({ error: "知识条目不存在。" }, { status: 404 });
  if (!isJsonRequest(request)) return privateJson({ error: "知识流转必须使用 JSON 格式提交。" }, { status: 415 });
  const parsedBody = await readBoundedJsonObject(request, MAX_KNOWLEDGE_PATCH_BYTES);
  if (!parsedBody.ok) return privateJson(
    { error: parsedBody.reason === "too_large" ? "知识流转数据过大。" : "知识流转格式不正确。" },
    { status: parsedBody.reason === "too_large" ? 413 : 400 },
  );
  const body = parsedBody.value;
  const action = typeof body.action === "string" ? body.action : "";
  const allowedKeys = action === "resubmit"
    ? new Set(["action", "mutationRevision", "title", "category", "summary", "sourceLabel", "sourceUrl", "content"])
    : action === "approve"
      ? new Set(["action", "mutationRevision", "note", "visibility", "publicConfirmation"])
      : new Set(["action", "mutationRevision", "note"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) return privateJson({ error: "知识流转包含不支持的字段。" }, { status: 400 });
  if (typeof body.mutationRevision !== "string" || !body.mutationRevision.trim()) return privateJson({ error: "请刷新知识条目后再操作。" }, { status: 409 });
  const reviewAction = action === "resubmit" ? null : parseKnowledgeReviewAction(action);
  if (action !== "resubmit" && !reviewAction) return privateJson({ error: "不支持的知识流转动作。" }, { status: 400 });
  const parsedApprovalVisibility = reviewAction === "approve" ? parseKnowledgeVisibility(body.visibility) : null;
  if (reviewAction === "approve" && !parsedApprovalVisibility) {
    return privateJson({ error: "批准知识时必须选择对内或对外公开。" }, { status: 400 });
  }
  const approvalVisibility = parsedApprovalVisibility ?? undefined;
  if (approvalVisibility === "public" && !isPublicKnowledgeConfirmation(body.publicConfirmation)) {
    return privateJson({ error: "对外公开需要完成精确的二次确认。" }, { status: 400 });
  }
  if (approvalVisibility === "internal" && Object.hasOwn(body, "publicConfirmation")) {
    return privateJson({ error: "对内知识不接受对外公开确认字段。" }, { status: 400 });
  }
  const publicConfirmation = approvalVisibility === "public" ? body.publicConfirmation : undefined;

  try {
    const reviewIntent = action !== "resubmit";
    const existing = await findKnowledgeItem(id, access.actor, reviewIntent);
    if (!existing) return privateJson({ error: "知识条目不存在。" }, { status: 404 });
    if (body.mutationRevision !== existing.mutation_revision) {
      return privateJson({ error: "知识条目已更新，请刷新后重试。" }, { status: 409 });
    }
    const isSubmitter = existing.submitter_member_id === access.actor.memberId
      && existing.submitter_email.trim().toLowerCase() === access.actor.email.trim().toLowerCase();

    if (action === "resubmit") {
      if (!isSubmitter) return privateJson({ error: "知识条目不存在或当前账号不可操作。" }, { status: 404 });
      if (existing.status !== "returned") return privateJson({ error: "只有已退回的知识可以补充后重新提交。" }, { status: 409 });
      const submission = parseKnowledgeSubmission({
        title: body.title,
        category: body.category,
        summary: body.summary,
        sourceLabel: body.sourceLabel,
        sourceUrl: body.sourceUrl,
        content: body.content,
      });
      if (!submission.ok) return privateJson({ error: submission.error }, { status: 400 });
      const contentHash = await hashKnowledgeSubmission(submission.value);
      if (await knowledgeRevisionHashExists(id, contentHash)) return privateJson({ error: "补充材料必须形成一个新的知识版本。" }, { status: 409 });
      const db = await getDb();
      if (!(await consumeWriteRateLimit(db, { actorSubject: access.actor.accountUserId, scope: "knowledge_submit", limit: MAX_KNOWLEDGE_WRITES_PER_MINUTE }))) {
        return privateJson({ error: "知识投稿过于频繁，请稍后再试。" }, { status: 429, headers: { "retry-after": "60" } });
      }
      const item = await resubmitKnowledgeItem(existing, access.actor, submission.value, contentHash);
      return item ? privateJson({ item }) : privateJson({ error: "知识条目已更新，请刷新后重试。" }, { status: 409 });
    }

    if (!reviewAction) return privateJson({ error: "不支持的知识流转动作。" }, { status: 400 });
    if (!canReviewKnowledge(access.authorized)) return privateJson({ error: "只有项目负责人或 OA 管理员可以审核知识。" }, { status: 403 });
    if (isSubmitter) return privateJson({ error: "投稿人不能审核自己的知识。" }, { status: 403 });
    if (!knowledgeActionAllowed(existing.status, reviewAction)) return privateJson({ error: "当前状态不允许执行该审核动作。" }, { status: 409 });
    const parsedNote = parseReviewNote(body.note);
    if (!parsedNote.ok) return privateJson({ error: parsedNote.error }, { status: 400 });
    if ((reviewAction === "return" || reviewAction === "reject" || reviewAction === "revoke") && parsedNote.value.length < 2) {
      return privateJson({ error: "退回、拒绝或下架时请填写至少 2 个字符的原因。" }, { status: 400 });
    }
    const db = await getDb();
    if (!(await consumeWriteRateLimit(db, { actorSubject: access.actor.accountUserId, scope: "knowledge_review", limit: MAX_KNOWLEDGE_WRITES_PER_MINUTE }))) {
      return privateJson({ error: "知识审核操作过于频繁，请稍后再试。" }, { status: 429, headers: { "retry-after": "60" } });
    }
    const item = await reviewKnowledgeItem(existing, access.actor, reviewAction, parsedNote.value, approvalVisibility, publicConfirmation);
    return item ? privateJson({ item }) : privateJson({ error: "知识条目已更新，请刷新后重试。" }, { status: 409 });
  } catch {
    return privateJson({ error: "知识流转暂时无法保存，请稍后重试。" }, { status: 500 });
  }
}
