import { getDb } from '../../../../db';
import { oaChatModelStatus } from '../../../../lib/oa-chat-client';
import { getActiveKnowledgeChunks, type KnowledgeActor } from '../../../../lib/knowledge-store';
import { consumeWriteRateLimit } from '../../../../lib/write-rate-limit';
import { getAuthorizedUser } from '../../_lib/auth';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff' } });
export async function GET(request: Request) {
  const authorized = await getAuthorizedUser();
  if (!authorized) return json({ error: '请先登录 OA' }, 401);
  if (!authorized.ndaCompleted || !authorized.memberId || !authorized.accountUserId || !authorized.memberMutationRevision) return json({ error: '请先完成 OA 准入与保密签署' }, 403);
  if (new URL(request.url).search) return json({ error: '请求格式不正确' }, 400);
  try {
    const db = await getDb();
    if (!await consumeWriteRateLimit(db, { actorSubject: authorized.accountUserId, scope: 'lab_ai_status', limit: 12 })) return json({ error: '状态查询过于频繁' }, 429);
    const actor: KnowledgeActor = { memberId: authorized.memberId, accountUserId: authorized.accountUserId, memberMutationRevision: authorized.memberMutationRevision, name: authorized.user.displayName, email: authorized.user.email, isAdmin: authorized.isAdmin };
    const [model, knowledge] = await Promise.all([
      oaChatModelStatus(),
      getActiveKnowledgeChunks(actor).then(chunks => ({ knowledgeReady: chunks.length > 0, retrievalReady: true })).catch(() => ({ knowledgeReady: false, retrievalReady: false })),
    ]);
    return json({ authorized: true, ...model, ...knowledge });
  } catch { return json({ authorized: true, bridgeReady: false, modelReady: false, budgetReady: false, knowledgeReady: false, retrievalReady: false }); }
}
