import { getAuthorizedUser } from "../../_lib/auth";

export async function GET(request: Request) {
  const user = await getAuthorizedUser();
  if (!user?.isAdmin || !user.ndaCompleted) return Response.json({ error: "仅已完成入职签署的 OA 管理员可查看官网申请。" }, { status: 403 });
  const { env } = await import("cloudflare:workers");
  if (!env.WEBSITE_DB) return Response.json({ error: "官网申请暂不可用。" }, { status: 503 });
  const cursor = new URL(request.url).searchParams.get("cursor") || "";
  if (cursor && !/^\d{13}:OEM-[0-9a-f-]{36}$/i.test(cursor)) return Response.json({ error: "分页参数无效。" }, { status: 400 });
  const [beforeTime, beforeId] = cursor.split(":");
  try {
    const query = cursor
      ? env.WEBSITE_DB.prepare("SELECT id, language, payload_json, created_at FROM oem_applications WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT 26").bind(Number(beforeTime), Number(beforeTime), beforeId)
      : env.WEBSITE_DB.prepare("SELECT id, language, payload_json, created_at FROM oem_applications ORDER BY created_at DESC, id DESC LIMIT 26");
    const { results } = await query.all<{ id: string; language: string; payload_json: string; created_at: number }>();
    const rows = results.slice(0, 25);
    const last = rows.at(-1);
    return Response.json({ applications: rows.map((row) => ({ id: row.id, language: row.language, createdAt: row.created_at, fields: JSON.parse(row.payload_json) })), nextCursor: results.length > 25 && last ? `${last.created_at}:${last.id}` : null });
  } catch { return Response.json({ error: "官网申请读取失败，请稍后重试。" }, { status: 503 }); }
}
