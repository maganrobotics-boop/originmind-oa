import { getDb } from "../../../../../../db";
import { getKnowledgeAssetsBucket } from "../../../../../../lib/knowledge-assets-env";
import { listKnowledgeRevisionAssets, normalizeKnowledgeAssetPath } from "../../../../../../lib/knowledge-assets";
import { findKnowledgeItem, getKnowledgeItemDetail, type KnowledgeActor } from "../../../../../../lib/knowledge-store";
import { getAuthorizedUser, isProjectOwner, type AuthorizedUser } from "../../../../_lib/auth";

const SAFE_KNOWLEDGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function privateJson(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store, max-age=0");
  return Response.json(data, { ...init, headers });
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

async function safeParams(params: Promise<{ id: string; assetPath: string[] }>) {
  const { id, assetPath } = await params;
  if (!SAFE_KNOWLEDGE_ID.test(id)) return null;
  try {
    return { id, assetPath: normalizeKnowledgeAssetPath(assetPath.join("/")) };
  } catch {
    return null;
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string; assetPath: string[] }> }) {
  const access = await authorizeKnowledgeAccess();
  if ("response" in access) return access.response;
  const safe = await safeParams(params);
  if (!safe) return privateJson({ error: "知识图片不存在。" }, { status: 404 });
  try {
    const detail = await getKnowledgeItemDetail(safe.id, access.actor, canReviewKnowledge(access.authorized));
    const query = new URL(request.url).searchParams;
    const forChat = query.has("forChat") || query.has("revision");
    const requestedRevision = query.get("revision");
    const currentItem = forChat ? await findKnowledgeItem(safe.id, access.actor) : null;
    if (forChat && (query.get("forChat") !== "1" || !requestedRevision || !SAFE_KNOWLEDGE_ID.test(requestedRevision)
      || [...query.keys()].some(key => !["forChat", "revision"].includes(key))
      || currentItem?.status !== "active" || currentItem.active_revision_id !== requestedRevision
      || currentItem.current_revision_id !== requestedRevision)) return privateJson({ error: "知识图片不存在或版本已失效。" }, { status: 404 });
    const revisionId = forChat ? requestedRevision : (detail?.item as { currentRevisionId?: string } | undefined)?.currentRevisionId;
    if (!revisionId) return privateJson({ error: "知识图片不存在。" }, { status: 404 });
    const db = await getDb();
    const assets = await listKnowledgeRevisionAssets(db.$client, revisionId);
    const asset = assets.find((item) => item.assetPath === safe.assetPath);
    if (!asset) return privateJson({ error: "知识图片不存在。" }, { status: 404 });
    const object = await (await getKnowledgeAssetsBucket()).get(asset.storageKey);
    if (!object) return privateJson({ error: "知识图片暂不可用。" }, { status: 404 });
    return new Response(object.body, {
      headers: {
        "content-type": asset.mimeType,
        "cache-control": "private, no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return privateJson({ error: "知识图片暂不可用，请稍后重试。" }, { status: 500 });
  }
}
