import { taskActorGuard, type TaskActor, type TaskArtifact } from './ai-workbench-store';

export type MeetingAdmin = TaskActor & { isAdmin: true };
export type MeetingSummary = { id: string; title: string; status: string; uploader_name: string; created_at: number; updated_at: number };
export type MeetingDetail = MeetingSummary & { material: string; result: string; instruction: string };
export type MeetingCursor = { createdAt: number; id: string };
export const MEETING_PAGE_SIZE = 50;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export const isMeetingId = (value: string) => uuid.test(value);
export function parseMeetingCursor(value: string): MeetingCursor | null {
  const match = /^(0|[1-9][0-9]{0,15}):(.+)$/u.exec(value);
  if (!match || !uuid.test(match[2]) || !Number.isSafeInteger(Number(match[1]))) return null;
  return { createdAt: Number(match[1]), id: match[2] };
}
const args = (actor: MeetingAdmin) => {
  if (actor.isAdmin !== true || !actor.memberId || !actor.accountUserId || !actor.memberMutationRevision) throw new Error('MEETING_ADMIN_REQUIRED');
  return [actor.memberId, actor.accountUserId, actor.memberMutationRevision];
};
// isAdmin is resolved from the server's configured identities, never a request field.
// Reuse the existing account/revision/active/NDA predicate on EVERY data read.
export async function hasMeetingAdminMembership(db: D1Database, actor: MeetingAdmin) {
  return Boolean(await db.prepare(`SELECT 1 AS allowed WHERE ${taskActorGuard}`).bind(...args(actor)).first());
}
const summary = `t.id,t.title,t.status,t.created_at,t.updated_at,
 COALESCE(NULLIF(owner.full_name,''),'原上传成员') AS uploader_name`;
const scope = `t.origin='oa' AND t.kind='meeting_minutes'`;
const ownerJoin = `LEFT JOIN members owner ON owner.id=t.member_id AND owner.account_user_id=t.account_user_id`;

export async function listAdminMeetingMinutes(db: D1Database, actor: MeetingAdmin, cursor: MeetingCursor | null) {
  const after = cursor ? ' AND (t.created_at < ? OR (t.created_at = ? AND t.id < ?))' : '';
  const rows = (await db.prepare(`SELECT ${summary} FROM ai_workbench_tasks t ${ownerJoin}
    WHERE ${scope} AND ${taskActorGuard}${after}
    ORDER BY t.created_at DESC,t.id DESC LIMIT ${MEETING_PAGE_SIZE + 1}`)
    .bind(...args(actor), ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [])).all<MeetingSummary>()).results;
  const items = rows.slice(0, MEETING_PAGE_SIZE), last = items.at(-1);
  return { items, nextCursor: rows.length > MEETING_PAGE_SIZE && last ? `${last.created_at}:${last.id}` : null };
}
export async function readAdminMeetingMinute(db: D1Database, actor: MeetingAdmin, id: string) {
  return db.prepare(`SELECT ${summary},t.material,t.result,t.instruction FROM ai_workbench_tasks t ${ownerJoin}
    WHERE ${scope} AND t.id=? AND ${taskActorGuard}`)
    .bind(id, ...args(actor)).first<MeetingDetail>();
}
export async function readAdminMeetingArtifact(db: D1Database, actor: MeetingAdmin, id: string, format: 'md' | 'docx') {
  return db.prepare(`SELECT a.* FROM ai_workbench_artifacts a JOIN ai_workbench_tasks t ON t.id=a.task_id
    WHERE ${scope} AND t.id=? AND t.status='succeeded' AND a.format=? AND ${taskActorGuard}`)
    .bind(id, format, ...args(actor)).first<TaskArtifact>();
}
