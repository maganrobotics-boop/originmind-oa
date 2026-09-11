import { getD1Database } from "../../../../db";
import { isMigrationUnfreezeEnabled, migrationWriteFreezeId } from "../../../../lib/migration-freeze";
import { getAuthorizedUser } from "../../_lib/auth";

const HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "content-type": "application/json; charset=utf-8",
  "cross-origin-resource-policy": "same-origin",
  pragma: "no-cache",
  vary: "Cookie, Origin",
  "x-content-type-options": "nosniff",
};

function json(message: object, status: number) {
  return Response.json(message, { status, headers: HEADERS });
}

function sameOrigin(request: Request) {
  const requestOrigin = new URL(request.url).origin;
  return request.headers.get("origin") === requestOrigin
    && (!request.headers.get("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin");
}

export async function POST(request: Request) {
  if (!isMigrationUnfreezeEnabled(process.env)) return json({ error: "未找到。" }, 404);
  if (!sameOrigin(request)) return json({ error: "迁移恢复请求来源无效。" }, 403);
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > 1_024) return json({ error: "迁移恢复请求无效。" }, 413);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return json({ error: "迁移恢复确认格式无效。" }, 415);
  const serializedBody = await request.text();
  if (new TextEncoder().encode(serializedBody).byteLength > 1_024) return json({ error: "迁移恢复请求无效。" }, 413);
  const form = new URLSearchParams(serializedBody);
  if (form.size !== 1 || form.get("confirmation") !== "discard-current-migration-package") return json({ error: "必须确认废弃当前迁移包后才能解除冻结。" }, 400);
  const authorized = await getAuthorizedUser();
  if (!authorized?.isAdmin || !authorized.memberId || !authorized.accountUserId || !authorized.ndaCompleted) return json({ error: "只有已完成保密准入的 OA 管理员可以恢复写入。" }, 403);
  try {
    const freezeId = migrationWriteFreezeId(process.env);
    const database = await getD1Database();
    const results = await database.batch([
      database.prepare("UPDATE migration_control SET deactivated_at = CURRENT_TIMESTAMP WHERE freeze_id = ? AND deactivated_at IS NULL RETURNING freeze_id").bind(freezeId),
      database.prepare("SELECT COUNT(*) AS active_count FROM migration_control WHERE deactivated_at IS NULL"),
    ]);
    const deactivated = results[0]?.results?.[0] as Record<string, unknown> | undefined;
    const active = results[1]?.results?.[0] as Record<string, unknown> | undefined;
    if (deactivated?.freeze_id !== freezeId || active?.active_count !== 0) return json({ error: "当前迁移冻结代次不匹配，未恢复写入。" }, 409);
    return json({ ok: true, message: "数据库迁移栅栏已解除；此前下载的迁移包已经过期并必须销毁，且仍需发布 OA_MIGRATION_WRITE_FROZEN=false 后才恢复网页写入。" }, 200);
  } catch {
    return json({ error: "迁移写入恢复失败；网页入口仍保持冻结。" }, 500);
  }
}
