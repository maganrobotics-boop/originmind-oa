import { getAuthorizedUser, getAuthorizedIntegrationMember } from '../../../_lib/auth';
import { readBoundedJsonObject } from '../../../../../lib/bounded-json-request';
import { botConfiguration, strictBotBrowserOrigin, parseBotLinkAction } from '../../../../../lib/wecom-bot-contract.mjs';
import { getBotLinkState, changeBotLink } from '../../../../../lib/wecom-bot-store';

const headers = { 'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });

async function browserActor() {
  const browser = await getAuthorizedUser({ noTouch: true });
  if (!browser?.memberId || !browser.accountUserId || (!browser.ndaCompleted && !browser.isAdmin)) return null;
  // Even the configured administrator must still have this active member and
  // exact account identity; the bot never uses OA's administrator bootstrap.
  const actor = await getAuthorizedIntegrationMember(browser.memberId, browser.accountUserId);
  return actor?.ndaCompleted && actor.memberMutationRevision === browser.memberMutationRevision ? actor : null;
}

export async function GET() {
  try {
    const actor = await browserActor();
    if (!actor) return json({ error: '请先登录 OA 并完成成员准入。' }, 403);
    const { env } = await import('cloudflare:workers');
    const configuration = botConfiguration(env as unknown as Record<string, unknown>);
    if (!configuration) return json({ enabled: false, memberName: actor.user.displayName, linked: null, pairing: null });
    const state = await getBotLinkState(configuration.botId, actor);
    return json({ enabled: true, memberName: actor.user.displayName, ...state });
  } catch { return json({ error: '企微机器人连接暂不可用，请稍后重试。' }, 503); }
}

export async function POST(request: Request) {
  try {
    const { env } = await import('cloudflare:workers');
    const environment = env as unknown as Record<string, unknown>;
    const configuration = botConfiguration(environment);
    if (!configuration) return json({ error: '企微机器人尚未启用。' }, 503);
    if (!strictBotBrowserOrigin(request, environment)) return json({ error: '请在 OA 页面内操作。' }, 403);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: '请使用 JSON 提交。' }, 415);
    const parsed = await readBoundedJsonObject(request, 2048);
    if (!parsed.ok) return json({ error: '连接操作格式错误。' }, parsed.reason === 'too_large' ? 413 : 400);
    const action = parseBotLinkAction(parsed.value);
    if (!action) return json({ error: '连接操作格式错误。' }, 400);
    const actor = await browserActor();
    if (!actor) return json({ error: '请先登录 OA 并完成成员准入。' }, 403);
    return json(await changeBotLink(configuration.botId, actor, action, environment));
  } catch (error) {
    if (error instanceof Error && error.message === 'WECOM_BOT_LINK_CONFLICT') return json({ error: '连接已过期、已使用或账号状态已变更，请重新获取连接码。' }, 409);
    return json({ error: '企微机器人连接暂不可用，请稍后重试。' }, 503);
  }
}
