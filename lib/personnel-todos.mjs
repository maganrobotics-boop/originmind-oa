import { loadLedger } from './expense-ledger-store.mjs';

// A task is a live view of its business record. Confirming or resolving the record
// removes it automatically; a generic task checkbox must never replace confirmation.
export function personnelTodoItems(ledger,user){
  if(!user.memberId)return [];
  const personIds=new Set(ledger.people.filter(p=>p.member_id===user.memberId).map(p=>p.id));
  const own=ledger.records.filter(r=>personIds.has(r.person_id));
  const disputed=new Set(ledger.workflow.disputes.filter(d=>d.state==='open'&&d.target_type==='expense').map(d=>d.target_id));
  const pending=own.filter(r=>!r.confirmed&&!disputed.has(r.id)&&r.claim.confirmation_status!=='disputed');
  const progress=own.filter(r=>r.confirmed&&!r.completed&&!disputed.has(r.id));
  const weekly=ledger.workflow.weekly.filter(w=>w.member_id===user.memberId&&!w.approval_id&&['draft','submitting'].includes(w.state));
  const make=(kind,title,detail,rows,dueAt=null)=>({
    id:'personnel-self-'+kind+'-'+user.memberId,project:'OriginMind × ARTS Robotics 联合研发项目',title,detail,kind:'task',status:'open',priority:'normal',
    assigneeName:user.user.displayName,assigneeEmail:user.user.email.toLowerCase(),dueAt,sourceType:'manual',sourceId:user.memberId,
    createdByName:user.user.displayName,createdByEmail:user.user.email.toLowerCase(),completedAt:null,
    createdAt:rows.map(r=>r.created_at||r.claim?.updated_at||r.updated_at||'').filter(Boolean).sort()[0]||'',
    updatedAt:rows.map(r=>r.updated_at||r.claim?.updated_at||'').filter(Boolean).sort().at(-1)||'',
  });
  const tasks=[];
  if(pending.length)tasks.push(make('expenses',`确认本人消费账单（${pending.length} 笔）`,'核对原账单、消费归属和金额；确认后由本人跟进报销，有异议可直接提交处理。',pending));
  if(weekly.length)tasks.push(make('work',`确认本人周报工作（${weekly.length} 份）`,'先核对或修改实际工作，再由本人确认并提交 OA 审核。',weekly));
  if(progress.length){const due=progress.map(r=>r.claim.expected_date).filter(Boolean).sort()[0]||null;tasks.push(make('reimbursement',`跟进本人报销（${progress.length} 笔）`,'填写当前报销环节、预计报完日期和实际到账记录。',progress,due));}
  return tasks;
}
export async function getOwnPersonnelTodos(db,user){
  // Deployments without the optional personnel migration retain existing todos.
  const ready=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='expense_ledger_meta'").first();
  if(!ready)return [];
  const scoped=await loadLedger(db,{...user,isAdmin:false,isFinanceOwner:false});
  return personnelTodoItems(scoped,user);
}
