import { getD1Database } from '../../../../db';
import { getAuthorizedUser } from '../../_lib/auth';
import { readBoundedJsonObject } from '../../../../lib/bounded-json-request';
import { generateOaTask } from '../../../../lib/oa-chat-client';
import { TASK_LIMITS, validTaskInput } from '../../../../lib/ai-workbench-core.mjs';
import { ARTIFACT_TYPES, verifiedArtifactBytes } from '../../../../lib/ai-workbench-artifacts.mjs';
import { cancelTask, createTask, listTasks, readTask, readTaskArtifact, retryTask, runTask, type TaskActor, type TaskInput, type TaskRow } from '../../../../lib/ai-workbench-store';

const headers = { 'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
function visible(row: TaskRow) {
  return { id: row.id, kind: row.kind, title: row.title, instruction: row.instruction, material: row.material,
    status: row.status, result: row.result, failure_code: row.failure_code, attempts: row.attempts,
    origin: row.origin, created_at: row.created_at, updated_at: row.updated_at };
}
async function access(): Promise<{ actor: TaskActor; db: D1Database } | Response> {
  const user = await getAuthorizedUser();
  if (!user) return json({ code: 'TASK_LOGIN_REQUIRED', error: '请先登录 OA。' }, 401);
  if (!user.ndaCompleted || !user.memberId || !user.accountUserId || !user.memberMutationRevision) return json({ code: 'TASK_ADMISSION_REQUIRED', error: '请先完成实名准入和保密协议。' }, 403);
  const { env } = await import('cloudflare:workers');
  if ((env as unknown as { OA_AI_TASKS_ENABLED?: string }).OA_AI_TASKS_ENABLED !== 'true') return json({ code: 'TASKS_DISABLED', error: 'AI 工作台尚未启用。管理员需在 OA 正式发布中勾选“初始化并启用 AI 工作台”；材料无需重新填写。' }, 503);
  const db = await getD1Database();
  try {
    // Readiness must include file storage, not only an apparently empty task list.
    await db.prepare('SELECT id,member_id,account_user_id,status,origin,lease_token FROM ai_workbench_tasks LIMIT 0').all();
    await db.prepare('SELECT task_id,format,content_base64,byte_size,sha256,lease_token FROM ai_workbench_artifacts LIMIT 0').all();
  } catch {
    return json({ code: 'TASK_SCHEMA_UNAVAILABLE', error: '任务数据库尚未就绪：未完成初始化或暂时不可访问。管理员需检查工作台初始化结果，当前不会提交任务或调用模型。' }, 503);
  }
  return { actor: { memberId: user.memberId, accountUserId: user.accountUserId, memberMutationRevision: user.memberMutationRevision }, db };
}
export async function GET(request: Request) {
  try {
    const ctx = await access(); if (ctx instanceof Response) return ctx;
    const url = new URL(request.url), id = url.searchParams.get('id'), format = url.searchParams.get('format');
    if ([...url.searchParams.keys()].some(k => !['id', 'format'].includes(k)) || (!id && format)) return json({ error: '请求格式不正确。' }, 400);
    if (!id) return json({ tasks: await listTasks(ctx.db, ctx.actor) });
    if (!/^[a-f0-9-]{36}$/u.test(id)) return json({ error: '任务编号不正确。' }, 400);
    const row = await readTask(ctx.db, ctx.actor, id);
    if (!row) return json({ error: '任务不存在或无访问权限。' }, 404);
    if (!format) return json({ task: visible(row) });
    if (format !== 'md' && format !== 'docx') return json({ error: '仅支持 Word 和 Markdown 导出。' }, 400);
    if (row.status !== 'succeeded') return json({ error: '任务尚未生成可下载成果。' }, 409);
    const artifact = await readTaskArtifact(ctx.db, ctx.actor, id, format);
    if (!artifact) return json({ error: '成果文件尚未完整归档或访问权限已变化，暂不可下载。' }, 409);
    const bytes = await verifiedArtifactBytes(artifact);
    const filename = encodeURIComponent(`${row.title.replace(/[\/\\:*?"<>|\r\n\t]/gu, '_')}.${format}`);
    return new Response(bytes, { headers: { ...headers, 'content-type': ARTIFACT_TYPES[format],
      'content-disposition': `attachment; filename="result.${format}"; filename*=UTF-8''${filename}`,
      'content-length': String(bytes.byteLength) } });
  } catch { return json({ error: '任务或文件校验暂不可用，未返回不完整文件，已有成果不会因此删除。' }, 503); }
}
export async function POST(request: Request) {
  try {
    const ctx = await access(); if (ctx instanceof Response) return ctx;
    const origin = request.headers.get('origin');
    if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: '仅支持在 OA 内提交任务。' }, 403);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: '任务必须使用 JSON 提交。' }, 415);
    const parsed = await readBoundedJsonObject(request, TASK_LIMITS.bytes);
    if (!parsed.ok) return json({ error: '提交内容格式错误或过大。' }, parsed.reason === 'too_large' ? 413 : 400);
    const v = parsed.value;
    if (v.action === 'create') {
      if (Object.keys(v).some(k => !['action', 'requestId', 'kind', 'title', 'instruction', 'material'].includes(k)) || typeof v.requestId !== 'string' || !/^[a-f0-9-]{36}$/u.test(v.requestId)) return json({ error: '任务提交格式不正确。' }, 400);
      const input = { kind: v.kind, title: v.title, instruction: v.instruction, material: v.material };
      if (!validTaskInput(input)) return json({ error: '请填写标题、2–2000字任务要求和2–20000字文字材料。' }, 400);
      const task = await createTask(ctx.db, ctx.actor, input as TaskInput, `oa:${v.requestId}`);
      return json({ task: visible(task) }, 201);
    }
    if (Object.keys(v).some(k => !['action', 'id'].includes(k)) || !['run', 'retry', 'cancel'].includes(String(v.action)) || typeof v.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(v.id)) return json({ error: '任务操作格式不正确。' }, 400);
    if (!await readTask(ctx.db, ctx.actor, v.id)) return json({ error: '任务不存在或无访问权限。' }, 404);
    if (v.action === 'cancel') await cancelTask(ctx.db, ctx.actor, v.id);
    if (v.action === 'retry' && !await retryTask(ctx.db, ctx.actor, v.id)) return json({ error: '仅失败任务可重试，每项最多3次、同时最多5项。' }, 409);
    if (v.action === 'run' || v.action === 'retry') await runTask(ctx.db, v.id, generateOaTask);
    const task = await readTask(ctx.db, ctx.actor, v.id);
    return task ? json({ task: visible(task) }) : json({ error: '任务访问权限已变化。' }, 403);
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : '';
    if (code === 'TASK_IDEMPOTENCY_CONFLICT') return json({ error: '该提交编号已用于其他内容，请重新提交。' }, 409);
    if (code === 'TASK_CREATE_LIMIT_OR_AUTH') return json({ error: '准入状态已变化，或已达到任务数量限制（每日100项、同时最多5项）。' }, 429);
    return json({ error: '任务处理暂不可用，请刷新任务记录核对状态，勿重复提交。' }, 503);
  }
}
