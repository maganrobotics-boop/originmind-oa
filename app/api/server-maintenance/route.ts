import { and, eq } from 'drizzle-orm';
import { getDb } from '../../../db';
import { members } from '../../../db/schema';
import { readBoundedJsonObject } from '../../../lib/bounded-json-request';
import { answerServerMaintenanceQuestion } from '../../../lib/server-maintenance-ask.mjs';
import { consumeWriteRateLimit } from '../../../lib/write-rate-limit';
import { getAuthorizedUser } from '../_lib/auth';

function privateJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: {
    'cache-control': 'private, no-store, max-age=0',
    'x-content-type-options': 'nosniff',
  } });
}

export async function POST(request: Request) {
  const actor = await getAuthorizedUser({ readOnly: true });
  if (!actor) return privateJson({ error: '请先登录 OA 管理员账号。' }, 401);
  if (actor.isAdmin !== true || !actor.memberId || !actor.accountUserId || !actor.memberMutationRevision)
    return privateJson({ error: '服务器助手仅向已激活并绑定身份的 OA 管理员开放。' }, 403);
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site')
    return privateJson({ error: '请在 OA 服务器助手中操作。' }, 403);
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json')
    return privateJson({ error: '请使用 JSON 格式提交。' }, 415);
  const parsed = await readBoundedJsonObject(request, 25_000);
  if (!parsed.ok) return privateJson({ error: parsed.reason === 'too_large' ? '问题数据过大。' : '问题格式不正确。' }, parsed.reason === 'too_large' ? 413 : 400);
  if (Object.keys(parsed.value).some(key => key !== 'question') || typeof parsed.value.question !== 'string' || !parsed.value.question.isWellFormed())
    return privateJson({ error: '请求仅接受当前问题。' }, 400);
  const question = parsed.value.question.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (question.length < 2 || question.length > 2000) return privateJson({ error: '请输入 2–2000 个字符的问题。' }, 400);
  try {
    const db = await getDb();
    // Configured administrators can bootstrap OA; this endpoint additionally
    // requires the current active member binding and its exact revision.
    const [member] = await db.select({ id: members.id }).from(members).where(and(
      eq(members.id, actor.memberId), eq(members.status, 'active'),
      eq(members.accountUserId, actor.accountUserId), eq(members.mutationRevision, actor.memberMutationRevision),
    )).limit(1);
    if (!member) return privateJson({ error: '管理员成员状态或身份绑定已变化，请重新登录。' }, 403);
    if (!(await consumeWriteRateLimit(db, { actorSubject: actor.accountUserId, scope: 'server_maintenance', limit: 10 })))
      return privateJson({ error: '操作过于频繁，请一分钟后重试。' }, 429);
    const result = await answerServerMaintenanceQuestion(request, question);
    if (!result) return privateJson({ error: '此通道只处理阿里云和腾讯云的状态查询与限定临时文件清理。' }, 400);
    return privateJson({ ...result, citations: [], images: [] });
  } catch {
    return privateJson({ error: '服务器助手暂时无法取得操作回执，请稍后重试。' }, 503);
  }
}
