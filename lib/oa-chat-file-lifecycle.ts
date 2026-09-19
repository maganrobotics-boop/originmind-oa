import { taskActorGuard, type TaskActor } from './ai-workbench-store';

export const TEMPORARY_FILE_TTL = 7 * 24 * 60 * 60 * 1000;
export type FileRetention = { task_id: string; state: 'temporary' | 'archiving' | 'submitted' | 'deleting'; expires_at: number | null; knowledge_item_id: string | null; created_at: number; updated_at: number };
const args = (actor: TaskActor) => [actor.memberId, actor.accountUserId, actor.memberMutationRevision];
export async function readFileRetention(db: D1Database, actor: TaskActor, id: string) {
  return db.prepare(`SELECT r.* FROM ai_workbench_retention r JOIN ai_workbench_tasks t ON t.id=r.task_id
    WHERE t.id=? AND t.origin='oa' AND t.member_id=? AND t.account_user_id=? AND ${taskActorGuard}`)
    .bind(id, actor.memberId, actor.accountUserId, ...args(actor)).first<FileRetention>();
}
/** Pin BEFORE the idempotent knowledge write. A lost acknowledgement is recoverable, never garbage collected. */
export async function pinFileArchive(db: D1Database, actor: TaskActor, id: string, now = Date.now(), expectedUpdatedAt?: number) {
  const pinned = await db.prepare(`INSERT INTO ai_workbench_retention(task_id,state,expires_at,created_at,updated_at)
    SELECT id,'archiving',NULL,?,? FROM ai_workbench_tasks
    WHERE id=? AND origin='oa' AND member_id=? AND account_user_id=? AND status='succeeded' AND ${taskActorGuard}
      AND (? IS NULL OR updated_at=?)
    ON CONFLICT(task_id) DO UPDATE SET state='archiving',expires_at=NULL,updated_at=excluded.updated_at
    WHERE ai_workbench_retention.state='temporary' RETURNING *`)
    .bind(now, now, id, actor.memberId, actor.accountUserId, ...args(actor), expectedUpdatedAt ?? null, expectedUpdatedAt ?? null).first<FileRetention>();
  const result = pinned || await readFileRetention(db, actor, id);
  if (!result || !['archiving', 'submitted'].includes(result.state)) throw new Error(expectedUpdatedAt === undefined ? 'FILE_ARCHIVE_NOT_AVAILABLE' : 'FILE_ARCHIVE_VERSION_CONFLICT');
  return result;
}
export async function acknowledgeFileArchive(db: D1Database, actor: TaskActor, id: string, itemId: string) {
  const result = await db.prepare(`UPDATE ai_workbench_retention SET state='submitted',knowledge_item_id=?,expires_at=NULL,updated_at=?
    WHERE task_id=? AND state='archiving' AND ${taskActorGuard}
    AND EXISTS(SELECT 1 FROM ai_workbench_tasks t WHERE t.id=task_id AND t.origin='oa' AND t.member_id=? AND t.account_user_id=? AND t.status='succeeded') RETURNING *`)
    .bind(itemId, Date.now(), id, ...args(actor), actor.memberId, actor.accountUserId).first<FileRetention>();
  if (result) return result;
  const existing = await readFileRetention(db, actor, id);
  if (existing?.state === 'submitted' && existing.knowledge_item_id === itemId) return existing;
  throw new Error('FILE_ARCHIVE_ACK_NOT_CONFIRMED');
}
/** A single transactional claim/erase: a concurrent archive wins or sees an already-deleted task. */
export async function cleanupTemporaryFiles(db: D1Database, now = Date.now()) {
  return db.batch([
    db.prepare(`UPDATE ai_workbench_retention SET state='deleting',updated_at=? WHERE state='temporary' AND task_id IN (
      SELECT r.task_id FROM ai_workbench_retention r JOIN ai_workbench_tasks t ON t.id=r.task_id
      WHERE r.state='temporary' AND r.expires_at<=? AND t.updated_at<=? AND t.origin='oa'
      AND t.status IN ('succeeded','failed','cancelled') AND t.lease_token IS NULL
      ORDER BY r.expires_at LIMIT 25)`).bind(now, now, now - TEMPORARY_FILE_TTL),
    db.prepare(`DELETE FROM ai_workbench_artifacts WHERE task_id IN(SELECT task_id FROM ai_workbench_retention WHERE state='deleting')`),
    db.prepare(`DELETE FROM ai_workbench_tasks WHERE id IN(SELECT task_id FROM ai_workbench_retention WHERE state='deleting') AND origin='oa'`),
  ]);
}
export async function processTemporaryFileCleanup(env: { DB: D1Database; OA_AI_TASKS_ENABLED?: string }) {
  if (env.OA_AI_TASKS_ENABLED !== 'true') return;
  try { await cleanupTemporaryFiles(env.DB); }
  catch { console.error('OA_TEMPORARY_FILE_CLEANUP_NOT_CONFIRMED'); }
}
