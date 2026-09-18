import { getDb } from '../../../../db';
import { extractDocument } from '../../../../chat-cloudflare/src/document-extraction.mjs';
import { attachmentMime, ATTACHMENT_LIMITS, validateBinaryAttachment } from '../../../../lib/oa-chat-attachments.mjs';
import { activeFileActor, authorizeChatFiles, fileJson, readFileBytes, sameOriginFileWrite } from '../../../../lib/oa-chat-file-access';
import { consumeWriteRateLimit } from '../../../../lib/write-rate-limit';

/** Binary bytes exist only during this request; parsing does not submit any knowledge. */
export async function POST(request: Request) {
  if (!sameOriginFileWrite(request)) return fileJson({ error: '仅支持在 OA 内上传文件。' }, 403);
  try {
    const ctx = await authorizeChatFiles(); if (ctx instanceof Response) return ctx;
    let name: string;
    try { name = decodeURIComponent(request.headers.get('x-oa-file-name') || ''); } catch { return fileJson({ error: '文件名格式不正确。' }, 400); }
    if (!name || name.length > 180 || /[\/\\\u0000-\u001f\u007f]/u.test(name)) return fileJson({ error: '文件名格式不正确。' }, 400);
    const mime = attachmentMime(name);
    if (!mime || mime.startsWith('text/') || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== mime) return fileJson({ error: '解析支持 PDF、DOCX、PNG、JPG、WebP，文件名和类型必须一致。' }, 415);
    const bytes = await readFileBytes(request, mime.startsWith('image/') ? ATTACHMENT_LIMITS.image : ATTACHMENT_LIMITS.document);
    let upload;
    try { upload = await validateBinaryAttachment(new File([bytes], name, { type: mime })); }
    catch { return fileJson({ error: '文件校验未通过：请确认文件未损坏、未加密，DOCX 不含宏或外部嵌入资源。' }, 422); }
    if (!await consumeWriteRateLimit(await getDb(), { actorSubject: ctx.actor.accountUserId, scope: 'lab_ai_extract', limit: 30 })) return fileJson({ error: '解析过于频繁，请稍后重试；文件不会自动归档。' }, 429);
    const ai = (ctx.env as unknown as { AI?: { toMarkdown: (...args: unknown[]) => Promise<unknown> } }).AI;
    const result = await extractDocument(ai, upload, new Uint8Array(bytes));
    if (!await activeFileActor(ctx.db, ctx.actor)) return fileJson({ error: '准入状态已变化，未返回文件内容。' }, 403);
    return fileJson({ text: result.text, name, temporary: true });
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : '';
    if (code === 'FILE_TOO_LARGE') return fileJson({ error: '文件过大：文档最多 10 MB，图片最多 8 MB。' }, 413);
    if (code === 'FILE_EMPTY') return fileJson({ error: '文件为空。' }, 400);
    const status = typeof cause === 'object' && cause && 'status' in cause ? Number(cause.status) : 503;
    return fileJson({ error: status === 429 ? '解析服务繁忙或额度不足，请稍后重试。' : status === 422 ? '文件暂时无法解析，请检查清晰度、加密和文件完整性。' : '文件解析服务暂不可用；原文件未归档，也未进入知识库。' }, [413, 422, 429, 502, 503].includes(status) ? status : 503);
  }
}
