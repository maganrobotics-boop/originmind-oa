import { getReviewPolicy, technicalRoute } from './review-routing.mjs';
import { LedgerError } from './expense-ledger.mjs';
const all=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
const obj=s=>{try{return JSON.parse(s||'{}');}catch{return {};}};
const manager=u=>Boolean(u.isAdmin||u.isFinanceOwner);
const text=(value,max,label)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new LedgerError(`请填写${label}（最多 ${max} 字）。`);return value.trim();};
export async function workflowOverview(db,user){
  const config=await db.prepare(`SELECT c.*,r.full_name reviewer_name,r.status reviewer_status,r.account_user_id reviewer_account,r.nda_accepted_at reviewer_nda,r.chatgpt_account reviewer_email,o.full_name owner_name,o.status owner_status,o.chatgpt_account owner_email,o.account_user_id owner_account FROM personnel_workflow_config c JOIN members r ON r.id=c.reviewer_member_id JOIN members o ON o.id=c.dispute_owner_member_id WHERE c.id=1`).first();
  const policy=await getReviewPolicy(db);
  const isOwner=user.memberId===config?.dispute_owner_member_id;
  const weekly=await all(db,`SELECT w.*,m.full_name member_name,a.id approval_id,a.status approval_status,a.current_step,a.current_reviewer_name,a.payload_json FROM personnel_weekly_entries w JOIN members m ON m.id=w.member_id LEFT JOIN approvals a ON a.client_creation_key=w.client_key AND lower(a.requester_email)=lower(m.chatgpt_account) ${manager(user)||user.canViewAllPersonnel?'':'WHERE w.member_id=?'} ORDER BY w.updated_at DESC`,...(manager(user)||user.canViewAllPersonnel?[]:[user.memberId]));
  for(const w of weekly){const p=obj(w.payload_json);const reviewers=Array.isArray(p.circulationApprovers)?p.circulationApprovers:[],decisions=Array.isArray(p.circulationApprovals)?p.circulationApprovals:[];w.accepted=w.approval_status==='已归档'&&reviewers.length===1&&reviewers[0].memberId===config?.reviewer_member_id&&reviewers[0].accountUserId===config?.reviewer_account&&decisions.some(d=>d.memberId===config?.reviewer_member_id&&d.accountUserId===config?.reviewer_account);if(policy){const valid=d=>technicalRoute(policy).some(r=>r.memberId===d.memberId&&r.accountUserId===d.accountUserId);w.accepted=w.approval_status==='已归档'&&p.technicalWeekly===true&&p.circulationAnyTechnical===true&&decisions.every(valid)&&decisions.some(d=>policy.technical.some(t=>t.memberId===d.memberId&&t.accountUserId===d.accountUserId))&&decisions.some(d=>d.memberId===policy.owner.memberId&&d.accountUserId===policy.owner.accountUserId);}w.submittedContent=typeof p.circulationContent==='string'?p.circulationContent:'';delete w.payload_json;delete w.mutation_token;}
  // Sources are visible only to their actual submitting account; they are suggestions until confirmed.
  const sources=await all(db,`SELECT 'knowledge:'||r.id id,i.title,r.content,'资料库周报' kind FROM knowledge_items i JOIN knowledge_revisions r ON r.id=i.current_revision_id WHERE i.submitter_member_id=? AND i.revoked_at IS NULL AND (i.title LIKE '%周报%' OR i.category LIKE '%周报%') UNION ALL SELECT 'ai:'||id,title,result,'AI 周报草稿' kind FROM ai_workbench_tasks WHERE member_id=? AND account_user_id=? AND kind='weekly_report' AND status='succeeded' AND result<>'' LIMIT 100`,user.memberId,user.memberId,user.accountUserId);
  const disputes=await all(db,`SELECT d.*,m.full_name member_name,o.full_name assignee_name FROM personnel_disputes d JOIN members m ON m.id=d.member_id JOIN members o ON o.id=d.assignee_member_id ${manager(user)||isOwner?'':'WHERE d.member_id=?'} ORDER BY d.state DESC,d.created_at DESC`,...(manager(user)||isOwner?[]:[user.memberId]));
  return {weekly,sources,disputes,isDisputeOwner:isOwner,reviewerName:policy?policy.technical.map(p=>p.name).join(' / ')+'（任一人） → '+policy.owner.name:config?.reviewer_name||'',disputeOwnerName:config?.owner_name||'',config};
}
export function publicWorkflow(w){const {config,...rest}=w;void config;return rest;}
export async function openDispute(db,user,{type,id,reason,token,now,guard,auth,config}){
  if(!config||config.owner_status!=='active'||!config.owner_account)throw new LedgerError('异议处理人账号暂不可用，请联系管理员。',409);
  if(await db.prepare("SELECT id FROM personnel_disputes WHERE target_type=? AND target_id=? AND state='open'").bind(type,id).first())throw new LedgerError('已有异议正在处理，请等待处理结果。',409);
  const disputeId=crypto.randomUUID();
  return [db.prepare(`INSERT INTO personnel_disputes(id,target_type,target_id,member_id,assignee_member_id,reason,created_at,mutation_token) SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`).bind(disputeId,type,id,user.memberId,config.dispute_owner_member_id,reason,now,token,...auth),
    db.prepare(`INSERT INTO project_work_items(id,project,title,detail,kind,status,priority,assignee_name,assignee_email,source_type,source_id,source_key,created_by_name,created_by_email,created_at,updated_at) SELECT ?,?,'人员记录异议待处理',?,'task','open','high',?,?,'manual',?,?,?, ?,?,? WHERE EXISTS(SELECT 1 FROM personnel_disputes WHERE id=? AND mutation_token=?)`).bind('personnel-'+disputeId,'OriginMind × ARTS Robotics 联合研发项目','请在人员工作台的“我的异议待办”查看原始记录并处理：https://oa.omindos.cn/people-workbench?disputes=1',config.owner_name,config.owner_email,disputeId,'personnel-dispute:'+disputeId,user.user.displayName,user.user.email,now,now,disputeId,token)];
}
export async function mutateWorkflow(db,user,input,c){
  const {current,token,now,actor,guard,auth,finish,revision}=c,action=input.action;
  const workflow=await workflowOverview(db,user),config=workflow.config;
  const audit=(target,action,before,after)=>db.prepare(`INSERT INTO expense_events(id,target_id,action,actor,occurred_at,before_json,after_json) SELECT ?,?,?,?,?,?,? WHERE ${guard}`).bind(token,target,action,actor,now,JSON.stringify(before),JSON.stringify(after),...auth);
  if(action==='resolve_dispute'){
    const d=workflow.disputes.find(d=>d.id===input.id&&d.state==='open');
    if(!d||d.assignee_member_id!==user.memberId)throw new LedgerError('仅指定异议处理人可处理这条待办。',403);
    const resolution=text(input.resolution,1500,'处理意见');
    const statements=[db.prepare(`UPDATE personnel_disputes SET state='resolved',resolution=?,resolved_at=?,resolved_by=?,mutation_token=? WHERE id=? AND state='open' AND ${guard}`).bind(resolution,now,actor,token,d.id,...auth),
      db.prepare(`UPDATE project_work_items SET status='done',completed_at=?,updated_at=? WHERE source_key=? AND EXISTS(SELECT 1 FROM personnel_disputes WHERE id=? AND mutation_token=?)`).bind(now,now,'personnel-dispute:'+d.id,d.id,token)];
    if(d.target_type==='expense')statements.push(db.prepare(`UPDATE expense_claims SET confirmation_status='pending',confirmed_at='',confirmed_by='',confirmed_net_cents=NULL,confirmation_note=?,updated_at=?,updated_by=?,mutation_token=? WHERE transaction_id=? AND ${guard}`).bind('处理意见：'+resolution,now,actor,token,d.target_id,...auth));
    else statements.push(db.prepare(`UPDATE personnel_weekly_entries SET state='draft',updated_at=?,mutation_token=? WHERE id=? AND ${guard}`).bind(now,token,d.target_id,...auth));
    statements.push(audit(d.target_id,'resolve_dispute',{reason:d.reason},{resolution,returnedToMember:true}));return finish(db,statements,token,d.id,revision,user);
  }
  if(action==='work_create'){
    const memberId=manager(user)?input.memberId:user.memberId;
    if(!current.profiles.some(p=>p.id===memberId))throw new LedgerError('人员不存在或无权导入。',403);
    const source=input.sourceId?workflow.sources.find(s=>s.id===input.sourceId):null;
    if(input.sourceId&&(!source||memberId!==user.memberId))throw new LedgerError('只能同步本人提交的周报。',403);
    const sourceText=text(source?.content||input.sourceText,20000,'周报原文'),title=text(source?.title||input.title,150,'周报标题');
    const id=crypto.randomUUID(),sourceKey=source?.id||'manual:'+id;
    if(await db.prepare('SELECT id FROM personnel_weekly_entries WHERE member_id=? AND source_key=?').bind(memberId,sourceKey).first())throw new LedgerError('这份周报版本已经同步，请打开已有记录。',409);
    const statements=[db.prepare(`INSERT INTO personnel_weekly_entries(id,member_id,source_key,source_title,source_text,title,content,client_key,created_at,updated_at,mutation_token) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}`).bind(id,memberId,sourceKey,title,sourceText,title,sourceText.length<=3500?sourceText:'','weekly-'+id,now,now,token,...auth),audit(id,'work_create',{}, {memberId,title,sourceKey})];
    return finish(db,statements,token,id,revision,user);
  }
  const w=workflow.weekly.find(w=>w.id===input.id);
  if(!w||w.member_id!==user.memberId)throw new LedgerError('只能本人修改、确认或提出工作异议。',403);
  if(w.approval_id)throw new LedgerError('已提交 OA，请从原申请查看审核、退回和修改。',409);
  if(action==='work_dispute'){
    if(w.state==='submitting')throw new LedgerError('提交中的内容暂不能修改，请先完成重试。',409);
    const reason=text(input.reason,1000,'异议原因');
    const statements=await openDispute(db,user,{type:'work',id:w.id,reason,token,now,guard,auth,config});
    statements.push(db.prepare(`UPDATE personnel_weekly_entries SET state='disputed',updated_at=?,mutation_token=? WHERE id=? AND ${guard}`).bind(now,token,w.id,...auth),audit(w.id,action,{}, {reason}));return finish(db,statements,token,w.id,revision,user);
  }
  if(!['work_save','work_submit'].includes(action))throw new LedgerError('操作类型不正确。');
  if(w.state==='disputed')throw new LedgerError('异议处理中，请等待处理后再确认。',409);
  if(action==='work_save'&&w.state!=='draft')throw new LedgerError('提交中的内容已锁定，请重试提交。',409);
  const title=w.state==='submitting'?w.title:text(input.title,150,'工作标题'),content=w.state==='submitting'?w.content:text(input.content,3500,'本人工作内容');
  if(action==='work_submit'&&(!config||config.reviewer_status!=='active'||!config.reviewer_account||!config.reviewer_nda))throw new LedgerError('工作审核人账号暂不可用，请联系管理员。',409);

  const policy=await getReviewPolicy(db);
  const route=policy?technicalRoute(policy).filter(p=>p.memberId===policy.owner.memberId||p.memberId!==user.memberId):[{memberId:config.reviewer_member_id}];
  if(action==='work_submit'&&policy&&policy.owner.memberId===user.memberId)throw new LedgerError('不能审核自己的工作，请安排独立负责人。',409);
  const state=action==='work_submit'?'submitting':'draft';
  const statements=[db.prepare(`UPDATE personnel_weekly_entries SET title=?,content=?,state=?,confirmed_at=?,updated_at=?,mutation_token=? WHERE id=? AND ${guard}`).bind(title,content,state,action==='work_submit'?now:'',now,token,w.id,...auth),audit(w.id,action,{title:w.title,content:w.content},{title,content})];
  await finish(db,statements,token,w.id,revision,user);
  return {saved:true,target:w.id,...(action==='work_submit'?{nativeApproval:{id:w.client_key,type:'流转审批',title:'周报工作确认：'+title,summary:'本人已核对并确认工作内容，请指定审核人审核。',payload:{circulationContent:content,circulationRecipients:[],circulationApprovers:route}}}:{})};
}
