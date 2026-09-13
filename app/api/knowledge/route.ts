import { getDb } from "../../../db";
import { readBoundedJsonObject } from "../../../lib/bounded-json-request";
import { hashKnowledgeSubmission, parseKnowledgeSubmission } from "../../../lib/knowledge-policy";
import { countPendingKnowledgeItems, createKnowledgeItem, listKnowledgeItems, type KnowledgeActor, type KnowledgeListScope } from "../../../lib/knowledge-store";
import {
  KNOWLEDGE_LIST_QUERY_MAX_LENGTH,
  KNOWLEDGE_LIST_SORTS,
  type KnowledgeListOptions,
  type KnowledgeListSort,
} from "../../../lib/knowledge-types";
import { consumeWriteRateLimit } from "../../../lib/write-rate-limit";
import { getAuthorizedUser, isProjectOwner, type AuthorizedUser } from "../_lib/auth";

const MAX_KNOWLEDGE_REQUEST_BYTES = 80_000;
const MAX_KNOWLEDGE_SUBMISSIONS_PER_MINUTE = 10;

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

export async function GET(request: Request) {
  const access = await authorizeKnowledgeAccess();
  if ("response" in access) return access.response;
  const canReview = canReviewKnowledge(access.authorized);
  const searchParams = new URL(request.url).searchParams;
  const rawScope = searchParams.get("scope") || "all";
  if (rawScope !== "mine" && rawScope !== "review" && rawScope !== "all") return privateJson({ error: "知识列表查询参数不正确。" }, { status: 400 });
  const scope = rawScope as KnowledgeListScope;
  if (scope === "review" && !canReview) return privateJson({ error: "只有项目负责人或 OA 管理员可以查看待审核知识。" }, { status: 403 });
  const hasManagementQuery = searchParams.has("q") || searchParams.has("sort");
  if (hasManagementQuery && scope !== "all") return privateJson({ error: "搜索和排序仅可用于知识库管理列表。" }, { status: 400 });
  if (hasManagementQuery && !canReview) return privateJson({ error: "只有项目负责人或 OA 管理员可以搜索或排序知识库记录。" }, { status: 403 });

  const query = searchParams.get("q")?.trim() || "";
  if (Array.from(query).length > KNOWLEDGE_LIST_QUERY_MAX_LENGTH) {
    return privateJson({ error: `搜索关键词不能超过 ${KNOWLEDGE_LIST_QUERY_MAX_LENGTH} 个字符。` }, { status: 400 });
  }
  const rawSort = searchParams.get("sort");
  if (rawSort !== null && !(KNOWLEDGE_LIST_SORTS as readonly string[]).includes(rawSort)) {
    return privateJson({ error: "知识列表排序参数不正确。" }, { status: 400 });
  }
  const listOptions: KnowledgeListOptions | undefined = hasManagementQuery ? {
    ...(query ? { query } : {}),
    ...(rawSort ? { sort: rawSort as KnowledgeListSort } : {}),
  } : undefined;
  try {
    const [items, pendingCount] = await Promise.all([
      listKnowledgeItems(scope, access.actor, canReview, listOptions),
      canReview ? countPendingKnowledgeItems(access.actor) : Promise.resolve(0),
    ]);
    return privateJson({ items, pendingCount, canReviewKnowledge: canReview });
  } catch {
    return privateJson({ error: "知识库暂不可用，请稍后重试。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const access = await authorizeKnowledgeAccess();
  if ("response" in access) return access.response;
  if (!isJsonRequest(request)) return privateJson({ error: "知识投稿必须使用 JSON 格式提交。" }, { status: 415 });
  const parsedBody = await readBoundedJsonObject(request, MAX_KNOWLEDGE_REQUEST_BYTES);
  if (!parsedBody.ok) return privateJson(
    { error: parsedBody.reason === "too_large" ? "知识投稿数据过大。" : "知识投稿格式不正确。" },
    { status: parsedBody.reason === "too_large" ? 413 : 400 },
  );
  const submission = parseKnowledgeSubmission(parsedBody.value);
  if (!submission.ok) return privateJson({ error: submission.error }, { status: 400 });

  try {
    const db = await getDb();
    if (!(await consumeWriteRateLimit(db, { actorSubject: access.actor.accountUserId, scope: "knowledge_submit", limit: MAX_KNOWLEDGE_SUBMISSIONS_PER_MINUTE }))) {
      return privateJson({ error: "知识投稿过于频繁，请稍后再试。" }, { status: 429, headers: { "retry-after": "60" } });
    }
    const contentHash = await hashKnowledgeSubmission(submission.value);
    const item = await createKnowledgeItem(access.actor, submission.value, contentHash);
    if (!item) return privateJson({ error: "成员状态已发生变化，请刷新后重试。" }, { status: 409 });
    return privateJson({ item }, { status: 201 });
  } catch {
    return privateJson({ error: "知识投稿暂时无法保存，请稍后重试。" }, { status: 500 });
  }
}
