import { validTaskInput } from './ai-workbench-core.mjs';
export type TaskActor = { memberId: string; accountUserId: string; memberMutationRevision: string };
export type TaskInput = { kind: string; title: string; instruction: string; material: string };
export type TaskRow = { id: string; member_id: string; account_user_id: string; member_revision: string; kind: string; title: string; instruction: string; material: string; status: string; result: string; failure_code: string; attempts: number; lease_token: string | null; lease_until: number | null; origin: string; origin_key: string; feishu_subject: string; delivery_parts: number; delivery_started_at: number | null; delivery_status: string; created_at: number; updated_at: number };
export const taskActorGuard = `EXISTS (SELECT 1 FROM members m WHERE m.id = ? AND m.account_user_id = ? AND m.mutation_revision = ? AND m.status = 'active' AND m.nda_accepted_at IS NOT NULL AND m.nda_agreement_version IS NOT NULL)`;
const actorArgs = (a: TaskActor) => [a.memberId, a.accountUserId, a.memberMutationRevision];
export async function createTask(db: D1Database, actor: TaskActor, input: TaskInput, originKey: string, origin = 'oa', feishuSubject = '') {
  if (!validTaskInput(input) || !/^[A-Za-z0-9:_-]{8,180}$/u.test(originKey) || !['oa','feishu'].includes(origin)) throw new Error('TASK_INVALID_INPUT');
  const now = Date.now();
  const row = await db.prepare(`INSERT INTO ai_workbench_tasks (id,member_id,account_user_id,member_revision,kind,title,instruction,material,origin,origin_key,feishu_subject,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${taskActorGuard}
      AND (SELECT COUNT(*) FROM ai_workbench_tasks WHERE member_id=? AND created_at>?) < 100
      AND (SELECT COUNT(*) FROM ai_workbench_tasks WHERE member_id=? AND status IN ('queued','running')) < 5
    ON CONFLICT(member_id,account_user_id,origin_key) DO NOTHING RETURNING *`)
    .bind(crypto.randomUUID(), actor.memberId, actor.accountUserId, actor.memberMutationRevision, input.kind, input.title.trim(), input.instruction.trim(), input.material, origin, originKey, feishuSubject, now, now,
      ...actorArgs(actor), actor.memberId, now - 86400000, actor.memberId).first<TaskRow>();
  if (row) return row;
  const existing = await db.prepare(`SELECT * FROM ai_workbench_tasks WHERE member_id=? AND account_user_id=? AND origin_key=? AND ${taskActorGuard}`).bind(actor.memberId, actor.accountUserId, originKey, ...actorArgs(actor)).first<TaskRow>();
  if (!existing) throw new Error('TASK_CREATE_LIMIT_OR_AUTH');
  if (existing.kind !== input.kind || existing.instruction !== input.instruction.trim() || existing.material !== input.material || existing.title !== input.title.trim()) throw new Error('TASK_IDEMPOTENCY_CONFLICT');
  return existing;
}
export async function readTask(db: D1Database, actor: TaskActor, id: string) {
  return db.prepare(`SELECT * FROM ai_workbench_tasks WHERE id=? AND member_id=? AND account_user_id=? AND ${taskActorGuard}`).bind(id, actor.memberId, actor.accountUserId, ...actorArgs(actor)).first<TaskRow>();
}
export async function listTasks(db: D1Database, actor: TaskActor) {
  return (await db.prepare(`SELECT id,kind,title,status,failure_code,attempts,origin,delivery_status,created_at,updated_at FROM ai_workbench_tasks WHERE member_id=? AND account_user_id=? AND ${taskActorGuard} ORDER BY created_at DESC LIMIT 30`).bind(actor.memberId, actor.accountUserId, ...actorArgs(actor)).all()).results;
}
export async function cancelTask(db: D1Database, actor: TaskActor, id: string) {
  return db.prepare(`UPDATE ai_workbench_tasks SET status='cancelled', lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=? AND member_id=? AND account_user_id=? AND status IN ('queued','running','failed') AND ${taskActorGuard} RETURNING id`).bind(Date.now(), id, actor.memberId, actor.accountUserId, ...actorArgs(actor)).first();
}
export async function retryTask(db: D1Database, actor: TaskActor, id: string) {
  return db.prepare(`UPDATE ai_workbench_tasks SET status='queued',failure_code='',member_revision=?,delivery_status='pending',delivery_parts=0,delivery_started_at=NULL,delivery_lease=NULL,delivery_lease_until=NULL,updated_at=? WHERE id=? AND member_id=? AND account_user_id=? AND status='failed' AND attempts<3 AND failure_code NOT IN ('TASK_MATERIAL_MISSING','TASK_UNSUPPORTED_MATERIAL') AND ${taskActorGuard} RETURNING id`).bind(actor.memberMutationRevision, Date.now(), id, actor.memberId, actor.accountUserId, ...actorArgs(actor)).first();
}
export async function runTask(db: D1Database, id: string, generate: (input: TaskInput) => Promise<string>) {
  const token = crypto.randomUUID(), now = Date.now();
  const boundGuard = `EXISTS (SELECT 1 FROM members m WHERE m.id=ai_workbench_tasks.member_id AND m.account_user_id=ai_workbench_tasks.account_user_id AND m.mutation_revision=ai_workbench_tasks.member_revision AND m.status='active' AND m.nda_accepted_at IS NOT NULL AND m.nda_agreement_version IS NOT NULL) AND (ai_workbench_tasks.origin='oa' OR EXISTS (SELECT 1 FROM auth_identities a WHERE a.member_id=ai_workbench_tasks.member_id AND a.provider='feishu' AND a.provider_subject=ai_workbench_tasks.feishu_subject AND a.unlinked_at IS NULL))`;
  // A crashed lease is not automatically re-billed. It becomes retryable failure.
  await db.prepare(`UPDATE ai_workbench_tasks SET status='failed',failure_code='TASK_INTERRUPTED',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='running' AND lease_until<?`).bind(now, id, now).run();
  const row = await db.prepare(`UPDATE ai_workbench_tasks SET status='running',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued' AND attempts<3 AND ${boundGuard} RETURNING *`).bind(token, now+120000, now, id).first<TaskRow>();
  if (!row) {
    await db.prepare(`UPDATE ai_workbench_tasks SET status='failed',failure_code='TASK_ACCESS_CHANGED',updated_at=? WHERE id=? AND status='queued' AND NOT (${boundGuard})`).bind(now,id).run();
    return;
  }
  try {
    const result = await generate({ kind: row.kind, title: row.title, instruction: row.instruction, material: row.material });
    const { validTaskResult } = await import('./ai-workbench-core.mjs');
    if (!validTaskResult(result)) throw new Error('TASK_INVALID_RESULT');
    const saved = await db.prepare(`UPDATE ai_workbench_tasks SET status='succeeded',result=?,failure_code='',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='running' AND lease_token=? AND ${boundGuard} RETURNING id`).bind(result,Date.now(),id,token).first();
    if (!saved) await db.prepare(`UPDATE ai_workbench_tasks SET status='failed',failure_code='TASK_ACCESS_CHANGED',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='running' AND lease_token=?`).bind(Date.now(),id,token).run();
  } catch {
    await db.prepare(`UPDATE ai_workbench_tasks SET status='failed',failure_code='TASK_GENERATION_FAILED',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='running' AND lease_token=?`).bind(Date.now(),id,token).run();
  }
}
