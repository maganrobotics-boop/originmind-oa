"""Apply the personnel integration to an existing OA checkout, preserving newer features."""
from pathlib import Path
import sys
root=Path(sys.argv[1])
def replace(s,a,b):
    assert s.count(a)==1,(a[:120],s.count(a))
    return s.replace(a,b)
p=root/'app/api/lab-ai/ask/route.ts';s=p.read_text()
s=replace(s,'import { getDb } from "../../../../db";','import { getDb, getD1Database } from "../../../../db";\nimport { answerPersonnelQuestion } from "../../../../lib/personnel-chat.mjs";')
anchor='    const actor: KnowledgeActor = {'
s=replace(s,anchor,'''    const personnel = await answerPersonnelQuestion(await getD1Database(), authorized, question, history);
    if (personnel) {
      const current = await getAuthorizedUser({ readOnly: true });
      if (!current?.ndaCompleted || current.memberId !== authorized.memberId || current.accountUserId !== authorized.accountUserId ||
        current.memberMutationRevision !== authorized.memberMutationRevision || current.isAdmin !== authorized.isAdmin || current.isFinanceOwner !== authorized.isFinanceOwner)
        return finish(privateJson({ error: '人员权限已变化，请刷新后重试。' }, { status: 403 }));
      return finish(privateJson(personnel));
    }
'''+anchor);p.write_text(s)
p=root/'components/knowledge/oa-chat-panel.tsx';s=p.read_text()
s=replace(s,'type Turn = {','type PersonnelLink = {name:string;href:string};\ntype Turn = { personnelLinks?: PersonnelLink[];')
s=replace(s,'type Reply = {','type Reply = { personnelLinks?: PersonnelLink[];')
s=replace(s,'const quickActions = [',"const quickActions = [\n  { label: '成员情况', prompt: '成员信息', helper: '工作、消费报销与贡献' },")
s=replace(s,'images, failed: fallback','images, personnelLinks: data.mode === \'personnel\' ? data.personnelLinks || [] : undefined, failed: fallback')
s=replace(s,'isAdmin && !turn.failed && <button', 'isAdmin && !turn.failed && !turn.personnelLinks && <button')
anchor='            {!!turn.images.length &&'
s=replace(s,anchor,'''            {turn.personnelLinks && <p className="oa-personnel-links">{turn.personnelLinks.filter(p=>/^\\/people-workbench\\?person=[^/]*$/u.test(p.href)).map(p=><a key={p.href} href={p.href}>{p.name} · 个人主页</a>)} <a href="/people-workbench">人员列表</a></p>}
'''+anchor)
if "['ai', 'general'].includes(data.mode || '')" in s:s=replace(s,"['ai', 'general'].includes(data.mode || '')","['ai', 'general', 'personnel'].includes(data.mode || '')")
p.write_text(s)
p=root/'components/knowledge/oa-chat-panel.css';s=p.read_text();assert '.oa-personnel-links {' not in s
s+='\n.oa-personnel-links { display:flex; flex-wrap:wrap; gap:8px 16px; margin:12px 0; }\n.oa-personnel-links a { color:#1766b0; text-decoration:underline; padding:6px 0; }\n';p.write_text(s)
p=root/'lib/oa-chat-indicators.mjs';s=p.read_text();anchor="  const received = [ready('已收到本次提问响应'), ready('本次提问通过 OA 身份校验')];"
s=replace(s,anchor,anchor+"\n  if (value.mode === 'personnel' && value.sourceType === 'oa_personnel_records' && typeof value.answer === 'string' && value.answer.trim()) return snapshot('question', '本次提问：人员记录已核对', [...received, unknown('本次直接汇总 OA 记录，未调用模型'), ready('已按当前权限读取人员台账'), ready('已生成工作、消费报销与贡献说明')]);")
p.write_text(s)
p=root/'app/api/_lib/auth.ts';s=p.read_text();s="import { financeIdentities } from '../../../lib/finance-identities.mjs';\n"+s
s=replace(s,'entries: configuredRoleEntries("经费负责人", "OA_FINANCE_OWNER_EMAILS", "OA_FINANCE_OWNER_NAMES")','entries: [...configuredRoleEntries("经费负责人", "OA_FINANCE_OWNER_EMAILS", "OA_FINANCE_OWNER_NAMES"), ...financeIdentities(process.env.OA_FINANCE_IDENTITIES_JSON)]');p.write_text(s)
# Read-only finance visibility for both procurement and remuneration; existing
# approval-assignment, confirmation and write gates stay in force.
for name in ['app/api/approvals/route.ts','app/api/approvals/[id]/route.ts','app/api/approvals/[id]/pdf/route.ts']:
 p=root/name;s=p.read_text()
 a='authorized.isFinanceOwner && row.type === "劳务报酬"' if name=='app/api/approvals/route.ts' else 'authorized.isFinanceOwner && approval.type === "劳务报酬"'
 v='row' if name=='app/api/approvals/route.ts' else 'approval'
 s=replace(s,a,f'authorized.isFinanceOwner && ["劳务报酬", "采购审核"].includes({v}.type)')
 if name=='app/api/approvals/route.ts':s=replace(s,"${approvals.type} = '劳务报酬' OR","${approvals.type} IN ('劳务报酬', '采购审核') OR")
 p.write_text(s)
