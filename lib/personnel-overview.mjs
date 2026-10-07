import { cents } from './expense-ledger.mjs';
const parse=s=>{try{const x=JSON.parse(s);return x&&typeof x==='object'&&!Array.isArray(x)?x:{};}catch{return {};}};
const norm=s=>String(s||'').trim().toLowerCase();
const amount=n=>{try{return n===undefined||n===null||n===''?null:cents(n);}catch{return null;}};
export async function personnelOverview(db,user,billPeople) {
  const manager=Boolean(user.isAdmin||user.isFinanceOwner||user.canViewAllPersonnel);
  const members=(await db.prepare(`SELECT id,full_name,chatgpt_account,role FROM members WHERE status='active' ${manager?'':'AND id=?'} ORDER BY full_name`).bind(...(manager?[]:[user.memberId])).all()).results;
  const approvals=(await db.prepare("SELECT id,type,title,project,requester_email,status,current_step,current_reviewer_name,created_at,updated_at,payload_json FROM approvals WHERE type IN ('技术审核','采购审核','劳务报酬') ORDER BY updated_at DESC").all()).results;
  const payouts=(await db.prepare('SELECT * FROM expense_labor_payments').all()).results;
  const profiles=members.map(m=>{
    const work=[],labor=[],purchases=[];
    for(const a of approvals){const p=parse(a.payload_json),own=norm(a.requester_email)===norm(m.chatgpt_account);const developers=Array.isArray(p.developers)?p.developers:[];const developer=developers.find(d=>d&&((d.memberId&&d.memberId===m.id)||(!d.memberId&&norm(d.email)===norm(m.chatgpt_account))));
      const base={id:a.id,title:a.title,project:a.project,status:a.status,step:a.current_step,reviewer:a.current_reviewer_name,updatedAt:a.updated_at};
      if(a.type==='技术审核'&&(developer||own)){
        const ratio=developer?Number(developer.ratio):null,total=Number(p.totalWorkHours);const hours=ratio!==null&&Number.isFinite(ratio)&&ratio>=0&&ratio<=100&&Number.isFinite(total)&&total>0?Math.round(total*ratio)/100:null;
        work.push({...base,work:developer?.work||'',ratio,hours,accepted:a.status==='已归档'});
      }
      if(a.type==='采购审核'&&own)purchases.push({...base,item:String(p.itemSpec||p.itemName||''),actualAmount:p.actualAmount??null});
      if(a.type==='劳务报酬'&&own){const paid=payouts.find(x=>x.approval_id===a.id);const approvedCents=a.status==='已归档'?amount(p.finalAmount):null;const paidCents=paid?.paid_cents??null;
        labor.push({...base,month:p.month||'',statement:p.monthlyStatement||'',contributionHours:p.archivedContributionHours??null,otherHours:p.otherMonthlyWorkHours??p.monthlyWorkHours??null,totalHours:p.totalScore??null,suggestedCents:amount(p.suggestedAmount),basis:p.compensationBasis||'',approvedCents,paidCents,remainingCents:approvedCents!==null&&paidCents!==null?approvedCents-paidCents:null,paidDate:paid?.paid_date||'',reference:paid?.reference||''});}
    }
    const person=billPeople.find(p=>p.member_id===m.id);
    return {id:m.id,name:m.full_name,role:m.role,billPersonId:person?.id||'',work,labor,purchases,acceptedHours:work.filter(w=>w.accepted&&w.hours!==null).reduce((s,w)=>s+w.hours,0),acceptedWorkCount:work.filter(w=>w.accepted).length};
  });
  for(const p of billPeople.filter(p=>!p.member_id))profiles.push({id:'bill:'+p.id,name:p.bill_name,role:'unlinked',billPersonId:p.id,work:[],labor:[],purchases:[],acceptedHours:null,acceptedWorkCount:0});
  return profiles;
}
