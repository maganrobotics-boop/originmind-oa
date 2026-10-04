import { getAuthorizedUser } from '../../_lib/auth';
import { getDb } from '../../../../db';
import { consumeWriteRateLimit } from '../../../../lib/write-rate-limit';
import { callFutureStars, FutureStarsError } from '../../../../lib/future-stars-client';
import { boundedStarsJson, validStarsPayload } from '../../../../chat-cloudflare/src/future-stars-bridge.mjs';

const json = (data: object, status = 200) => Response.json(data, { status, headers: {
  'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff', vary: 'Cookie',
}});
async function authorized(readOnly: boolean) {
  const user = await getAuthorizedUser({ readOnly });
  if (!user) throw new FutureStarsError('请先登录 OA。', 401);
  if (!user.isAdmin || !user.ndaCompleted || !user.memberId || !user.accountUserId || !user.memberMutationRevision) throw new FutureStarsError('仅已完成准入的 OA 管理员可管理未来之星。', 403);
  return user;
}
function failure(error: unknown) {
  if (error instanceof FutureStarsError) return json({ error: error.message }, error.status);
  if (error && typeof error === 'object' && 'status' in error && 'message' in error && typeof error.status === 'number' && typeof error.message === 'string') return json({ error: error.message }, error.status);
  return json({ error: '未来之星服务暂不可用，请稍后重试。' }, 503);
}
export async function GET(request: Request) {
  try {
    const user = await authorized(true), url = new URL(request.url), view = url.searchParams.get('view') || 'students';
    const operation = ({ students: 'people', records: 'records', awards: 'honors', honors: 'honors', recipients: 'recipients', events: 'events' } as Record<string, string>)[view];
    if (!operation) throw new FutureStarsError('查看内容不正确。', 400);
    const params: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (url.searchParams.getAll(key).length !== 1) throw new FutureStarsError('筛选参数不正确。', 400);
      if (key !== 'view') params[key] = value;
    }
    if (view === 'awards') params.category = 'competition';
    const payload = { operation, params, actor: { email: user.user.email, subject: user.accountUserId! } };
    if (!validStarsPayload(payload)) throw new FutureStarsError('筛选参数不正确。', 400);
    return json(await callFutureStars(payload));
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const site = request.headers.get('sec-fetch-site');
    if (request.headers.get('origin') !== new URL(request.url).origin || (site && site !== 'same-origin')) throw new FutureStarsError('请从 OA 未来之星页面操作。', 403);
    const user = await authorized(false);
    if (!await consumeWriteRateLimit(await getDb(), { actorSubject: user.accountUserId!, scope: 'future_stars', limit: 60 })) throw new FutureStarsError('操作较多，请稍后再试。', 429);
    let input: Record<string, unknown>;
    try { input = JSON.parse(await boundedStarsJson(request)); } catch (error) {
      if (error instanceof SyntaxError) throw new FutureStarsError('请求格式不正确。', 400); throw error;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['action', 'id', 'body'].includes(k))) throw new FutureStarsError('管理内容不正确。', 400);
    const payload = { operation: input.action, params: input.id === undefined ? {} : { id: input.id }, body: input.body,
      actor: { email: user.user.email, subject: user.accountUserId! } };
    if (!['grant', 'honor_action'].includes(String(input.action)) || !validStarsPayload(payload)) throw new FutureStarsError('管理内容不正确。', 400);
    return json(await callFutureStars(payload));
  } catch (error) { return failure(error); }
}
