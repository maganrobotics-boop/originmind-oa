import { getD1Database } from '../db';
import { getAuthorizedUser } from '../app/api/_lib/auth';
import { taskActorGuard, type TaskActor } from './ai-workbench-store';

export const fileHeaders = { 'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff', vary: 'Cookie' };
export const fileJson = (data: unknown, status = 200) => Response.json(data, { status, headers: fileHeaders });
export function sameOriginFileWrite(request: Request) {
  const origin = request.headers.get('origin');
  return (!origin || origin === new URL(request.url).origin) && request.headers.get('sec-fetch-site') !== 'cross-site';
}
export async function activeFileActor(db: D1Database, actor: TaskActor) {
  return Boolean(await db.prepare(`SELECT 1 AS allowed WHERE ${taskActorGuard}`).bind(actor.memberId, actor.accountUserId, actor.memberMutationRevision).first());
}
export async function authorizeChatFiles() {
  const user = await getAuthorizedUser();
  if (!user) return fileJson({ error: '请先登录 OA。' }, 401);
  if (!user.ndaCompleted || !user.memberId || !user.accountUserId || !user.memberMutationRevision) return fileJson({ error: '请先完成实名准入和保密协议。' }, 403);
  const { env } = await import('cloudflare:workers');
  if ((env as unknown as { OA_AI_TASKS_ENABLED?: string }).OA_AI_TASKS_ENABLED !== 'true') return fileJson({ error: 'AI 文件服务尚未启用。' }, 503);
  const db = await getD1Database();
  const actor = { memberId: user.memberId, accountUserId: user.accountUserId, memberMutationRevision: user.memberMutationRevision };
  if (!await activeFileActor(db, actor)) return fileJson({ error: '成员或保密准入状态已变化，请重新登录核对。' }, 403);
  return { db, actor, user, env };
}
export async function readFileBytes(request: Request, maximum: number): Promise<ArrayBuffer> {
  if (Number(request.headers.get('content-length')) > maximum) throw new Error('FILE_TOO_LARGE');
  if (!request.body) throw new Error('FILE_EMPTY');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('FILE_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!size) throw new Error('FILE_EMPTY');
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes.buffer;
}
