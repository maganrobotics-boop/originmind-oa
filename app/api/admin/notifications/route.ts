import { getAuthorizedUser } from "../../_lib/auth";

export async function GET() {
  const actor = await getAuthorizedUser();
  if (!actor?.isAdmin || !actor.ndaCompleted) return Response.json({ error: "仅管理员可查看提醒状态。" }, { status: 403 });
  const { env } = await import("cloudflare:workers");
  try {
    const counts = await env.DB.prepare("SELECT status, COUNT(*) AS count FROM notification_outbox GROUP BY status").all();
    const failures = await env.DB.prepare("SELECT id, kind, status, failure_code, created_at FROM notification_outbox WHERE status IN ('pending', 'failed', 'needs_review') AND failure_code IS NOT NULL ORDER BY created_at DESC LIMIT 10").all();
    const latestTest = await env.DB.prepare("SELECT status, failure_code, sent_at FROM notification_outbox WHERE kind = 'test' AND target_member_id = ? ORDER BY created_at DESC LIMIT 1").bind(actor.memberId).first();
    return Response.json({ enabled: env.FEISHU_NOTIFICATIONS_ENABLED === "true", counts: counts.results, failures: failures.results, latestTest });
  } catch { return Response.json({ error: "提醒状态暂不可用。" }, { status: 503 }); }
}

export async function POST(request: Request) {
  if (request.headers.get("Origin") !== new URL(request.url).origin) return Response.json({ error: "请求来源无效。" }, { status: 403 });
  const actor = await getAuthorizedUser();
  if (!actor?.isAdmin || !actor.ndaCompleted || !actor.memberId || !actor.accountUserId) return Response.json({ error: "仅管理员可测试本人飞书提醒。" }, { status: 403 });
  const { env } = await import("cloudflare:workers");
  if (env.FEISHU_NOTIFICATIONS_ENABLED !== "true") return Response.json({ error: "飞书提醒尚未启用。" }, { status: 503 });
  const now = Date.now();
  const key = `self-test:${actor.memberId}:${Math.floor(now / 300000)}`;
  try {
    await env.DB.prepare(`INSERT OR IGNORE INTO notification_outbox (id, dedupe_key, target_member_id, target_account_user_id, kind, step, cycle_id, next_attempt_at, created_at)
      SELECT ?, ?, id, account_user_id, 'test', '', 0, ?, ? FROM members WHERE id = ? AND account_user_id = ? AND status = 'active'`).bind(crypto.randomUUID(), key, now, now, actor.memberId, actor.accountUserId).run();
    return Response.json({ queued: true, message: "已加入发送队列，只发送给您本人。五分钟内重复测试合并为一条。" }, { status: 202 });
  } catch { return Response.json({ error: "测试提醒暂不可用。" }, { status: 503 }); }
}
