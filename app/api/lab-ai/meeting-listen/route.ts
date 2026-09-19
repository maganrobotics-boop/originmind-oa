import { getAuthorizedUser } from '../../_lib/auth';
import { getD1Database } from '../../../../db';
import { getFeishuOAuthConfig } from '../../../../lib/feishu-oauth';
import { taskActorGuard } from '../../../../lib/ai-workbench-store';
import { handleMeetingRequest, validTokenKey } from '../../../../lib/feishu-meeting-listen.mjs';

const reply = (error: string, status: number) => Response.json({ error, configured: false }, { status, headers: { 'cache-control': 'private, no-store, max-age=0' } });
async function handle(request: Request) {
  try {
    const user = await getAuthorizedUser();
    if (!user) return reply('请先登录 OA。', 401);
    if (!user.ndaCompleted || !user.memberId || !user.accountUserId || !user.memberMutationRevision) return reply('请先完成实名准入和保密协议。', 403);
    // Read the current member/NDA state, not merely a previously cached login result.
    const db = await getD1Database();
    const actor = [user.memberId, user.accountUserId, user.memberMutationRevision];
    if (!await db.prepare(`SELECT 1 AS allowed WHERE ${taskActorGuard}`).bind(...actor).first()) return reply('成员准入或保密协议状态已变化，旁听已暂停。', 403);
    const { env } = await import('cloudflare:workers');
    const settings = env as unknown as { OA_MEETING_LISTEN_ENABLED?: string; OA_MEETING_TOKEN_KEY?: string };
    if (settings.OA_MEETING_LISTEN_ENABLED !== 'true' || !validTokenKey(settings.OA_MEETING_TOKEN_KEY)) return reply('飞书旁听尚未启用。管理员需先配置回调地址与独立加密密钥；仍需飞书灰度资格和用户授权。', 503);
    return await handleMeetingRequest(request, { actor, config: getFeishuOAuthConfig(), key: settings.OA_MEETING_TOKEN_KEY! });
  } catch { return reply('旁听服务配置或准入检查暂不可用；未开始采集。', 503); }
}
export const GET = handle;
export const POST = handle;
