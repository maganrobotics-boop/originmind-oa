import { PublicError } from './errors.mjs';
import { handleHonorsRequest } from './learning-honors.mjs';

const response = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
export async function readFutureStudents(db, learning, params) {
  if (!learning) throw new PublicError('课程进度服务暂不可用。', 503);
  const q = (params.q || '').trim(), page = params.page || '1', courseId = params.courseId || '', status = params.status || 'all';
  if (q.length > 100 || !/^[1-9]\d{0,4}$/u.test(page) || !['all', 'started', 'not_started'].includes(status)) throw new PublicError('学生筛选不正确。', 400);
  let emails;
  try { emails = learning.participants(courseId); } catch (e) { throw new PublicError(e.message, e.status || 400); }
  const cte = `WITH profiles AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY lower(email) ORDER BY updated_at DESC,email) AS rank FROM newbie_profiles), people AS (
    SELECT a.email,COALESCE(p.display_name,'') AS displayName,COALESCE(p.grade,'') AS grade,COALESCE(p.major,'') AS major,
      COALESCE(p.direction,'undecided') AS direction,a.registered_at AS registeredAt,a.last_login_at AS lastLoginAt,
      COALESCE((SELECT signer_name FROM newbie_agreement_acceptances g WHERE lower(g.email)=a.email ORDER BY accepted_at DESC,agreement_version DESC LIMIT 1),'') AS signerName,
      COALESCE((SELECT review_status FROM newbie_agreement_acceptances g WHERE lower(g.email)=a.email ORDER BY accepted_at DESC,agreement_version DESC LIMIT 1),'not_signed') AS agreementStatus,
      (SELECT COUNT(*) FROM newbie_task_progress t WHERE lower(t.email)=a.email AND status='completed') AS completed,
      (SELECT COUNT(*) FROM newbie_task_progress t WHERE lower(t.email)=a.email AND status<>'not_started') AS started,
      MAX(COALESCE(a.last_login_at,0),COALESCE(p.updated_at,0),a.registered_at) AS lastActivityAt
    FROM visitor_accounts a LEFT JOIN profiles p ON lower(p.email)=a.email AND p.rank=1 WHERE a.role='student')`;
  const condition = "(instr(lower(email),lower(?))>0 OR instr(displayName,?)>0 OR instr(signerName,?)>0) AND (? IS NULL OR email IN (SELECT value FROM json_each(?)))" +
    (status === 'started' ? ' AND started>0' : status === 'not_started' ? ' AND started=0' : '');
  const filter = emails === null ? null : JSON.stringify(emails), args = [q, q, q, filter, filter];
  const count = await db.prepare(`${cte} SELECT COUNT(*) AS n FROM people WHERE ${condition}`).bind(...args).first();
  const records = await db.prepare(`${cte} SELECT * FROM people WHERE ${condition} ORDER BY lastActivityAt DESC,email LIMIT 20 OFFSET ?`).bind(...args, (Number(page) - 1) * 20).all();
  const rows = learning.enrich(records.results || []);
  return { records: rows, courses: learning.catalogue, courseId, pagination: { page: Number(page), total: count.n, totalPages: Math.ceil(count.n / 20) },
    progressNote: '课程参与按已保存的草稿和提交筛选；仅在本机学习的记录不会显示。提交进度、AI 点评与教师验收分别展示。' };
}
export async function handleFutureStarsOperation(context, payload, helpers) {
  const params = payload.params || {}, operation = payload.operation;
  if (operation === 'people') return response(await readFutureStudents(context.env.DB, context.env.FUTURE_STARS_LEARNING, params));
  if (operation === 'records') {
    if (!context.env.FUTURE_STARS_LEARNING) throw new PublicError('课程记录暂不可用。', 503);
    try { return response(context.env.FUTURE_STARS_LEARNING.records(params)); } catch (e) { throw new PublicError(e.message, e.status || 400); }
  }
  let route = '/api/admin/honors';
  const query = new URLSearchParams(params);
  if (operation === 'recipients') route += '/recipients';
  if (['events', 'honor_action'].includes(operation)) {
    if (!/^[a-z0-9-]{10,64}$/u.test(params.id || '')) throw new PublicError('荣誉编号不正确。', 400);
    route += '/' + params.id + (operation === 'events' ? '/events' : '/action'); query.delete('id');
  }
  const writing = ['grant', 'honor_action'].includes(operation);
  const request = new Request(new URL(route + (query.size ? '?' + query : ''), context.env.APP_ORIGIN), {
    method: writing ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', origin: context.env.APP_ORIGIN },
    ...(writing ? { body: JSON.stringify(payload.body) } : {}),
  });
  return handleHonorsRequest({ ...context, request }, { ...helpers,
    requireOwner: async () => ({ email: payload.actor.email.toLowerCase() }),
    limit: async (ctx, scope, cap, seconds) => helpers.limit(ctx, `${scope}:oa:${payload.actor.subject}`, cap, seconds),
  });
}
