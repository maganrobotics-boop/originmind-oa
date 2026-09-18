import { getD1Database } from '../../../../db';
import { getAuthorizedUser } from '../../_lib/auth';
import { ARTIFACT_TYPES, verifiedArtifactBytes } from '../../../../lib/ai-workbench-artifacts.mjs';
import { hasMeetingAdminMembership, isMeetingId, listAdminMeetingMinutes, parseMeetingCursor, readAdminMeetingArtifact, readAdminMeetingMinute, type MeetingAdmin } from '../../../../lib/admin-meeting-minutes';

const headers = { 'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff', vary: 'Cookie' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
export async function GET(request: Request) {
  try {
    const user = await getAuthorizedUser({ readOnly: true });
    if (!user) return json({ error: '请先登录 OA。' }, 401);
    if (!user.isAdmin || !user.ndaCompleted || !user.memberId || !user.accountUserId || !user.memberMutationRevision) return json({ error: '仅已完成准入的 OA 管理员可查看成员会议纪要。' }, 403);
    const actor: MeetingAdmin = { isAdmin: true, memberId: user.memberId, accountUserId: user.accountUserId, memberMutationRevision: user.memberMutationRevision };
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['id', 'format', 'cursor'].includes(key) || params.getAll(key).length !== 1)) return json({ error: '请求格式不正确。' }, 400);
    const id = params.get('id'), format = params.get('format'), rawCursor = params.get('cursor');
    if ((params.has('id') && (!id || !isMeetingId(id))) || (params.has('format') && (!id || !['source', 'md', 'docx'].includes(format || ''))) || (params.has('cursor') && (Boolean(id) || !rawCursor))) return json({ error: '请求格式不正确。' }, 400);
    const cursor = rawCursor ? parseMeetingCursor(rawCursor) : null;
    if (rawCursor && !cursor) return json({ error: '分页位置不正确。' }, 400);
    const db = await getD1Database();
    if (!await hasMeetingAdminMembership(db, actor)) return json({ error: '管理员准入状态已变化，请重新登录。' }, 403);
    if (!id) return json({ ...await listAdminMeetingMinutes(db, actor, cursor), checkedAt: Date.now() });
    const item = await readAdminMeetingMinute(db, actor, id);
    if (!item) return json({ error: '会议纪要不存在、已清理或无访问权限。' }, 404);
    if (!format) return json({ item, checkedAt: Date.now() });
    let bytes: Uint8Array, mime: string, suffix: string;
    if (format === 'source') {
      // This is the submitted TEXT, not a claim to retain the original PDF/DOCX.
      bytes = new TextEncoder().encode(item.material); mime = 'text/plain; charset=utf-8'; suffix = '-提交材料.txt';
    } else {
      if (item.status !== 'succeeded') return json({ error: '成果尚未生成，可先查看或下载提交材料。' }, 409);
      const artifact = await readAdminMeetingArtifact(db, actor, id, format as 'md' | 'docx');
      if (!artifact) return json({ error: '成果文件尚未完整保存或权限已变化。' }, 409);
      bytes = await verifiedArtifactBytes(artifact); mime = ARTIFACT_TYPES[format as 'md' | 'docx']; suffix = `.${format}`;
    }
    // Catch an admission change while a saved artifact was being verified.
    if (!await hasMeetingAdminMembership(db, actor)) return json({ error: '管理员访问权限已变化。' }, 403);
    const filename = encodeURIComponent(item.title.replace(/[\/\\:*?"<>|\r\n\t]/gu, '_') + suffix);
    return new Response(bytes, { headers: { ...headers, 'content-type': mime, 'content-length': String(bytes.byteLength), 'content-disposition': `attachment; filename="meeting.${format === 'source' ? 'txt' : format}"; filename*=UTF-8''${filename}` } });
  } catch {
    return json({ error: '会议纪要暂时无法读取；未将连接失败当成空记录，请稍后重试。' }, 503);
  }
}
