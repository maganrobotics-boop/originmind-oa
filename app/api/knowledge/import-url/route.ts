import { readBoundedJsonObject } from '../../../../lib/bounded-json-request';
import { fetchKnowledgeUrl } from '../../../../lib/knowledge-url-import.mjs';
import { hashKnowledgeSubmission, parseKnowledgeSubmission } from '../../../../lib/knowledge-policy';
import { createKnowledgeItem, type KnowledgeActor } from '../../../../lib/knowledge-store';
import { getAuthorizedUser } from '../../_lib/auth';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store, max-age=0' } });
const sameOrigin = (request: Request) => !request.headers.get('origin') || request.headers.get('origin') === new URL(request.url).origin;

export async function POST(request: Request) {
  const authorized = await getAuthorizedUser();
  if (!authorized?.ndaCompleted || !authorized.memberId || !authorized.accountUserId || !authorized.memberMutationRevision) return json({ error: '请先完成 OA 准入和保密协议。' }, 403);
  if (!sameOrigin(request) || request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: '仅支持在 OA 内导入链接。' }, 403);
  const parsed = await readBoundedJsonObject(request, 8_000);
  if (!parsed.ok || typeof parsed.value.url !== 'string') return json({ error: '请输入有效链接。' }, 400);
  try {
    const page = await fetchKnowledgeUrl(parsed.value.url);
    const submission = parseKnowledgeSubmission({ title: page.title, category: '链接资料', summary: '', sourceLabel: page.title, sourceUrl: page.sourceUrl, content: page.content });
    if (!submission.ok) return json({ error: submission.error }, 400);
    const actor: KnowledgeActor = { memberId: authorized.memberId, accountUserId: authorized.accountUserId, memberMutationRevision: authorized.memberMutationRevision, name: authorized.user.displayName, email: authorized.user.email, isAdmin: authorized.isAdmin, configuredReviewer: authorized.role === 'project_owner' };
    const item = await createKnowledgeItem(actor, submission.value, await hashKnowledgeSubmission(submission.value));
    if (!item) return json({ error: '成员状态已变化，请刷新后重试。' }, 409);
    return json({ item, title: submission.value.title }, 201);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const message = code === 'LINK_URL_UNSAFE' ? '该链接地址不允许导入。' : code === 'LINK_TOO_LARGE' ? '链接内容超过 1 MB。' : code === 'LINK_TYPE_UNSUPPORTED' ? '目前只支持网页和纯文本链接。' : '暂时无法读取该链接，请确认页面可以公开访问。';
    return json({ error: message }, 400);
  }
}