p=root/'app/page.tsx';s=p.read_text()
s=replace(s,'function PeopleView({ currentUser, canManageDepartments = false }: { currentUser?: SessionInfo["user"]; canManageDepartments?: boolean })','function PeopleView({ currentUser, canManageDepartments = false, canViewPersonnel = false }: { currentUser?: SessionInfo["user"]; canManageDepartments?: boolean; canViewPersonnel?: boolean })')
s=replace(s,'(canManageDepartments || person.email.toLowerCase() === currentEmail)','(canViewPersonnel || person.email.toLowerCase() === currentEmail)')
s=replace(s,'<PeopleView currentUser={session.user} canManageDepartments={Boolean(session.isAdmin)} />','<PeopleView currentUser={session.user} canManageDepartments={Boolean(session.isAdmin)} canViewPersonnel={Boolean(session.isAdmin || session.isFinanceOwner)} />');p.write_text(s)
# Newer production checkouts have the explicitly paired private WeCom bot.
p=root/'app/api/integrations/wecom-bot/messages/route.ts'
if p.exists():
 s=p.read_text();s=replace(s,"import { getDb } from '../../../../../db';","import { getDb, getD1Database } from '../../../../../db';\nimport { answerPersonnelQuestion } from '../../../../../lib/personnel-chat.mjs';")
 s=replace(s,'original: BotActor)', 'original: BotActor & {isFinanceOwner?: boolean})')
 s=replace(s,'current.isAdmin === original.isAdmin && current.ndaApprovalId', 'current.isAdmin === original.isAdmin && current.isFinanceOwner === Boolean(original.isFinanceOwner) && current.ndaApprovalId')
 anchor='    const imageRequest = questionRequestsKnowledgeImages(command.question);'
 s=replace(s,anchor,'''    const personnel = await answerPersonnelQuestion(await getD1Database(), actor, command.question);
    if (personnel) {
      if (!await actorStillCurrent(link, actor) || request.signal.aborted) return reply('');
      const text = personnel.answer + '\\n\\n' + personnel.personnelLinks.map(p=>p.name+'的个人主页：https://oa.omindos.cn'+p.href).join('\\n');
      if (request.headers.get('accept')?.includes('application/x-ndjson')) return new Response(
        JSON.stringify({type:'delta',text})+'\\n'+JSON.stringify({type:'done'})+'\\n',
        {headers:{...headers,'content-type':'application/x-ndjson; charset=utf-8','x-accel-buffering':'no'}});
      return reply(text);
    }
'''+anchor);p.write_text(s)
