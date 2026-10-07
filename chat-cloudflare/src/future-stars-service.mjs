import { ACTIVITY_WINDOWS, inActivityWindow, unavailableArena } from './activity-windows.mjs';
import { PublicError } from './errors.mjs';
import { handleHonorsRequest } from './learning-honors.mjs';

const response = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
export async function readFutureStudents(db, learning, params, now = Date.now()) {
  if (!learning) throw new PublicError('课程进度服务暂不可用。', 503);
  const q = (params.q || '').trim().toLowerCase(), page = params.page || '1', courseId = params.courseId || '', status = params.status || 'all';
  const window = params.window || '24h', sort = params.sort || 'progress';
  const durations = ACTIVITY_WINDOWS;
  if (q.length > 100 || !/^[1-9]\d{0,4}$/u.test(page) || !['all', 'started', 'not_started'].includes(status) || !Object.hasOwn(durations, window) || !['fastest', 'progress', 'recent'].includes(sort)) throw new PublicError('学生筛选不正确。', 400);
  let participants;
  try { participants = learning.participants(courseId); } catch (e) { throw new PublicError(e.message, e.status || 400); }
  // Legacy/new deployments differ: questions are optional, never create tables during admin reads.
  const questionTable = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='newbie_questions'").first();
  const questionActivity = questionTable ? 'COALESCE((SELECT MAX(created_at) FROM newbie_questions t WHERE lower(t.email)=a.email AND created_at<=?),0)' : '0';
  const records = await db.prepare(`WITH accounts AS (SELECT lower(email) email, MIN(registered_at) registered_at, MAX(CASE WHEN last_login_at<=? THEN last_login_at ELSE 0 END) last_login_at FROM visitor_accounts WHERE role='student' GROUP BY lower(email)), profiles AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY lower(email) ORDER BY updated_at DESC,email) AS rank FROM newbie_profiles)
    SELECT a.email,COALESCE(p.display_name,'') AS displayName,COALESCE(p.grade,'') AS grade,COALESCE(p.major,'') AS major,
      COALESCE(p.direction,'undecided') AS direction,a.registered_at AS registeredAt,a.last_login_at AS lastLoginAt,
      COALESCE((SELECT signer_name FROM newbie_agreement_acceptances g WHERE lower(g.email)=a.email ORDER BY accepted_at DESC,agreement_version DESC LIMIT 1),'') AS signerName,
      COALESCE((SELECT review_status FROM newbie_agreement_acceptances g WHERE lower(g.email)=a.email ORDER BY accepted_at DESC,agreement_version DESC LIMIT 1),'not_signed') AS agreementStatus,
      (SELECT COUNT(*) FROM newbie_task_progress t WHERE lower(t.email)=a.email AND status='completed') AS completed,
      MAX(COALESCE(a.last_login_at,0),COALESCE((SELECT MAX(updated_at) FROM newbie_task_progress t WHERE lower(t.email)=a.email AND updated_at<=?),0),
        ${questionActivity}) AS lastActivityAt
    FROM accounts a LEFT JOIN profiles p ON lower(p.email)=a.email AND p.rank=1`).bind(now, now, ...(questionTable ? [now] : [])).all();
  if (records.success === false || !Array.isArray(records.results)) throw new PublicError('课程活跃数据暂不可用。', 503);
  const since = now - durations[window];
  const all = learning.enrich(records.results || [], { since, now });
  const active = row => inActivityWindow(row.lastActivityAt, since, now);
  const onlineCounts = Object.fromEntries(Object.entries(durations).map(([key, ms]) => [key, all.filter(row => inActivityWindow(row.lastActivityAt, now - ms, now)).length]));
  const activeRows = all.filter(active);
  const participantSet = participants === null ? null : new Set(participants);
  const rows = activeRows.filter(row => (!q || [row.email, row.displayName, row.signerName].some(value => value.toLowerCase().includes(q))) &&
    (!participantSet || participantSet.has(row.email.toLowerCase())) &&
    (status === 'all' || (status === 'started' ? row.overall.started > 0 : row.overall.started === 0)));
  rows.sort((a, b) => (sort === 'recent' ? b.lastActivityAt - a.lastActivityAt : sort === 'progress' ? b.overall.submitted - a.overall.submitted : b.recentSubmitted - a.recentSubmitted) ||
    b.lastActivityAt - a.lastActivityAt || a.email.localeCompare(b.email));
  const total = rows.length, offset = (Number(page) - 1) * 20;
  return { records: rows.slice(offset, offset + 20), courses: learning.catalogue, courseId, window, sort, asOf: now,
    summary: { onlineCounts, active: activeRows.length, progressed: activeRows.filter(row => row.recentSubmitted > 0).length,
      newSubmissions: activeRows.reduce((sum, row) => sum + row.recentSubmitted, 0) },
    pagination: { page: Number(page), total, totalPages: Math.ceil(total / 20) },
    progressNote: '上线人数按已登录学员去重，按登录与已保存的学习活动统计；不含游客。默认按全课程累计已提交节数、最近活动时间排序；可切换本期新增进展排序。重复提交、免修和解锁不计入新增进展。提交不等于教师验收。历史未记录的访问无法补计。' };
}
export async function handleFutureStarsOperation(context, payload, helpers) {
  const params = payload.params || {}, operation = payload.operation;
  if (operation === 'arena') {
    if (!context.env.FUTURE_STARS_ARENA?.overview) return response(unavailableArena(params));
    try { return response(await context.env.FUTURE_STARS_ARENA.overview(params)); } catch (error) { if (error.status === 400) throw new PublicError(error.message, 400); return response(unavailableArena(params, Date.now(), 'unavailable')); }
  }
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
