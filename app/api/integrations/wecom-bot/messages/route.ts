import { getAuthorizedIntegrationMember } from '../../../_lib/auth';
import { botConfiguration, parseBotCommand, readSignedBotMessage } from '../../../../../lib/wecom-bot-contract.mjs';
import {
  claimBotMessage, claimBotPairing, getBotSenderLink, isBotLinkCurrent, listBotOwnWorkItems, unlinkBotActor, getBotActiveKnowledgeChunks, isBotKnowledgeCurrent,
  type BotActor, type BotLink,
} from '../../../../../lib/wecom-bot-store';
import { rankKnowledgeChunks } from '../../../../../lib/knowledge-policy';
import { answerOaChatQuestion } from '../../../../../lib/oa-chat-client';
import { OA_PROJECT } from '../../../../../lib/project-work-items';

const headers = { 'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const reply = (value: string) => json({ ok: true, reply: value });
const HELP = '我是 OA 助研。支持「/待办」查询自己的未完成工作项，也可以提问已审核 OA 资料。首次使用请在 OA 的「企微机器人」页面获取连接码，私聊发送「/绑定 连接码」，再返回 OA 确认。发送「/解绑」可解除连接。当前试用只提供查询和问答，不代替提交或审批。';

async function actorStillCurrent(link: BotLink, original: BotActor) {
  const current = await getAuthorizedIntegrationMember(link.member_id, link.account_user_id);
  return Boolean(current?.ndaCompleted && current.memberMutationRevision === original.memberMutationRevision
    && current.isAdmin === original.isAdmin && current.ndaApprovalId === original.ndaApprovalId
    && current.ndaAgreementVersion === original.ndaAgreementVersion && current.ndaAcceptedAt === original.ndaAcceptedAt
    && await isBotLinkCurrent(link, current));
}

export async function POST(request: Request) {
  try {
    const { env } = await import('cloudflare:workers');
    const environment = env as unknown as Record<string, unknown>;
    const configuration = botConfiguration(environment);
    if (!configuration) return json({ error: '机器人服务尚未启用。' }, 503);
    const parsed = await readSignedBotMessage(request, configuration);
    if (!parsed.ok) return json({ error: '机器人请求无效。' }, parsed.status);
    const message = parsed.message;
    // The bridge only forwards authenticated provider private messages. The
    // request schema deliberately accepts no client-controlled group/private
    // flag, member identity, role, capability, or model/tool instruction.
    if (!await claimBotMessage(message, environment)) return reply('');
    const command = parseBotCommand(message.text);
    if (command.kind === 'help') return reply(HELP);
    if (command.kind === 'invalid_binding') return reply('连接码格式不正确，请在 OA 重新获取连接码。');
    if (command.kind === 'bind') {
      const claimed = await claimBotPairing(message.botId, message.userId, command.code, environment);
      return reply(claimed ? '连接请求已收到。请返回 OA「企微机器人」页面核对账号并点击确认；确认前无法查询 OA 数据。' : '连接码已过期、已使用或账号已连接，请在 OA 重新获取连接码。');
    }
    const link = await getBotSenderLink(message.botId, message.userId);
    if (!link) return reply('请先在 OA「企微机器人」页面获取连接码，私聊发送「/绑定 连接码」，再返回 OA 确认。');
    const actor = await getAuthorizedIntegrationMember(link.member_id, link.account_user_id);
    if (!actor?.ndaCompleted || !await isBotLinkCurrent(link, actor)) return reply('');
    if (command.kind === 'unlink') {
      return reply(await unlinkBotActor(configuration.botId, actor, environment, link) ? '已解除 OA 账号连接。' : '');
    }
    if (command.kind === 'work_items') {
      const items = await listBotOwnWorkItems(link, actor, OA_PROJECT);
      if (!await actorStillCurrent(link, actor)) return reply('');
      if (!items.length) return reply('你目前没有负责或创建的未完成工作项。');
      return reply(`你的未完成工作项（最多显示 20 项）：\n\n${items.map((item, index) => `${index + 1}. ${item.title.replace(/[\r\n]/gu, ' ')}${item.due_at ? `（截止 ${item.due_at}）` : ''} · ${item.status === 'in_progress' ? '进行中' : '待开始'}`).join('\n')}`);
    }
    if (command.kind !== 'question' || !actor.memberId || !actor.accountUserId || !actor.memberMutationRevision) return reply('');
    const chunks = await getBotActiveKnowledgeChunks(link, actor, command.question);
    if (!await actorStillCurrent(link, actor)) return reply('');
    const ranked = rankKnowledgeChunks(command.question, chunks);
    if (!await isBotKnowledgeCurrent(link, actor, ranked)) return reply('');
    const answer = await answerOaChatQuestion(command.question, ranked);
    // No stale-link/disabled-member response may contain internal evidence.
    // This is deliberately checked after both asynchronous retrieval and model.
    if (!await actorStillCurrent(link, actor) || !await isBotKnowledgeCurrent(link, actor, ranked)) return reply('');
    return reply(answer.answer);
  } catch { return json({ error: '机器人服务暂不可用，请稍后重试。' }, 503); }
}
