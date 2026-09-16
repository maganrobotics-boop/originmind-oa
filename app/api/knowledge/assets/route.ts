import { getDb } from "../../../../db";
import { stageKnowledgeAsset } from "../../../../lib/knowledge-asset-upload";
import { getAuthorizedUser } from "../../_lib/auth";

const CHAT_ORIGIN = "https://chat.omindos.ai";
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

function headers() { return { "access-control-allow-origin": CHAT_ORIGIN, "access-control-allow-credentials": "true", "access-control-allow-methods": "PUT, OPTIONS", "access-control-allow-headers": "content-type,x-knowledge-item-id,x-knowledge-revision-id,x-knowledge-upload-token,x-knowledge-asset-path", "cache-control": "private, no-store", vary: "Origin, Cookie" }; }
function reply(data: unknown, status = 200) { return Response.json(data, { status, headers: headers() }); }
export async function OPTIONS(request: Request) { return request.headers.get("origin") === CHAT_ORIGIN ? new Response(null, { status: 204, headers: headers() }) : new Response(null, { status: 403 }); }

export async function PUT(request: Request) {
  if (request.headers.get("origin") !== CHAT_ORIGIN) return reply({ error: "请从 Chat 管理页面上传。" }, 403);
  const authorized = await getAuthorizedUser();
  if (!authorized?.memberId || !authorized.accountUserId) return reply({ error: "请先登录 OA。" }, 401);
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
    const bucket = (globalThis as unknown as { KNOWLEDGE_ASSETS?: R2Bucket }).KNOWLEDGE_ASSETS;
    if (!bucket) return reply({ error: "知识图片存储尚未配置。" }, 503);
    const stored = await stageKnowledgeAsset(db, bucket, { itemId, revisionId, uploadToken, path, mimeType, body });
    return reply({ received: true, asset: stored }, 201);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "图片上传失败。" }, 400);
  }
}
