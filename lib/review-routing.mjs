import { LedgerError, assemble, validateClaim } from './expense-ledger.mjs';
const all=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
const obj=s=>{try{return JSON.parse(s);}catch{throw new LedgerError('审核流程配置无效，请联系管理员。',409);}};
export async function getReviewPolicy(db){
  if(!await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='oa_review_policy'").first())return null;
  const row=await db.prepare('SELECT * FROM oa_review_policy WHERE id=1').first();if(!row)return null;
  const technical=obj(row.technical_json),finance=obj(row.finance_json),owner=obj(row.owner_json);
  if(!Array.isArray(technical)||technical.length!==2)throw new LedgerError('需配置两位技术审核人。',409);
  const selected=[...technical,finance,owner];
  if(new Set(selected.map(x=>x.memberId)).size!==4)throw new LedgerError('各审核岗位必须使用独立账号。',409);
  const people=[];
  for(const p of selected){
    const m=await db.prepare("SELECT * FROM members WHERE id=? AND status='active'").bind(p.memberId).first();
    if(!m||!m.nda_accepted_at||m.account_user_id!==p.accountUserId||!m.account_user_id||m.chatgpt_account.toLowerCase()!==p.email?.toLowerCase())throw new LedgerError('指定审核人账号或身份已变化，请管理员核对。',409);
    people.push({memberId:m.id,accountUserId:m.account_user_id,email:m.chatgpt_account.toLowerCase(),name:m.full_name});
  }
  return {technical:people.slice(0,2),finance:people[2],owner:people[3]};
}
export const policyActor=(person,user)=>Boolean(person&&person.memberId===user.memberId&&person.accountUserId===user.accountUserId&&person.email===user.user.email.toLowerCase());
export const technicalRoute=policy=>[...policy.technical,policy.owner];
export function technicalParticipant(payload,email){return Array.isArray(payload.fixedReviewRoute)&&payload.fixedReviewRoute.some(p=>p.email===email?.toLowerCase());}
export function technicalPendingForEmail(payload,step,email){
  if(step!=='技术顾问'||!Array.isArray(payload.fixedReviewRoute)||!Array.isArray(payload.fixedReviewApprovals)||payload.fixedReviewApprovals.length)return false;
  const reviewers=payload.fixedReviewRoute.slice(0,-1),developers=Array.isArray(payload.developers)?payload.developers:[];
  return reviewers.some(p=>p.email===email?.toLowerCase()&&p.email!==payload.routingRequesterEmail&&!developers.some(d=>d.memberId===p.memberId||d.email===p.email));
}
export function fixedTechnicalPayload(payload,policy,requesterEmail){
  if(!policy)return payload;
  const route=technicalRoute(policy),developers=Array.isArray(payload.developers)?payload.developers:[];
  const eligible=policy.technical.filter(p=>p.email!==requesterEmail&&!developers.some(d=>d.memberId===p.memberId||d.email===p.email));
  if(!eligible.length||policy.owner.email===requesterEmail||developers.some(d=>d.memberId===policy.owner.memberId||d.email===policy.owner.email))throw new LedgerError('需由独立技术审核人及负责人审核，不能审核自己的工作。',409);
  return {...payload,routingRequesterEmail:requesterEmail,fixedReviewRoute:route,fixedReviewApprovals:[],initialReviewerEmail:eligible[0].email,initialReviewerName:eligible.map(p=>p.name).join(' / ')+'（任一人）'};
}
export function technicalReviewState(payload,policy){
  const route=technicalRoute(policy),stored=payload.fixedReviewRoute,decisions=payload.fixedReviewApprovals;
  const developers=Array.isArray(payload.developers)?payload.developers:[];
  const eligible=policy.technical.filter(p=>p.email!==payload.routingRequesterEmail&&!developers.some(d=>d.memberId===p.memberId||d.email===p.email));
  if(!Array.isArray(stored)||stored.length!==route.length||stored.some((p,i)=>p.memberId!==route[i].memberId||p.accountUserId!==route[i].accountUserId||p.email!==route[i].email)||!Array.isArray(decisions)||decisions.length>2||!eligible.length||decisions.some((p,i)=>!(i===0?eligible:[policy.owner]).some(r=>p.memberId===r.memberId&&p.accountUserId===r.accountUserId&&p.email===r.email)||!p.confirmedAt))throw new LedgerError('技术审核路线已调整，请申请人修改后重新提交。',409);
  const pendingPeople=decisions.length===0?eligible:decisions.length===1?[policy.owner]:[];
  return {route,decisions,pending:pendingPeople[0],pendingPeople};
}
export function advanceTechnicalReview(payload,policy,user,now,note=''){
  const {decisions,pendingPeople}=technicalReviewState(payload,policy),pending=pendingPeople.find(p=>policyActor(p,user));
  if(!policyActor(pending,user))throw new LedgerError('须由当前指定审核人本人处理，不能跳过前序审核。',403);
  const next=[...decisions,{...pending,confirmedAt:now,note}];
  return {payload:{...payload,fixedReviewApprovals:next,initialReviewerEmail:next[0].email,initialReviewerName:next[0].name},next:next.length===1?policy.owner:null,step:next.length===2?'已归档':'项目负责人'};
}
export function reviewBasis(record){return JSON.stringify([record.id,record.person_id,record.netCents,record.claim.project_name,record.claim.approval_id,record.claim.note,record.claim.confirmed_by,record.claim.confirmed_net_cents]);}
export function hasFullSettlement(record){
  if(!record.confirmed||record.anomaly||record.claim.confirmation_status==='disputed')return false;
  if(record.netCents===0)return true;
  if(record.claim.stage!=='settled'||record.claim.reimbursed_cents!==record.netCents)return false;
  try{validateClaim(Object.fromEntries(['stage','project_name','approval_id','expected_date','submitted_date','received_date','reimbursed_cents','reference','note','handler'].map(k=>[k,record.claim[k]])),record.netCents);return true;}catch{return false;}
}
export function reviewState(record,row,policy){
  const basis=reviewBasis(record),current=row?.basis===basis;
  const finance=current&&row.finance_by===policy.finance.accountUserId&&Boolean(row.finance_at);
  const owner=finance&&row.owner_by===policy.owner.accountUserId&&Boolean(row.owner_at);
  const archived=owner&&Boolean(row.archived_at)&&hasFullSettlement(record);
  return {state:archived?'archived':!record.confirmed?'confirmation':!finance?'finance':!owner?'owner':'payment',financeAt:finance?row.finance_at:'',ownerAt:owner?row.owner_at:'',archivedAt:archived?row.archived_at:'',returnNote:row?.return_note||'',canArchive:owner&&hasFullSettlement(record),locked:Boolean(row?.archived_at)};
}
export async function expenseReviewOverview(db,records,user,policy){
  if(!policy)return {records,reviewPolicy:null};
  const reviews=await all(db,'SELECT * FROM expense_reviews');
  return {records:records.map(r=>{const review=reviewState(r,reviews.find(v=>v.transaction_id===r.id),policy);return {...r,review,completed:review.state==='archived'};}),reviewPolicy:{technicalNames:policy.technical.map(p=>p.name),financeName:policy.finance.name,ownerName:policy.owner.name,isFinance:policyActor(policy.finance,user),isOwner:policyActor(policy.owner,user)}};
}
export async function assertPurchaseSettled(db,approvalId,actualAmount){
  const tx=await all(db,'SELECT * FROM expense_transactions'),people=await all(db,'SELECT * FROM expense_people'),claims=await all(db,'SELECT * FROM expense_claims');
  const data=assemble(people,tx,claims),rows=data.records.filter(r=>r.claim.approval_id===approvalId);
  const amount=Math.round(Number(actualAmount)*100);
  if(!Number.isSafeInteger(amount)||amount<0)throw new LedgerError('实际采购金额无效，不能归档。',409);
  if(amount>0&&(!rows.length||rows.some(r=>!hasFullSettlement(r))||rows.reduce((s,r)=>s+r.netCents,0)!==amount))throw new LedgerError('请在人员工作台关联本申请的全部账单，核对净额并登记全额到账；未全部报销完成不能归档。',409);
  if(amount===0&&rows.some(r=>!hasFullSettlement(r)||r.netCents!==0))throw new LedgerError('关联账单仍未结清，不能归档。',409);
  if(rows.length){const marks=rows.map(()=>'?').join(',');if(await db.prepare(`SELECT id FROM personnel_disputes WHERE state='open' AND target_type='expense' AND target_id IN (${marks})`).bind(...rows.map(r=>r.id)).first())throw new LedgerError('仍有账单问题未处理，不能归档。',409);}
  return rows.map(r=>({id:r.id,netCents:r.netCents,receivedDate:r.claim.received_date,reference:r.claim.reference}));
}
export async function mutateExpenseReview(db,user,input,c){
  const {current,token,now,actor,guard,auth,finish,revision}=c,policy=await getReviewPolicy(db);
  if(!policy)throw new LedgerError('审核流程尚未配置。',409);
  const finance=policyActor(policy.finance,user),owner=policyActor(policy.owner,user),action=input.action;
  if(action==='review_finance'&&!finance||action==='review_owner'&&!owner||action==='review_archive'&&!finance&&!owner||action==='review_return'&&!finance&&!owner)throw new LedgerError('仅当前指定审核人本人可以处理。',403);
  if(!['review_finance','review_owner','review_archive','review_return'].includes(action))throw new LedgerError('审核操作无效。');
  const ids=action==='review_archive'?current.records.filter(r=>r.person_id===input.personId).map(r=>r.id):input.ids;
  if(!Array.isArray(ids)||!ids.length||ids.length>500||new Set(ids).size!==ids.length)throw new LedgerError('请选择需要审核的记录。');
  let rows=ids.map(id=>current.records.find(r=>r.id===id));
  if(rows.some(r=>!r))throw new LedgerError('记录不存在或无权查看。',404);
  const note=typeof input.note==='string'?input.note.trim():'';
  if(note.length>1000||action==='review_return'&&!note)throw new LedgerError('退回时请说明具体问题，最多 1000 字。');
  if(action!=='review_archive'&&rows.some(r=>r.review?.locked))throw new LedgerError('已归档记录不能重复修改。',409);
  if(action!=='review_return'&&rows.some(r=>!r.confirmed||r.anomaly||current.workflow.disputes.some(d=>d.state==='open'&&d.target_type==='expense'&&d.target_id===r.id)))throw new LedgerError('请先完成本人确认并处理全部问题，再审核。',409);
  if(action==='review_finance'&&rows.some(r=>r.review?.state!=='finance'))throw new LedgerError('当前记录不在财务审核节点，请刷新。',409);
  if(action==='review_owner'&&rows.some(r=>r.review?.state!=='owner'))throw new LedgerError('必须先经财务审核通过，再交负责人审核。',409);
  if(action==='review_archive'&&current.unmatchedRefunds.some(r=>r.person_id===input.personId))throw new LedgerError('仍有退款未匹配原支出，请先核对后归档。',409);
  if(action==='review_archive'&&rows.some(r=>!r.review?.canArchive))throw new LedgerError('此人的全部账单须经财务和负责人审核、全额报销到账且无未处理问题后，才能归档。',409);
  if(action==='review_archive')rows=rows.filter(r=>!r.review?.locked);
  if(!rows.length)throw new LedgerError('这些记录已经归档。',409);
  const statements=[];
  for(const [i,r] of rows.entries()){
    const previous=await db.prepare('SELECT * FROM expense_reviews WHERE transaction_id=?').bind(r.id).first();
    const next={basis:reviewBasis(r),finance_at:previous?.finance_at||'',finance_by:previous?.finance_by||'',owner_at:previous?.owner_at||'',owner_by:previous?.owner_by||'',archived_at:'',archived_by:'',return_note:''};
    if(action==='review_finance')Object.assign(next,{finance_at:now,finance_by:user.accountUserId,owner_at:'',owner_by:''});
    if(action==='review_owner')Object.assign(next,{owner_at:now,owner_by:user.accountUserId});
    if(action==='review_return')Object.assign(next,{finance_at:'',finance_by:'',owner_at:'',owner_by:'',return_note:note});
    if(action==='review_archive')Object.assign(next,{archived_at:now,archived_by:user.accountUserId});
    const keys=Object.keys(next),event=i===0?token:crypto.randomUUID();
    statements.push(db.prepare(`INSERT INTO expense_reviews(transaction_id,${keys.join(',')},mutation_token) SELECT ?,${keys.map(()=>'?').join(',')},? WHERE ${guard} ON CONFLICT(transaction_id) DO UPDATE SET ${keys.map(k=>k+'=excluded.'+k).join(',')},mutation_token=excluded.mutation_token`).bind(r.id,...keys.map(k=>next[k]),token,...auth));
    statements.push(db.prepare(`INSERT INTO expense_events(id,target_id,action,actor,occurred_at,before_json,after_json) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM expense_reviews WHERE transaction_id=? AND mutation_token=?)`).bind(event,r.id,action,actor,now,JSON.stringify(previous||{}),JSON.stringify({...next,note}),r.id,token));
  }
  return finish(db,statements,token,ids[0],revision,user);
}
