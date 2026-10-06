import { assemble, core, LedgerError, parseAlipay, validateClaim } from './expense-ledger.mjs';
import { workflowOverview, publicWorkflow, mutateWorkflow, openDispute } from './personnel-workflow.mjs';
import { personnelOverview } from './personnel-overview.mjs';
const manager=u=>Boolean(u.isAdmin||u.isFinanceOwner);
const all=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
const stamp=()=>new Date().toISOString();
const guard='EXISTS (SELECT 1 FROM expense_ledger_meta WHERE id=1 AND revision=?) AND EXISTS (SELECT 1 FROM members WHERE id=? AND mutation_revision=? AND account_user_id=? AND status=\'active\')';
const guardValues=(u,revision)=>[revision,u.memberId,u.memberMutationRevision,u.accountUserId];
export async function loadLedger(db,user) {
  const workflow=publicWorkflow(await workflowOverview(db,user));
  const revision=(await db.prepare('SELECT revision FROM expense_ledger_meta WHERE id=1').first()).revision;
  const people=await all(db,`SELECT p.*,m.full_name member_name FROM expense_people p LEFT JOIN members m ON m.id=p.member_id ${manager(user)?'':'WHERE p.member_id=?'} ORDER BY p.bill_name`,...(manager(user)?[]:[user.memberId]));
  const peopleIds=people.map(p=>p.id);
  if(!peopleIds.length)return {workflow,revision,manager:manager(user),memberId:user.memberId,people:[],records:[],unmatchedRefunds:[],members:[],approvals:[],events:[],profiles:await personnelOverview(db,user,people)};
  const marks=peopleIds.map(()=>'?').join(',');
  const transactions=await all(db,`SELECT * FROM expense_transactions WHERE person_id IN (${marks}) ORDER BY occurred_at DESC,order_no`,...peopleIds);
  const claims=await all(db,`SELECT c.* FROM expense_claims c JOIN expense_transactions t ON t.id=c.transaction_id WHERE t.person_id IN (${marks})`,...peopleIds);
  const result=assemble(people,transactions,claims);
  const members=manager(user)?await all(db,"SELECT id,full_name FROM members WHERE status='active' ORDER BY full_name"):[];
  // Approval summaries retain the existing ownership boundary. No private payloads are joined.
  const approvals=await all(db,`SELECT id,title,project,status,current_step,current_reviewer_name,requester_name,requester_email FROM approvals WHERE type IN ('采购审核','流转审批') ${manager(user)?'':"AND lower(requester_email)=lower(?)"} ORDER BY updated_at DESC LIMIT 500`,...(manager(user)?[]:[user.user.email]));
  const events=await all(db,`SELECT e.id,e.target_id,e.action,e.actor,e.occurred_at,e.after_json FROM expense_events e JOIN expense_transactions t ON e.target_id=t.id WHERE t.person_id IN (${marks}) ORDER BY e.occurred_at DESC LIMIT 500`,...peopleIds);
  return {workflow,...result,revision,manager:manager(user),memberId:user.memberId,members,approvals,events,profiles:await personnelOverview(db,user,people)};
}
async function finish(db,statements,token,target,revision) {
  statements.push(db.prepare(`UPDATE expense_ledger_meta SET revision=revision+1 WHERE id=1 AND revision=? AND EXISTS(SELECT 1 FROM expense_events WHERE id=?)`).bind(revision,token));
  const outcomes=await db.batch(statements);
  if(outcomes.at(-1).meta.changes!==1)throw new LedgerError('账单或权限已变化，请刷新页面后重试。',409);
  return {saved:true,target};
}
export async function mutateLedger(db,user,input) {
  const revision=input.revision;
  if(!Number.isSafeInteger(revision)||revision<0)throw new LedgerError('请刷新后再操作。',409);
  const current=await loadLedger(db,user);
  if(current.revision!==revision)throw new LedgerError('账单已被更新，请刷新后再操作。',409);
  const token=crypto.randomUUID(),now=stamp(),actor=user.user.displayName;
  const auth=guardValues(user,revision);const action=input.action;
  if(action?.startsWith('work_')||action==='resolve_dispute')return mutateWorkflow(db,user,input,{current,token,now,actor,guard,auth,finish,revision});
  if(action==='labor_payment') {
    if(!manager(user))throw new LedgerError('仅管理员或经费负责人可登记劳务发放。',403);
    const record=current.profiles.flatMap(p=>p.labor).find(a=>a.id===input.id);
    if(!record||record.approvedCents===null)throw new LedgerError('需先完成劳务报酬终审，才能登记发放。');
    const paid=input.paidCents,date=typeof input.paidDate==='string'?input.paidDate:'',reference=typeof input.reference==='string'?input.reference.trim():'';
    if(!Number.isSafeInteger(paid)||paid<0||paid>record.approvedCents)throw new LedgerError('已发放金额不能超过批准金额。');
    if(paid>0&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date>new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})||!reference||reference.length>200))throw new LedgerError('请填写真实发放日期和付款依据。');
    const updated={paidCents:paid,paidDate:paid?date:'',reference};
    const statements=[db.prepare(`INSERT INTO expense_labor_payments(approval_id,paid_cents,paid_date,reference,updated_at,updated_by,mutation_token) SELECT ?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(approval_id) DO UPDATE SET paid_cents=excluded.paid_cents,paid_date=excluded.paid_date,reference=excluded.reference,updated_at=excluded.updated_at,updated_by=excluded.updated_by,mutation_token=excluded.mutation_token`).bind(record.id,paid,updated.paidDate,reference,now,actor,token,...auth),db.prepare(`INSERT INTO expense_events(id,target_id,action,actor,occurred_at,before_json,after_json) SELECT ?,?,'labor_payment',?,?,?,? WHERE EXISTS(SELECT 1 FROM expense_labor_payments WHERE approval_id=? AND mutation_token=?)`).bind(token,record.id,actor,now,JSON.stringify({paidCents:record.paidCents,paidDate:record.paidDate,reference:record.reference}),JSON.stringify(updated),record.id,token)];return finish(db,statements,token,record.id,revision,user);
  }
  if(action==='import'||action==='preview') {
    if(!manager(user))throw new LedgerError('仅管理员或经费负责人可导入。',403);
    if(typeof input.csv!=='string'||typeof input.filename!=='string'||input.filename.length>200)throw new LedgerError('文件内容不正确。');
    const parsed=parseAlipay(input.csv,current.people);
    const existing=await all(db,'SELECT * FROM expense_transactions');const indexed=new Map(existing.map(r=>[r.id,r]));
    const fresh=[];
    for(const r of parsed.transactions){const old=indexed.get(r.id);if(old&&core(old)!==core(r))throw new LedgerError('已有交易号对应不同金额或人员，请先核对原文件。',409);if(!old)fresh.push(r);}
    const preview={selectedCount:parsed.transactions.length,newCount:fresh.length,duplicateCount:parsed.transactions.length-fresh.length,ignoredCount:parsed.ignoredCount,sourceCount:parsed.sourceCount};
    if(action==='preview'||!fresh.length)return {preview,saved:action==='import'};
    const statements=[db.prepare(`INSERT INTO expense_imports(id,filename,imported_at,actor,source_count,selected_count,ignored_count) SELECT ?,?,?,?,?,?,? WHERE ${guard}`).bind(token,input.filename,now,actor,parsed.sourceCount,parsed.transactions.length,parsed.ignoredCount,...auth)];
    for(const r of fresh){statements.push(db.prepare(`INSERT INTO expense_transactions(id,order_no,merchant_order_no,person_id,kind,amount_cents,occurred_at,description,payment_method,trade_status,source_json,source_line,import_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM expense_imports WHERE id=?)`).bind(r.id,r.order_no,r.merchant_order_no,r.person_id,r.kind,r.amount_cents,r.occurred_at,r.description,r.payment_method,r.trade_status,r.source_json,r.source_line,token,token));if(r.kind==='payment')statements.push(db.prepare(`INSERT INTO expense_claims(transaction_id,updated_at,updated_by,mutation_token) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM expense_imports WHERE id=?)`).bind(r.id,now,actor,token,token));}
    statements.push(db.prepare(`INSERT INTO expense_events(id,target_id,action,actor,occurred_at,before_json,after_json) SELECT ?,?,'import',?,?,?,? WHERE EXISTS(SELECT 1 FROM expense_imports WHERE id=?)`).bind(token,token,actor,now,'{}',JSON.stringify(preview),token));
    await finish(db,statements,token,token,revision,user);return {saved:true,preview};
  }
  if(action==='bind') {
    if(!manager(user))throw new LedgerError('仅管理员或经费负责人可关联账号。',403);
    const person=current.people.find(p=>p.id===input.personId);const member=current.members.find(m=>m.id===input.memberId);
    if(!person||(!member&&input.memberId!==''))throw new LedgerError('人员或账号不存在。');
    if(current.people.some(p=>p.id!==person.id&&p.member_id===input.memberId&&input.memberId))throw new LedgerError('这个 OA 账号已经关联其他账单姓名。');
    if(person.member_id===(input.memberId||null))return {saved:true};
    const statements=[db.prepare(`UPDATE expense_people SET member_id=?,updated_at=? WHERE id=? AND ${guard}`).bind(input.memberId||null,now,person.id,...auth),db.prepare(`INSERT INTO expense_events(id,target_id,action,actor,occurred_at,before_json,after_json) SELECT ?,?,'bind',?,?,?,? WHERE changes()=1`).bind(token,person.id,actor,now,JSON.stringify({memberId:person.member_id}),JSON.stringify({memberId:input.memberId,name:member?.full_name||''}))];
    return finish(db,statements,token,person.id,revision,user);
  }
  if(action==='confirm'||action==='dispute') {
    const ids=input.ids;if(!Array.isArray(ids)||!ids.length||ids.length>500||new Set(ids).size!==ids.length)throw new LedgerError('请选择需要确认的消费记录。');
    const rows=ids.map(id=>current.records.find(r=>r.id===id));
    if(rows.some(r=>!r||current.people.find(p=>p.id===r.person_id)?.member_id!==user.memberId))throw new LedgerError('只能本人确认自己的消费记录。',403);
    if(action==='confirm'&&rows.some(r=>r.anomaly))throw new LedgerError('账单金额存在异常，请先核对退款。',409);
    const note=typeof input.note==='string'?input.note.trim():'';if(note.length>1000||(action==='dispute'&&!note))throw new LedgerError('请填写异议原因（最多 1000 字）。');
    if(action==='confirm'&&current.workflow.disputes.some(d=>d.state==='open'&&d.target_type==='expense'&&ids.includes(d.target_id)))throw new LedgerError('异议正在处理中，处理后再确认。',409);
    const statements=[];
    if(action==='dispute'){const {config}=await workflowOverview(db,user);for(const r of rows)statements.push(...await openDispute(db,user,{type:'expense',id:r.id,reason:note,token,now,guard,auth,config}));}
    rows.forEach((r,index)=>{const event=index===0?token:crypto.randomUUID();const status=action==='confirm'?'confirmed':'disputed';
      statements.push(db.prepare(`UPDATE expense_claims SET confirmation_status=?,confirmed_at=?,confirmed_by=?,confirmed_net_cents=?,confirmation_note=?,updated_at=?,updated_by=?,mutation_token=? WHERE transaction_id=? AND ${guard}`).bind(status,now,user.memberId,r.netCents,note,now,actor,token,r.id,...auth));
      statements.push(db.prepare(`INSERT INTO expense_events(id,target_id,action,actor,occurred_at,before_json,after_json) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM expense_claims WHERE transaction_id=? AND mutation_token=?)`).bind(event,r.id,action,actor,now,JSON.stringify({status:r.claim.confirmation_status}),JSON.stringify({status,netCents:r.netCents,note}),r.id,token));
    });return finish(db,statements,token,ids[0],revision,user);
  }
  if(action==='progress') {
    const record=current.records.find(r=>r.id===input.id);if(!record)throw new LedgerError('记录不存在或无权查看。',404);
    if(!record.confirmed)throw new LedgerError('请先由消费本人确认归属和金额，再填写报销进度。',409);
    const claim=validateClaim(input.claim,record.netCents);
    if(claim.approval_id&&!current.approvals.some(a=>a.id===claim.approval_id))throw new LedgerError('不能关联无权查看的 OA 申请。',403);
    const keys=Object.keys(claim);const statements=[db.prepare(`UPDATE expense_claims SET ${keys.map(k=>k+'=?').join(',')},updated_at=?,updated_by=?,mutation_token=? WHERE transaction_id=? AND ${guard}`).bind(...keys.map(k=>claim[k]),now,actor,token,record.id,...auth),db.prepare(`INSERT INTO expense_events(id,target_id,action,actor,occurred_at,before_json,after_json) SELECT ?,?,'progress',?,?,?,? WHERE EXISTS(SELECT 1 FROM expense_claims WHERE transaction_id=? AND mutation_token=?)`).bind(token,record.id,actor,now,JSON.stringify(record.claim),JSON.stringify(claim),record.id,token)];
    return finish(db,statements,token,record.id,revision,user);
  }
  throw new LedgerError('操作类型不正确。');
}
