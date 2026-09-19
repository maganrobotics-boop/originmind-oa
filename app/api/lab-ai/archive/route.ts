import { getDb } from '../../../../db';
import { readBoundedJsonObject } from '../../../../lib/bounded-json-request';
import { readTask } from '../../../../lib/ai-workbench-store';
import { chatImportIdentity, parseChatKnowledgeImport } from '../../../../lib/chat-knowledge-import';
import { knowledgeImageReferences } from '../../../../lib/knowledge-image-references.mjs';
import { createChatImportedKnowledgeItem, findKnowledgeItem, type KnowledgeActor } from '../../../../lib/knowledge-store';
import { acknowledgeFileArchive, pinFileArchive, readFileRetention, TEMPORARY_FILE_TTL } from '../../../../lib/oa-chat-file-lifecycle';
import { authorizeChatFiles, fileJson, sameOriginFileWrite } from '../../../../lib/oa-chat-file-access';
import { consumeWriteRateLimit } from '../../../../lib/write-rate-limit';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function knowledgeActor(ctx: Exclude<Awaited<ReturnType<typeof authorizeChatFiles>>, Response>): KnowledgeActor {
  return { ...ctx.actor, name: ctx.user.user.displayName, email: ctx.user.user.email, isAdmin: ctx.user.isAdmin };
}
export async function GET(request: Request) {
  try {
    const ctx = await authorizeChatFiles(); if (ctx instanceof Response) return ctx;
    const url = new URL(request.url), id = url.searchParams.get('id');
    if (!id || !UUID.test(id) || [...url.searchParams.keys()].some(key => key !== 'id')) return fileJson({ error: '成果编号不正确。' }, 400);
    const task = await readTask(ctx.db, ctx.actor, id);
    if (!task) return fileJson({ error: '成果不存在、已清理或无访问权限。' }, 404);
    const retention = await readFileRetention(ctx.db, ctx.actor, id);
    const item = retention?.knowledge_item_id ? await findKnowledgeItem(retention.knowledge_item_id, knowledgeActor(ctx)) : null;
    const draft = retention?.state === 'temporary' && retention.expires_at === null;
    return fileJson({ lifecycle: { state: draft ? 'draft' : retention?.state || 'legacy', expiresAt: retention?.state === 'temporary' && !draft ? Math.max(retention.expires_at || 0, task.updated_at + TEMPORARY_FILE_TTL) : null,
      knowledgeItemId: item?.id || null, knowledgeStatus: item?.status || null, visibility: item?.visibility || null } });
  } catch { return fileJson({ error: '暂时无法核对归档或清理状态，未更改文件。' }, 503); }
}
export async function POST(request: Request) {
  if (!sameOriginFileWrite(request)) return fileJson({ error: '仅支持在 OA 内归档。' }, 403);
  try {
    const ctx = await authorizeChatFiles(); if (ctx instanceof Response) return ctx;
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fileJson({ error: '归档必须使用 JSON 提交。' }, 415);
    const parsed = await readBoundedJsonObject(request, 2048);
    if (!parsed.ok) return fileJson({ error: '归档请求格式错误或过大。' }, parsed.reason === 'too_large' ? 413 : 400);
    const { id, confirmed, expectedUpdatedAt } = parsed.value;
    if (Object.keys(parsed.value).some(key => !['id', 'confirmed', 'expectedUpdatedAt'].includes(key)) || typeof id !== 'string' || !UUID.test(id) || confirmed !== true
      || (expectedUpdatedAt !== undefined && (!Number.isSafeInteger(expectedUpdatedAt) || Number(expectedUpdatedAt) <= 0))) return fileJson({ error: '请确认核对过归档正文和脱敏情况。' }, 400);
    const task = await readTask(ctx.db, ctx.actor, id);
    if (!task) return fileJson({ error: '成果不存在、已清理或无访问权限。' }, 404);
    if (task.status !== 'succeeded' || !task.result) return fileJson({ error: '仅完整生成的成果可以归档。' }, 409);
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== task.updated_at) return fileJson({ error: '文档已在其他窗口更新，请重新核对最新稿后提交。' }, 409);
    // The document-generation contract is text-only. Original images use the source-material card.
    if (knowledgeImageReferences(task.result).size) return fileJson({ error: '成果包含未附带原图的引用，请从原始资料卡归档图文，或去掉无效引用后重新生成。' }, 409);
    const pinned = await pinFileArchive(ctx.db, ctx.actor, id, Date.now(), task.updated_at);
    // The pin is a write barrier: never submit a pre-pin snapshot after another save won.
    const locked = await readTask(ctx.db, ctx.actor, id);
    if (!locked || locked.updated_at !== task.updated_at) return fileJson({ error: '文档版本已变化，请重新核对后提交。' }, 409);
    const actor = knowledgeActor(ctx);
    if (pinned.state === 'submitted' && pinned.knowledge_item_id) {
      const item = await findKnowledgeItem(pinned.knowledge_item_id, actor);
      if (!item) return fileJson({ error: '成果已受归档保护，但暂时无法核对 OA 条目。' }, 409);
      return fileJson({ received: true, item: { id: item.id, status: item.status, visibility: item.visibility } });
    }
    if (!await consumeWriteRateLimit(await getDb(), { actorSubject: actor.accountUserId, scope: 'knowledge_submit', limit: 10 })) return fileJson({ error: '归档过于频繁，请稍后核对重试；成果已受保护，不会被临时清理。' }, 429);
    const imported = parseChatKnowledgeImport({ document: { id: task.id, title: task.title.length < 2 ? `${task.title}文档` : task.title, body: task.result,
      category: 'research', updatedAt: new Date(task.updated_at).toISOString().slice(0, 10), url: '' } });
    const submission = { ...imported.submissions[0], sourceLabel: `OA AI 成果归档 · ${task.title}` };
    const identity = await chatImportIdentity(actor.accountUserId, task.id, submission, 0);
    const item = await createChatImportedKnowledgeItem(actor, submission, identity.contentHash, identity.itemId, imported.parts.map(part => part.content));
    if (!item) return fileJson({ error: 'OA 尚未确认接收，请核对重试；成果已受保护，不会被临时清理。' }, 409);
    await acknowledgeFileArchive(ctx.db, ctx.actor, task.id, item.id);
    return fileJson({ received: true, item: { id: item.id, status: item.status, visibility: item.visibility } }, 201);
  } catch (cause) {
    if (cause instanceof Error && cause.message === 'FILE_ARCHIVE_VERSION_CONFLICT') return fileJson({ error: '文档版本或访问状态已变化，请重新核对最新稿后提交。' }, 409);
    return fileJson({ error: '归档结果尚未确认，请核对后重试；不会绕过审批或自动公开。' }, 503);
  }
}
