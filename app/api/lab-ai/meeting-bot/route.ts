import { getAuthorizedUser } from '../../_lib/auth';
import { getD1Database } from '../../../../db';
import { shouldBlockForMigrationFreeze } from '../../../../lib/migration-freeze';
import { taskActorGuard } from '../../../../lib/ai-workbench-store';
import { createMeetingBotStore, handleMeetingBotRequest, resolveMeetingBotConfig } from '../../../../lib/feishu-meeting-bot.mjs';

const reply = (error: string, status: number) => Response.json({ error, configured: false }, { status, headers: { 'cache-control': 'private, no-store, max-age=0' } });
async function handle(request: Request) {
  try {
    const user = await getAuthorizedUser();
    if (!user) return reply('请先登录 OA。', 401);
    if (!user.isAdmin || !user.ndaCompleted || !user.memberId || !user.accountUserId || !user.memberMutationRevision) return reply('独立入会目前仅向已完成实名准入和保密协议的 OA 管理员开放。', 403);
    const db = await getD1Database();
    const actor = { isAdmin: user.isAdmin, memberId: user.memberId, accountId: user.accountUserId, revision: user.memberMutationRevision };
    const store = createMeetingBotStore(db, taskActorGuard);
    if (!await db.prepare(`SELECT 1 AS allowed WHERE ${taskActorGuard}`).bind(actor.memberId, actor.accountId, actor.revision).first()) return reply('成员准入或保密协议状态已变化，未发起入会操作。', 403);
    const { env } = await import('cloudflare:workers');
    const settings = { ...process.env, ...(env as unknown as Record<string, unknown>) };
    if (shouldBlockForMigrationFreeze(request, settings)) return reply('迁移冻结期间不可写入入会控制记录；需要退出时请主持人在飞书中移出助手。', 423);
    return await handleMeetingBotRequest(request, { actor, store, config: resolveMeetingBotConfig(settings) });
  } catch { return reply('独立入会服务暂不可用；未确认操作成功，请检查配置及飞书参会人列表。', 503); }
}
export const GET = handle;
export const POST = handle;
