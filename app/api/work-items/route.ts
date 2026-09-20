import { getD1Database } from '../../../db';
import { getAuthorizedUser } from '../_lib/auth';
import { readBoundedJsonObject } from '../../../lib/bounded-json-request';
import { OA_PROJECT, extractMeetingActions, serializeWorkItem, type WorkItemRow } from '../../../lib/project-work-items';

const headers = { 'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const email = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const date = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{36}$/iu.test(value) ? value : '';
const sameOrigin = (request: Request) => {
  const origin = request.headers.get('origin');
  return (!origin || origin === new URL(request.url).origin) && request.headers.get('sec-fetch-site') !== 'cross-site';
};

async function actor() {
  const user = await getAuthorizedUser();
  if (!user) return null;
  if (!user.ndaCompleted || !user.memberId) return null;
  return user;
}

export async function GET() {
  const user = await actor();
  if (!user) return json({ error: '请先完成 OA 准入和保密协议。' }, 403);
  try {
    const db = await getD1Database();
    const result = await db.prepare(`SELECT * FROM project_work_items WHERE project=? ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, COALESCE(due_at,'9999-12-31'), updated_at DESC LIMIT 500`).bind(OA_PROJECT).all<WorkItemRow>();
    return json({ items: result.results.map(serializeWorkItem), currentUserEmail: user.user.email.toLowerCase() });
  } catch { return json({ error: '统一待办暂不可用，请稍后重试。' }, 503); }
}

export async function POST(request: Request) {
  const user = await actor();
  if (!user) return json({ error: '请先完成 OA 准入和保密协议。' }, 403);
  if (!sameOrigin(request)) return json({ error: '仅支持在 OA 内创建工作项。' }, 403);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: '工作项必须使用 JSON 提交。' }, 415);
  const parsed = await readBoundedJsonObject(request, 80_000);
  if (!parsed.ok) return json({ error: '工作项内容格式错误或过大。' }, parsed.reason === 'too_large' ? 413 : 400);
  const input = parsed.value;
  const db = await getD1Database();
  const now = new Date().toISOString();
  if (input.action === 'import_meeting') {
    const sourceId = uuid(input.sourceId);
    if (!sourceId || !user.accountUserId) return json({ error: '会议纪要来源不完整。' }, 400);
    const source = await db.prepare(`SELECT title,result FROM ai_workbench_tasks WHERE id=? AND member_id=? AND account_user_id=? AND origin='oa' AND kind='meeting_minutes' AND status='succeeded'`)
      .bind(sourceId, user.memberId, user.accountUserId).first<{ title: string; result: string }>();
    if (!source?.result) return json({ error: '会议纪要尚未生成，或当前账号无权导入。' }, 409);
    const sourceTitle = text(source.title, 180), actions = extractMeetingActions(source.result);
    if (!actions.length) return json({ imported: 0, items: [] });
    const statements = actions.map((title, index) => db.prepare(`INSERT INTO project_work_items(id,project,title,detail,kind,status,priority,assignee_name,assignee_email,due_at,source_type,source_id,source_key,created_by_name,created_by_email,created_at,updated_at)
      VALUES(?,?,?,?,?,'open','normal','','',NULL,'meeting',?,?,?,?,?,?) ON CONFLICT(source_key) DO NOTHING`)
      .bind(crypto.randomUUID(), OA_PROJECT, title, `来自会议：${sourceTitle}`, 'meeting_action', sourceId, `meeting:${sourceId}:${index}`, user.user.displayName, user.user.email.toLowerCase(), now, now));
    await db.batch(statements);
    return json({ imported: actions.length });
  }
  if (input.action !== 'create') return json({ error: '不支持的工作项操作。' }, 400);
  const title = text(input.title, 240), detail = text(input.detail, 2000), assigneeEmail = email(input.assigneeEmail), assigneeName = text(input.assigneeName, 120);
  const kind = ['task', 'risk', 'milestone'].includes(String(input.kind)) ? String(input.kind) : 'task';
  const priority = ['low', 'normal', 'high'].includes(String(input.priority)) ? String(input.priority) : 'normal';
  if (!title) return json({ error: '请填写工作项标题。' }, 400);
  const row = await db.prepare(`INSERT INTO project_work_items(id,project,title,detail,kind,status,priority,assignee_name,assignee_email,due_at,source_type,source_id,source_key,created_by_name,created_by_email,created_at,updated_at)
    VALUES(?,?,?,?,?,'open',?,?,?,?, 'manual','',NULL,?,?,?,?) RETURNING *`)
    .bind(crypto.randomUUID(), OA_PROJECT, title, detail, kind, priority, assigneeName, assigneeEmail, date(input.dueAt), user.user.displayName, user.user.email.toLowerCase(), now, now).first<WorkItemRow>();
  return json({ item: row ? serializeWorkItem(row) : null }, 201);
}

export async function PATCH(request: Request) {
  const user = await actor();
  if (!user) return json({ error: '请先完成 OA 准入和保密协议。' }, 403);
  if (!sameOrigin(request)) return json({ error: '仅支持在 OA 内更新工作项。' }, 403);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: '工作项必须使用 JSON 提交。' }, 415);
  const parsed = await readBoundedJsonObject(request, 20_000);
  if (!parsed.ok) return json({ error: '工作项操作格式错误。' }, 400);
  const input = parsed.value, id = uuid(input.id);
  const status = ['open', 'in_progress', 'done', 'cancelled'].includes(String(input.status)) ? String(input.status) : '';
  if (!id || !status) return json({ error: '工作项编号或状态不正确。' }, 400);
  const db = await getD1Database();
  const current = await db.prepare('SELECT * FROM project_work_items WHERE id=? AND project=?').bind(id, OA_PROJECT).first<WorkItemRow>();
  if (!current) return json({ error: '工作项不存在。' }, 404);
  const currentEmail = user.user.email.toLowerCase();
  const canManage = user.isAdmin || user.role === 'project_owner' || current.created_by_email === currentEmail || current.assignee_email === currentEmail;
  if (!canManage) return json({ error: '只有负责人、创建人或项目管理员可以更新该工作项。' }, 403);
  const now = new Date().toISOString();
  const row = await db.prepare(`UPDATE project_work_items SET status=?,completed_at=?,updated_at=? WHERE id=? RETURNING *`)
    .bind(status, status === 'done' ? now : null, now, id).first<WorkItemRow>();
  return json({ item: row ? serializeWorkItem(row) : null });
}
