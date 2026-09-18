import { validTaskInput, validTaskResult } from './ai-workbench-core.mjs';
import { prepareTaskArtifacts } from './ai-workbench-artifacts.mjs';

export type TaskActor = { memberId: string; accountUserId: string; memberMutationRevision: string };
export type TaskInput = { kind: string; title: string; instruction: string; material: string };
export type TaskRow = { id: string; member_id: string; account_user_id: string; member_revision: string; kind: string; title: string; instruction: string; material: string; status: string; result: string; failure_code: string; attempts: number; lease_token: string | null; lease_until: number | null; origin: string; origin_key: string; created_at: number; updated_at: number };
export type TaskArtifact = { task_id: string; format: 'md' | 'docx'; content_base64: string; byte_size: number; sha256: string; lease_token: string; created_at: number };
// Never trust a stale admission cache after an NDA archive is revoked.
export const taskNdaGuard = `m.nda_accepted_at IS NOT NULL AND m.nda_agreement_version IS NOT NULL AND EXISTS (
 SELECT 1 FROM approvals nda WHERE nda.id=m.nda_approval_id AND nda.type='保密协议' AND nda.status='已归档'
 AND lower(nda.requester_email)=lower(m.chatgpt_account)
 AND CASE WHEN json_valid(nda.payload_json) THEN json_extract(nda.payload_json,'$.signerAccountUserId')=m.account_user_id
 AND json_extract(nda.payload_json,'$.agreementVersion')=m.nda_agreement_version ELSE 0 END)`;
export const taskActorGuard = `EXISTS (SELECT 1 FROM members m WHERE m.id = ? AND m.account_user_id = ? AND m.mutation_revision = ? AND m.status = 'active' AND ${taskNdaGuard})`;
const boundGuard = `ai_workbench_tasks.origin='oa' AND EXISTS (SELECT 1 FROM members m WHERE m.id=ai_workbench_tasks.member_id AND m.account_user_id=ai_workbench_tasks.account_user_id AND m.mutation_revision=ai_workbench_tasks.member_revision AND m.status='active' AND ${taskNdaGuard})`;
const actorArgs = (a: TaskActor) => [a.memberId, a.accountUserId, a.memberMutationRevision];

