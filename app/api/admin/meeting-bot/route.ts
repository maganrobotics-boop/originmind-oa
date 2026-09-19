import { getDb, getD1Database } from '../../../../db';
import { getAuthorizedUser } from '../../_lib/auth';
import { hasMeetingAdminMembership, type MeetingAdmin } from '../../../../lib/admin-meeting-minutes';
import { handleBotRequest, type BotEnv } from '../../../../lib/feishu-meeting-bot.mjs';
import { consumeWriteRateLimit } from '../../../../lib/write-rate-limit';

const reply = (error: string, status: number) => Response.json({ error, outcomeUnknown: false }, { status, headers: { 'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff', vary: 'Cookie' } });
async function handle(request: Request) {
  try {
    const user = await getAuthorizedUser({ readOnly: request.method === 'GET' });
    if (!user) return reply('请先登录 OA。', 401);
    if (!user.isAdmin || !user.ndaCompleted || !user.memberId || !user.accountUserId || !user.memberMutationRevision) return reply('仅已完成准入的 OA 管理员可以操作会议机器人。', 403);
    const actor: MeetingAdmin = { isAdmin: true, memberId: user.memberId, accountUserId: user.accountUserId, memberMutationRevision: user.memberMutationRevision };
    const db = await getD1Database();
    const { env } = await import('cloudflare:workers');
    return await handleBotRequest(request, {
      env: env as unknown as BotEnv,
      actorKey: `${user.memberId}:${user.memberMutationRevision}`,
      checkAdmission: () => hasMeetingAdminMembership(db, actor),
      claimWrite: async action => consumeWriteRateLimit(await getDb(), { actorSubject: user.accountUserId!, scope: action === 'leave' ? 'meeting_bot_leave' : 'meeting_bot_control', limit: action === 'leave' ? 10 : 6 }),
    });
  } catch { return reply('会议机器人配置或管理员准入检查暂不可用。', 503); }
}
export const GET = handle;
export const POST = handle;
