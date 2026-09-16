import { getDb } from "../../../../../db";
import { readBoundedJsonObject } from "../../../../../lib/bounded-json-request";
import { finalizeKnowledgeAssets } from "../../../../../lib/knowledge-asset-upload";
import { getAuthorizedUser } from "../../../_lib/auth";

const CHAT_ORIGIN = "https://chat.omindos.ai";
function headers() { return { "access-control-allow-origin": CHAT_ORIGIN, "access-control-allow-credentials": "true", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "cache-control": "private, no-store", vary: "Origin, Cookie" }; }
function reply(data: unknown, status = 200) { return Response.json(data, { status, headers: headers() }); }
export async function OPTIONS(request: Request) { return request.headers.get("origin") === CHAT_ORIGIN ? new Response(null, { status: 204, headers: headers() }) : new Response(null, { status: 403 }); }

export async function POST(request: Request) {
  if (request.headers.get("origin") !== CHAT_ORIGIN) return reply({ error: "请从 Chat 管理页面提交。" }, 403);
  const authorized = await getAuthorizedUser();
  if (!authorized?.memberId || !authorized.accountUserId) return reply({ error: "请先登录 OA。" }, 401);
  const parsed = await readBoundedJsonObject(request, 64 * 1024);
  if (!parsed.ok) return reply({ error: "图片清单格式不正确。" }, 400);
  const { itemId, revisionId, uploadToken, expectedPaths } = parsed.value as Record<string, unknown>;
  if (typeof itemId !== "string" || typeof revisionId !== "string" || typeof uploadToken !== "string" || !Array.isArray(expectedPaths) || expectedPaths.some((p) => typeof p !== "string")) return reply({ error: "图片清单参数不完整。" }, 400);
  try {
    const result = await finalizeKnowledgeAssets(await getDb(), { itemId, revisionId, uploadToken, expectedPaths: expectedPaths as string[] });
    return reply({ received: true, ...result });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "图片尚未完整上传。" }, 409);
  }
}