export async function createTask(db: D1Database, actor: TaskActor, input: TaskInput, originKey: string) {
  if (!validTaskInput(input) || !/^oa:[A-Za-z0-9_-]{8,176}$/u.test(originKey)) throw new Error('TASK_INVALID_INPUT');
  const now = Date.now();
  const row = await db.prepare(`INSERT INTO ai_workbench_tasks (id,member_id,account_user_id,member_revision,kind,title,instruction,material,origin,origin_key,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,'oa',?,?,? WHERE ${taskActorGuard}
      AND (SELECT COUNT(*) FROM ai_workbench_tasks WHERE member_id=? AND created_at>?) < 100
      AND (SELECT COUNT(*) FROM ai_workbench_tasks WHERE member_id=? AND status IN ('queued','running')) < 5
    ON CONFLICT(member_id,account_user_id,origin_key) DO NOTHING RETURNING *`)
    .bind(crypto.randomUUID(), actor.memberId, actor.accountUserId, actor.memberMutationRevision, input.kind, input.title.trim(), input.instruction.trim(), input.material, originKey, now, now,
      ...actorArgs(actor), actor.memberId, now - 86400000, actor.memberId).first<TaskRow>();
  if (row) return row;
  const existing = await db.prepare(`SELECT * FROM ai_workbench_tasks WHERE origin='oa' AND member_id=? AND account_user_id=? AND origin_key=? AND ${taskActorGuard}`).bind(actor.memberId, actor.accountUserId, originKey, ...actorArgs(actor)).first<TaskRow>();
  if (!existing) throw new Error('TASK_CREATE_LIMIT_OR_AUTH');
  if (existing.kind !== input.kind || existing.instruction !== input.instruction.trim() || existing.material !== input.material || existing.title !== input.title.trim()) throw new Error('TASK_IDEMPOTENCY_CONFLICT');
  return existing;
}
export async function readTask(db: D1Database, actor: TaskActor, id: string) {
  return db.prepare(`SELECT * FROM ai_workbench_tasks WHERE origin='oa' AND id=? AND member_id=? AND account_user_id=? AND ${taskActorGuard}`).bind(id, actor.memberId, actor.accountUserId, ...actorArgs(actor)).first<TaskRow>();
}
export async function readTaskArtifact(db: D1Database, actor: TaskActor, id: string, format: string) {
  return db.prepare(`SELECT a.* FROM ai_workbench_artifacts a JOIN ai_workbench_tasks t ON t.id=a.task_id
    WHERE t.origin='oa' AND t.status='succeeded' AND t.id=? AND a.format=? AND t.member_id=? AND t.account_user_id=? AND ${taskActorGuard}`)
    .bind(id, format, actor.memberId, actor.accountUserId, ...actorArgs(actor)).first<TaskArtifact>();
}
export async function listTasks(db: D1Database, actor: TaskActor) {
  return (await db.prepare(`SELECT id,kind,title,status,failure_code,attempts,origin,created_at,updated_at FROM ai_workbench_tasks WHERE origin='oa' AND member_id=? AND account_user_id=? AND ${taskActorGuard} ORDER BY created_at DESC LIMIT 30`).bind(actor.memberId, actor.accountUserId, ...actorArgs(actor)).all()).results;
}
export async function cancelTask(db: D1Database, actor: TaskActor, id: string) {
  return db.prepare(`UPDATE ai_workbench_tasks SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=? WHERE origin='oa' AND id=? AND member_id=? AND account_user_id=? AND status IN ('queued','running','failed') AND ${taskActorGuard} RETURNING id`).bind(Date.now(), id, actor.memberId, actor.accountUserId, ...actorArgs(actor)).first();
}
export async function retryTask(db: D1Database, actor: TaskActor, id: string) {
  return db.prepare(`UPDATE ai_workbench_tasks SET status='queued',failure_code='',member_revision=?,updated_at=? WHERE origin='oa' AND id=? AND member_id=? AND account_user_id=? AND status='failed' AND attempts<3
    AND (SELECT COUNT(*) FROM ai_workbench_tasks WHERE member_id=? AND status IN ('queued','running'))<5
    AND ${taskActorGuard} RETURNING id`).bind(actor.memberMutationRevision, Date.now(), id, actor.memberId, actor.accountUserId, actor.memberId, ...actorArgs(actor)).first();
}
export async function runTask(db: D1Database, id: string, generate: (input: TaskInput) => Promise<string>) {
  // Refuse execution before artifact storage is migrated; do not waste a model call.
  await db.prepare('SELECT task_id FROM ai_workbench_artifacts LIMIT 0').all();
  const token = crypto.randomUUID(), now = Date.now();
  // A crashed lease is not automatically re-billed. The owner must request retry.
  await db.prepare(`UPDATE ai_workbench_tasks SET status='failed',failure_code='TASK_INTERRUPTED',lease_token=NULL,lease_until=NULL,updated_at=? WHERE origin='oa' AND id=? AND status='running' AND lease_until<?`).bind(now, id, now).run();
  const row = await db.prepare(`UPDATE ai_workbench_tasks SET status='running',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued' AND attempts<3 AND ${boundGuard} RETURNING *`).bind(token, now + 120000, now, id).first<TaskRow>();
  if (!row) {
    await db.prepare(`UPDATE ai_workbench_tasks SET status='failed',failure_code='TASK_ACCESS_CHANGED',updated_at=? WHERE origin='oa' AND id=? AND status='queued' AND NOT (${boundGuard})`).bind(now, id).run();
    return;
  }
  let failure = 'TASK_GENERATION_FAILED';
  try {
    const result = await generate({ kind: row.kind, title: row.title, instruction: row.instruction, material: row.material });
    if (!validTaskResult(result)) throw new Error('TASK_INVALID_RESULT');
    failure = 'TASK_ARTIFACT_FAILED';
    const prepared = await prepareTaskArtifacts(row.title, result);
    failure = 'TASK_SAVE_FAILED';
    const savedAt = Date.now();
    // D1 batch is transactional: failed file writes cannot leave a successful task.
    const eligible = `id=? AND status='running' AND lease_token=? AND lease_until>=? AND ${boundGuard}`;
    const statements = prepared.artifacts.map(artifact => db.prepare(`INSERT INTO ai_workbench_artifacts(task_id,format,content_base64,byte_size,sha256,lease_token,created_at)
      SELECT id,?,?,?,?,?,? FROM ai_workbench_tasks WHERE ${eligible}
      ON CONFLICT(task_id,format) DO UPDATE SET content_base64=excluded.content_base64,byte_size=excluded.byte_size,sha256=excluded.sha256,lease_token=excluded.lease_token,created_at=excluded.created_at`)
      .bind(artifact.format, artifact.content_base64, artifact.byte_size, artifact.sha256, token, savedAt, id, token, savedAt));
    statements.push(db.prepare(`UPDATE ai_workbench_tasks SET status='succeeded',result=?,failure_code='',lease_token=NULL,lease_until=NULL,updated_at=? WHERE ${eligible}
      AND (SELECT COUNT(*) FROM ai_workbench_artifacts WHERE task_id=? AND lease_token=?)=2`)
      .bind(prepared.markdown, savedAt, id, token, savedAt, id, token));
    await db.batch(statements);
    // Cancellation leaves the task cancelled; a changed identity/expired lease fails closed.
    await db.prepare(`UPDATE ai_workbench_tasks SET status='failed',failure_code='TASK_ACCESS_CHANGED',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='running' AND lease_token=?`).bind(Date.now(), id, token).run();
  } catch {
    await db.prepare(`UPDATE ai_workbench_tasks SET status='failed',failure_code=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='running' AND lease_token=?`).bind(failure, Date.now(), id, token).run();
  }
}
