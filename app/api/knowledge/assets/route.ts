import { getDb } from "../../../../db";
import { authorizeKnowledgeAssetRevision } from "../../../../lib/knowledge-asset-authorization";
import { stageKnowledgeAsset } from "../../../../lib/knowledge-asset-upload";
import { getKnowledgeAssetsBucket } from "../../../../lib/knowledge-assets-env";
import type { KnowledgeActor } from "../../../../lib/knowledge-store";
import { getAuthorizedUser } from "../../_lib/auth";

const CHAT_ORIGIN = "https://chat.omindos.ai";
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

function headers() { return { "access-control-allow-origin": CHAT_ORIGIN, "access-control-allow-credentials": "true", "access-control-allow-methods": "PUT, OPTIONS", "access-control-allow-headers": "content-type,x-knowledge-item-id,x-knowledge-revision-id,x-knowledge-upload-token,x-knowledge-asset-path", "cache-control": "private, no-store", vary: "Origin, Cookie" }; }
function reply(data: unknown, status = 200) { return Response.json(data, { status, headers: headers() }); }
export async function OPTIONS(request: Request) { return request.headers.get("origin") === CHAT_ORIGIN ? new Response(null, { status: 204, headers: headers() }) : new Response(null, { status: 403 }); }

export async function PUT(request: Request) {
  if (request.headers.get("origin") !== CHAT_ORIGIN) return reply({ error: "请从 Chat 管理页面上传。" }, 403);
  const authorized = await getAuthorizedUser();
  if (!authorized?.memberId || !authorized.accountUserId || !authorized.memberMutationRevision || !authorized.ndaCompleted) return reply({ error: "请先完成 OA 登录、实名绑定及保密协议。" }, 401);
  const actor: KnowledgeActor = { memberId: authorized.memberId, accountUserId: authorized.accountUserId, memberMutationRevision: authorized.memberMutationRevision, name: authorized.user.displayName, email: authorized.user.email, isAdmin: authorized.isAdmin };
  const itemId = request.headers.get("x-knowledge-item-id") || "";
  const revisionId = request.headers.get("x-knowledge-revision-id") || "";
  const uploadToken = request.headers.get("x-knowledge-upload-token") || "";
  const path = request.headers.get("x-knowledge-asset-path") || "";
  const mimeType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() || "";
  if (!itemId || !revisionId || !uploadToken || !path) return reply({ error: "图片上传参数不完整。" }, 400);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_ASSET_BYTES) return reply({ error: "单张图片不能超过 8 MB。" }, 413);
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_ASSET_BYTES) return reply({ error: "单张图片不能超过 8 MB。" }, 413);
  try {
    const db = await getDb();
    const database = db.$client;
    if (!(await authorizeKnowledgeAssetRevision(database, actor, itemId, revisionId))) return reply({ error: "当前账号无权向该知识版本上传图片。" }, 403);
    const stored = await stageKnowledgeAsset(database, await getKnowledgeAssetsBucket(), { itemId, revisionId, uploadToken, path, mimeType, body });
    return reply({ received: true, asset: stored }, 201);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "图片上传失败。" }, 400);
  }
}
