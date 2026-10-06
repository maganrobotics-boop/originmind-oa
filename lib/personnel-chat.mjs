import { loadLedger } from './expense-ledger-store.mjs';
import { LedgerError, STAGES } from './expense-ledger.mjs';

const clean = (value, limit=160) => String(value || '').replace(/[\r\n\t]+/gu,' ').replace(/[<>`\[\]*]/gu,'').trim().slice(0,limit);
const money = n => (Number(n || 0)/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})+' 元';
const link = id => '/people-workbench' + (id ? '?person='+encodeURIComponent(id)+'&tab=work' : '');
const reply = (answer, profiles=[]) => ({answer,mode:'personnel',sourceType:'oa_personnel_records',citations:[],images:[],personnelLinks:profiles.map(p=>({name:clean(p.name),href:link(p.id)}))});
const subjectIntent = /工作|做了|干了|负责|买|购买|消费|花了|花费|报销|账|贡献|绩效|报酬|工资|发钱|信息|情况|介绍|怎么样|个人主页|成员|人员/;
function matches(question, ledger) {
  const found = [];
  for (const p of ledger.profiles) {
    const person = ledger.people.find(x=>x.id===p.billPersonId);
    const names = [...new Set([p.name,person?.bill_name].filter(n=>typeof n==='string'&&n.length>=2))];
    const name = names.sort((a,b)=>b.length-a.length).find(n=>question.includes(n));
    if (name) found.push({p,name});
  }
  // A short alias contained inside a full name must not select someone else.
  return found.filter(x=>!found.some(y=>y.p.id!==x.p.id&&y.name.length>x.name.length&&y.name.includes(x.name))).map(x=>x.p);
}
function workParagraph(profile, ledger) {
  const weekly = ledger.workflow.weekly.filter(w=>w.member_id===profile.id);
  const entries = weekly.map(w=>({date:w.updated_at,text:`${clean(w.title,60)}：${clean(w.submittedContent||w.content,180)||'工作内容待补充'}（${w.accepted?'指定审核人已通过':w.state==='disputed'?'异议处理中':w.approval_id?clean(w.approval_status)+' · '+clean(w.current_step):'待本人确认'}）`}))
    .concat(profile.work.map(w=>({date:w.updatedAt,text:`${clean(w.title,60)}${w.work?'：'+clean(w.work,180):''}（${w.accepted?'技术成果已归档':clean(w.status)+' · '+clean(w.step)}）`})))
    .sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  return '做了什么工作：'+(entries.length ? `已记录 ${entries.length} 项，最近${Math.min(entries.length,3)}项为：${entries.slice(0,3).map(w=>w.text).join('；')}。` : '目前还没有同步到本人周报或技术成果记录，具体工作待补充，不能据此判断没有开展工作。');
}
function expenseParagraph(profile, ledger) {
  const person = ledger.people.find(p=>p.id===profile.billPersonId), rows=ledger.records.filter(r=>r.person_id===profile.billPersonId);
  let text='买了什么及报销进度：';
  if (!person || !rows.length) text+='当前未录入消费账单。';
  else {
    const dates=rows.map(r=>r.occurred_at.slice(0,10)).sort();
    text+=`已入库账单期间 ${dates[0]} 至 ${dates.at(-1)}，共 ${rows.length} 笔支出，扣除退款后 ${money(person.netCents)}。`;
    const stages = new Map();
    for(const r of rows) {const stage=r.anomaly?'金额待核对':r.claim.confirmation_status==='disputed'?'异议处理中':!r.confirmed?'待本人确认':r.netCents===0?'已全额退款':STAGES[r.claim.stage]||'待填写';stages.set(stage,(stages.get(stage)||0)+1);}
    text+=[...stages].map(([k,n])=>k+' '+n+' 笔').join('，')+'。';
    const purposes=[...new Set(rows.filter(r=>r.confirmed&&r.claim.note).map(r=>clean(r.claim.note,100)))];
    text+=purposes.length?'已填写的用途或跟进说明：'+purposes.slice(0,3).join('；')+'。':'购买的具体物品和用途尚待本人补充，亲情卡／代付记录不能直接说明买了什么。';
    text+=`按到账凭证已登记 ${money(person.reimbursedCents)}，本人填报“已报销”的记录仍保留供财务核对。`;
    text+=person.openCount?(person.expectedDate?`未完结记录填报的最晚预计完成日期为 ${person.expectedDate}，以实际到账为准。`:`还有 ${person.openCount} 笔未完结，预计报完日期尚未填齐。`):'已录入记录均已完成或无需报销。';
    if(person.unmatchedRefundCount)text+='存在未匹配退款，请回原始账单核对。';
    if(!person.member_id)text+='该账单姓名尚未绑定 OA 账号，需先核对身份。';
  }
  if(profile.purchases.length) text+='采购申请：'+profile.purchases.slice(0,3).map(p=>`${clean(p.item||p.title,80)}（${clean(p.status)} · ${clean(p.step)}）`).join('；')+'。';
  return text;
}
function contributionParagraph(profile,ledger) {
  const approvedWeekly=ledger.workflow.weekly.filter(w=>w.member_id===profile.id&&w.accepted);
  let text='贡献、绩效与报酬：';
  if(profile.acceptedWorkCount||approvedWeekly.length)text+=`已有 ${profile.acceptedWorkCount} 项归档技术成果、${approvedWeekly.length} 份已审核周报工作。`;
  else text+='目前没有已审核归档的贡献记录，贡献和绩效待确认。';
  if(profile.acceptedWorkCount)text+=`按技术审核登记的分工占比计算，已核定贡献工时 ${profile.acceptedHours} 小时。`;
  if(!profile.labor.length) return text+'尚无劳务报酬申请，当前无法确定应发和已发金额。';
  text+='报酬记录：'+profile.labor.slice(0,3).map(l=>`${clean(l.month||l.title,50)}，${l.approvedCents===null?'尚未终审定额（'+clean(l.status)+' · '+clean(l.step)+'）':'已批准 '+money(l.approvedCents)}，${l.paidCents===null?'实际发放未登记':'已登记发放 '+money(l.paidCents)}${l.remainingCents!==null?'，待发 '+money(l.remainingCents):''}`).join('；')+'。';
  return text;
}
export function personnelAnswer(ledger,user,question,history=[]) {
  const q=String(question).normalize('NFKC').trim();
  const explicit=/^(?:[@/＠]成员|查看成员|成员信息|人员信息|个人情况|人员列表|我的人员|财务台账)/u.test(q);
  let selected=matches(q,ledger);
  if(!selected.length&&/^(?:我|本人)(?:的|最近|做|买|花|有)/u.test(q)&&subjectIntent.test(q)) selected=ledger.profiles.filter(p=>p.id===user.memberId);
  if(!selected.length&&/^(?:他|她|那他|那她|这个人|那个人)/u.test(q)&&subjectIntent.test(q)) {
    for(const h of [...history].reverse()){const candidates=matches(h.content,ledger);if(candidates.length===1){selected=candidates;break;}}
  }
  if(!explicit&&!selected.length)return null;
  if(selected.length&&!subjectIntent.test(q)&&!selected.some(p=>q===p.name||q===ledger.people.find(x=>x.id===p.billPersonId)?.bill_name))return null;
  if(!selected.length) {
    const list=ledger.profiles.filter(p=>p.billPersonId);
    return reply('请告诉我成员的完整姓名。你可查看的账单人员有：'+(list.map(p=>clean(p.name)).join('、')||'暂无')+'。我会按工作、消费报销、贡献与报酬三部分回答；也可以打开人员列表查看。',list);
  }
  if(selected.length>1)return reply('问题涉及多位或同名成员，请点个人主页核对，或每次指定一位成员。',selected);
  const p=selected[0];
  return reply(`${clean(p.name)}的个人情况（按当前已入 OA 的全部记录汇总）：\n\n${workParagraph(p,ledger)}\n\n${expenseParagraph(p,ledger)}\n\n${contributionParagraph(p,ledger)}\n\n可在个人主页查看原始账单、工作记录和审批进度。`,[p]);
}
export async function answerPersonnelQuestion(db,user,question,history=[]) {
  if(!user.ndaCompleted||!user.memberId||!user.accountUserId||!user.memberMutationRevision)return null;
  if(!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='expense_ledger_meta'").first())return null;
  const active=await db.prepare("SELECT 1 FROM members WHERE id=? AND account_user_id=? AND mutation_revision=? AND status='active'").bind(user.memberId,user.accountUserId,user.memberMutationRevision).first();
  if(!active)throw new LedgerError('人员权限已变化，请刷新后重试。',403);
  const ledger=await loadLedger(db,user);
  return personnelAnswer(ledger,user,question,history);
}
