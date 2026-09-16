import { getDb } from "../../../../../db";
import { readBoundedJsonObject } from "../../../../../lib/bounded-json-request";
import { authorizeKnowledgeAssetRevision } from "../../../../../lib/knowledge-asset-authorization";
import { finalizeKnowledgeAssets } from "../../../../../lib/knowledge-asset-upload";
import type { KnowledgeActor } from "../../../../../lib/knowledge-store";
import { getAuthorizedUser } from "../../../_lib/auth";

const CHAT_ORIGIN = "https://chat.omindos.ai";
function headers() { return { "access-control-allow-origin": CHAT_ORIGIN, "access-control-allow-credentials": "true", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "cache-control": "private, no-store", vary: "Origin, Cookie" }; }
function reply(data: unknown, status = 200) { return Response.json(data, { status, headers: headers() }); }
export async function OPTIONS(request: Request) { return request.headers.get("origin") === CHAT_ORIGIN ? new Response(null, { status: 204, headers: headers() }) : new Response(null, { status: 403 }); }

export async function POST(request: Request) {
  if (request.headers.get("origin") !== CHAT_ORIGIN) return reply({ error: "请从 Chat 管理页面提交。" }, 403);
  const authorized = await getAuthorizedUser();
  if (!authorized?.memberId || !authorized.accountUserId || !authorized.memberMutationRevision || !authorized.ndaCompleted) return reply({ error: "请先完成 OA 登录、实名绑定及保密协议。" }, 401);
  const actor: KnowledgeActor = { memberId: authorized.memberId, accountUserId: authorized.accountUserId, memberMutationRevision: authorized.memberMutationRevision, name: authorized.user.displayName, email: authorized.user.email, isAdmin: authorized.isAdmin };
  const parsed = await readBoundedJsonObject(request, 64 * 1024);
  if (!parsed.ok) return reply({ error: "图片清单格式不正确。" }, 400);
  const { itemId, revisionId, uploadToken, expectedPaths } = parsed.value as Record<string, unknown>;
  if (typeof itemId !== "string" || typeof revisionId !== "string" || typeof uploadToken !== "string" || !Array.isArray(expectedPaths) || expectedPaths.some((p) => typeof p !== "string")) return reply({ error: "图片清单参数不完整。" }, 400);
  try {
    const db = await getDb();
    const database = db.$client;
    if (!(await authorizeKnowledgeAssetRevision(database, actor, itemId, revisionId))) return reply({ error: "当前账号无权完成该知识版本的图片上传。" }, 403);
    const result = await finalizeKnowledgeAssets(database, { itemId, revisionId, uploadToken, expectedPaths: expectedPaths as string[] });
    return reply({ received: true, ...result });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "图片尚未完整上传。" }, 409);
  }
}
