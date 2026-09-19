import { validTaskResult } from './ai-workbench-core.mjs';
import { prepareTaskArtifacts } from './ai-workbench-artifacts.mjs';
import { readTask, taskActorGuard, type TaskActor, type TaskRow } from './ai-workbench-store';
import { readFileRetention } from './oa-chat-file-lifecycle';

export type DocumentDraft = { title: string; result: string; expectedUpdatedAt: number };
export function validDocumentDraft(value: unknown): value is DocumentDraft {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.title === 'string' && v.title.trim().length > 0 && v.title.length <= 100
    && v.title.isWellFormed() && !/[\u0000-\u001f\u007f\ufffe\uffff]/u.test(v.title) && validTaskResult(v.result)
    && Number.isSafeInteger(v.expectedUpdatedAt) && Number(v.expectedUpdatedAt) > 0;
}
/** Save only the owner's completed document. No model call or knowledge-base write. */
export async function saveDocumentDraft(db: D1Database, actor: TaskActor, id: string, draft: DocumentDraft) {
  if (!validDocumentDraft(draft)) throw new Error('DRAFT_INVALID');
  const current = await readTask(db, actor, id);
  if (!current) throw new Error('DRAFT_NOT_FOUND');
  const retention = await readFileRetention(db, actor, id);
  if (current.status !== 'succeeded' || (retention && retention.state !== 'temporary')) throw new Error('DRAFT_LOCKED');
  // Renaming the title must not retain a second, obsolete generated heading.
  let result = draft.result.replace(/\r\n?/gu, '\n').trim();
  if (result.split('\n')[0].trim() === `# ${current.title}`) result = result.split('\n').slice(1).join('\n').trim();
  const prepared = await prepareTaskArtifacts(draft.title.trim(), result);
  if (!validTaskResult(prepared.markdown)) throw new Error('DRAFT_INVALID');
  // A lost save acknowledgement may be retried, but never overwrite a newer edit.
  if (current.updated_at !== draft.expectedUpdatedAt) {
    if (retention?.state === 'temporary' && retention.expires_at === null
      && current.title === draft.title.trim() && current.result === prepared.markdown) return current;
    throw new Error('DRAFT_CONFLICT');
  }
  const savedAt = Math.max(Date.now(), current.updated_at + 1), token = crypto.randomUUID();
  const eligible = `origin='oa' AND id=? AND member_id=? AND account_user_id=? AND status='succeeded' AND updated_at=?
    AND ${taskActorGuard} AND NOT EXISTS(SELECT 1 FROM ai_workbench_retention r WHERE r.task_id=ai_workbench_tasks.id AND r.state<>'temporary')`;
  const args = [id, actor.memberId, actor.accountUserId, draft.expectedUpdatedAt, actor.memberId, actor.accountUserId, actor.memberMutationRevision];
  const statements = prepared.artifacts.map(artifact => db.prepare(`INSERT INTO ai_workbench_artifacts(task_id,format,content_base64,byte_size,sha256,lease_token,created_at)
    SELECT id,?,?,?,?,?,? FROM ai_workbench_tasks WHERE ${eligible}
    ON CONFLICT(task_id,format) DO UPDATE SET content_base64=excluded.content_base64,byte_size=excluded.byte_size,sha256=excluded.sha256,lease_token=excluded.lease_token,created_at=excluded.created_at`)
    .bind(artifact.format, artifact.content_base64, artifact.byte_size, artifact.sha256, token, savedAt, ...args));
  statements.push(db.prepare(`UPDATE ai_workbench_tasks SET title=?,result=?,updated_at=? WHERE ${eligible}
    AND (SELECT COUNT(*) FROM ai_workbench_artifacts WHERE task_id=? AND lease_token=?)=2 RETURNING *`)
    .bind(draft.title.trim(), prepared.markdown, savedAt, ...args, id, token));
  // NULL expiry on a temporary row means an explicitly saved draft, not a submission.
  // Cleanup already requires expires_at <= cutoff, so saved drafts cannot be erased.
  statements.push(db.prepare(`INSERT INTO ai_workbench_retention(task_id,state,expires_at,created_at,updated_at)
    SELECT id,'temporary',NULL,?,? FROM ai_workbench_tasks WHERE origin='oa' AND id=? AND updated_at=?
      AND (SELECT COUNT(*) FROM ai_workbench_artifacts WHERE task_id=? AND lease_token=?)=2
    ON CONFLICT(task_id) DO UPDATE SET expires_at=NULL,updated_at=excluded.updated_at WHERE ai_workbench_retention.state='temporary'`)
    .bind(savedAt, savedAt, id, savedAt, id, token));
  const saved = await db.batch(statements);
  if (saved.some(item => !item.success)) throw new Error('DRAFT_SAVE_FAILED');
  const row = saved[2]?.results?.[0] as TaskRow | undefined;
  if (!row || row.updated_at !== savedAt || row.result !== prepared.markdown) throw new Error('DRAFT_CONFLICT');
  return row;
}
