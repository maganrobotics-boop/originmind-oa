import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { assemble,parseAlipay,validateClaim } from '../lib/expense-ledger.mjs';
import { loadLedger,mutateLedger } from '../lib/expense-ledger-store.mjs';
const header='交易时间,交易分类,交易对方,商品说明,收/支,金额,交易订单号,商家订单号,交易状态,收/付款方式,';
const csv=header+'\n2026-09-01 10:00:00,亲友代付,测试甲,亲情卡,支出,100.00,payment0000001,merchant001,支付成功,信用卡,\n2026-09-02 10:00:00,退款,测试甲,退款-亲情卡,不计收支,20.00,refund0000001,merchant001,退款成功,信用卡,\n2026-09-01 10:00:00,餐饮,非目标人员,个人消费,支出,60.00,payment0000009,other,支付成功,余额,\n';
function fixture(){
  const raw=new DatabaseSync(':memory:');raw.exec(`
  CREATE TABLE members(id TEXT PRIMARY KEY,full_name TEXT,chatgpt_account TEXT,role TEXT,status TEXT,mutation_revision TEXT,account_user_id TEXT,nda_accepted_at TEXT);
  CREATE TABLE approvals(id TEXT PRIMARY KEY,type TEXT,title TEXT,project TEXT,requester_email TEXT,requester_name TEXT,status TEXT,current_step TEXT,current_reviewer_name TEXT,created_at TEXT,updated_at TEXT,payload_json TEXT,client_creation_key TEXT);
  CREATE TABLE knowledge_items(id TEXT,title TEXT,category TEXT,submitter_member_id TEXT,revoked_at TEXT,current_revision_id TEXT);
  CREATE TABLE knowledge_revisions(id TEXT,content TEXT);
  CREATE TABLE ai_workbench_tasks(id TEXT,title TEXT,result TEXT,member_id TEXT,account_user_id TEXT,kind TEXT,status TEXT);
  CREATE TABLE project_work_items(id TEXT PRIMARY KEY,project TEXT,title TEXT,detail TEXT,kind TEXT,status TEXT,priority TEXT,assignee_name TEXT,assignee_email TEXT,source_type TEXT,source_id TEXT,source_key TEXT UNIQUE,created_by_name TEXT,created_by_email TEXT,created_at TEXT,updated_at TEXT,completed_at TEXT);
  `);raw.exec(readFileSync(new URL('../migrations/expense-ledger-20261007.sql',import.meta.url),'utf8'));
  for(const [id,name] of [['admin','管理测试'],['reviewer','审核测试'],['member','测试甲'],['other','测试乙']])raw.prepare("INSERT INTO members VALUES(?,?,?,'member','active','v1',?,'2026-01-01')").run(id,name,id+'@test.invalid','account:'+id);
  raw.exec("INSERT INTO personnel_workflow_config VALUES(1,'reviewer','admin');INSERT INTO expense_people VALUES('person','测试甲','member','now','now')");
  function prep(sql){let args=[];return {bind(...values){args=values;return this;},async all(){return {results:raw.prepare(sql).all(...args)};},async first(){return raw.prepare(sql).get(...args)||null;},async run(){return {meta:{changes:Number(raw.prepare(sql).run(...args).changes)}};}};}
  const db={prepare:prep,async batch(statements){raw.exec('BEGIN IMMEDIATE');try{const results=[];for(const s of statements)results.push(await s.run());raw.exec('COMMIT');return results;}catch(e){raw.exec('ROLLBACK');throw e;}}};
  const user=id=>({memberId:id,memberMutationRevision:'v1',accountUserId:'account:'+id,isAdmin:id==='admin',isFinanceOwner:false,user:{email:id+'@test.invalid',displayName:id}});
  const act=async(id,input)=>mutateLedger(db,user(id),{revision:(await loadLedger(db,user(id))).revision,...input});
  return {raw,db,user,act};
}
test('refunds are deducted once and unrelated private purchases are omitted',()=>{
 const parsed=parseAlipay(csv,[{id:'person',bill_name:'测试甲'}]);assert.equal(parsed.transactions.length,2);assert.equal(parsed.ignoredCount,1);
 const data=assemble([{id:'person',member_id:'member'}],parsed.transactions);assert.equal(data.people[0].netCents,8000);assert.equal(data.records[0].netCents,8000);assert.equal(data.records[0].confirmed,false);
 assert.throws(()=>parseAlipay(csv+csv.split('\n')[1].replace('100.00','200.00'),[{id:'person',bill_name:'测试甲'}]),/不同记录/);
});
test('import is idempotent, scoped to self, and confirmation cannot be impersonated',async()=>{
 const {db,user,act,raw}=fixture();await act('admin',{action:'import',csv,filename:'synthetic.csv'});await act('admin',{action:'import',csv,filename:'synthetic.csv'});
 assert.equal(raw.prepare('SELECT count(*) n FROM expense_transactions').get().n,2);
 assert.equal((await loadLedger(db,user('other'))).records.length,0);
 await assert.rejects(act('admin',{action:'confirm',ids:['payment0000001']}),/只能本人/);
 await act('member',{action:'confirm',ids:['payment0000001']});assert.equal((await loadLedger(db,user('member'))).records[0].confirmed,true);
 await assert.rejects(mutateLedger(db,user('member'),{action:'confirm',ids:['payment0000001'],revision:0}),/已被更新/);
 raw.prepare("UPDATE members SET mutation_revision='v2' WHERE id='member'").run();await assert.rejects(act('member',{action:'dispute',ids:['payment0000001'],note:'test'}),/权限已变化/);assert.equal(raw.prepare('SELECT count(*) n FROM personnel_disputes').get().n,0);
});
test('disputes create a private owner todo, block confirmation, require owner resolution and re-confirmation',async()=>{
 const {db,user,act,raw}=fixture();await act('admin',{action:'import',csv,filename:'synthetic.csv'});
 await act('member',{action:'dispute',ids:['payment0000001'],note:'金额待核对'});
 let d=raw.prepare('SELECT * FROM personnel_disputes').get();assert.equal(d.assignee_member_id,'admin');
 assert.equal(raw.prepare('SELECT assignee_email FROM project_work_items').get().assignee_email,'admin@test.invalid');
 await assert.rejects(act('member',{action:'confirm',ids:['payment0000001']}),/异议正在处理中/);
 await assert.rejects(act('other',{action:'resolve_dispute',id:d.id,resolution:'无权'}),/仅指定/);
 await act('admin',{action:'resolve_dispute',id:d.id,resolution:'已核对退款，请重新确认'});
 let r=(await loadLedger(db,user('member'))).records[0];assert.equal(r.confirmed,false);assert.equal(r.claim.confirmation_status,'pending');
 assert.equal(raw.prepare('SELECT status FROM project_work_items').get().status,'done');
 await act('member',{action:'confirm',ids:['payment0000001']});assert.equal((await loadLedger(db,user('member'))).records[0].confirmed,true);
});
test('work is editable by self, preserves original, and submits once to the configured reviewer',async()=>{
 const {db,user,act,raw}=fixture();const created=await act('admin',{action:'work_create',memberId:'member',title:'合成周报',sourceText:'原文草稿'});
 await assert.rejects(act('admin',{action:'work_submit',id:created.target,title:'代确认',content:'不得代确认'}),/只能本人/);
 await act('member',{action:'work_save',id:created.target,title:'本人周报',content:'已完成实际工作'});
 let w=(await loadLedger(db,user('member'))).workflow.weekly[0];assert.equal(w.source_text,'原文草稿');assert.equal(w.content,'已完成实际工作');assert.equal(w.accepted,false);
 const result=await act('member',{action:'work_submit',id:w.id,title:w.title,content:w.content});assert.deepEqual(result.nativeApproval.payload.circulationApprovers,[{memberId:'reviewer'}]);
 const retry=await act('member',{action:'work_submit',id:w.id});assert.equal(retry.nativeApproval.id,result.nativeApproval.id);
 await assert.rejects(act('member',{action:'work_save',id:w.id,title:'修改',content:'修改'}),/已锁定/);
 const payload={...result.nativeApproval.payload,circulationApprovers:[{memberId:'reviewer',accountUserId:'account:reviewer'}],circulationApprovals:[{memberId:'reviewer',accountUserId:'account:reviewer'}]};
 raw.prepare('INSERT INTO approvals(id,type,requester_email,status,payload_json,client_creation_key) VALUES(?,?,?,?,?,?)').run('approval','流转审批','member@test.invalid','已归档',JSON.stringify(payload),result.nativeApproval.id);
 w=(await loadLedger(db,user('member'))).workflow.weekly[0];assert.equal(w.accepted,true);assert.equal(w.submittedContent,'已完成实际工作');
 raw.prepare("UPDATE approvals SET payload_json=?").run(JSON.stringify({...payload,circulationApprovals:[]}));assert.equal((await loadLedger(db,user('member'))).workflow.weekly[0].accepted,false);
});
test('progress requires evidence of actual funds and cannot exceed net expense',()=>{
 assert.throws(()=>validateClaim({stage:'settled',reimbursed_cents:8000,submitted_date:'2026-01-01'},8000),/到账日期/);
 assert.throws(()=>validateClaim({stage:'settled',reimbursed_cents:10000},8000),/不能超过/);
 assert.throws(()=>validateClaim({stage:'awaiting',reimbursed_cents:8000},8000),/提交报销日期/);
 const c=validateClaim({stage:'settled',reimbursed_cents:8000,submitted_date:'2026-01-01',received_date:'2026-01-02',reference:'合成回单'},8000);assert.equal(c.reimbursed_cents,8000);
});

test('student todos contain only own actionable records and follow the confirmation/dispute lifecycle',async()=>{
 const {getOwnPersonnelTodos,personnelTodoItems}=await import('../lib/personnel-todos.mjs');
 const {db,user,act,raw}=fixture();await act('admin',{action:'import',csv,filename:'synthetic.csv'});
 let tasks=await getOwnPersonnelTodos(db,user('member'));assert.equal(tasks.length,1);assert.match(tasks[0].id,/personnel-self-expenses-/);assert.equal(tasks[0].assigneeEmail,'member@test.invalid');assert.equal(tasks[0].sourceId,'member');
 assert.deepEqual(await getOwnPersonnelTodos(db,user('other')),[]);assert.deepEqual(await getOwnPersonnelTodos(db,user('admin')),[]);
 assert.deepEqual(personnelTodoItems(await loadLedger(db,user('admin')),user('other')),[]);
 await act('member',{action:'confirm',ids:['payment0000001']});tasks=await getOwnPersonnelTodos(db,user('member'));assert.equal(tasks.length,1);assert.match(tasks[0].id,/personnel-self-reimbursement-/);
 await act('member',{action:'dispute',ids:['payment0000001'],note:'确认后发现需要核对'});assert.deepEqual(await getOwnPersonnelTodos(db,user('member')),[]);
 const d=raw.prepare('select id from personnel_disputes').get();await act('admin',{action:'resolve_dispute',id:d.id,resolution:'已核对，请再次确认'});
 tasks=await getOwnPersonnelTodos(db,user('member'));assert.equal(tasks.length,1);assert.match(tasks[0].id,/personnel-self-expenses-/);
 const w=await act('admin',{action:'work_create',memberId:'member',title:'本人周报',sourceText:'实际工作记录'});tasks=await getOwnPersonnelTodos(db,user('member'));assert.equal(tasks.length,2);assert.equal(tasks.filter(t=>t.id.startsWith('personnel-self-work-')).length,1);
 await act('member',{action:'work_dispute',id:w.target,reason:'工作说明需要核对'});tasks=await getOwnPersonnelTodos(db,user('member'));assert.equal(tasks.filter(t=>t.id.startsWith('personnel-self-work-')).length,0);
});

test('self reported historic reimbursement confirms ownership, preserves cash evidence and updates finance immediately',async()=>{
 const {db,user,act,raw}=fixture();await act('admin',{action:'import',csv,filename:'synthetic.csv'});
 await assert.rejects(act('admin',{action:'report_progress',ids:['payment0000001'],status:'reported_settled'}),/只能本人/);
 await act('member',{action:'report_progress',ids:['payment0000001'],status:'reported_settled'});
 let ledger=await loadLedger(db,user('admin'));assert.equal(ledger.records[0].confirmed,true);assert.equal(ledger.records[0].completed,true);assert.equal(ledger.records[0].claim.reimbursed_cents,0);
 const finance={...user('other'),isFinanceOwner:true};assert.equal((await loadLedger(db,finance)).records[0].claim.stage,'reported_settled');
 const {getOwnPersonnelTodos}=await import('../lib/personnel-todos.mjs');assert.deepEqual(await getOwnPersonnelTodos(db,user('member')),[]);
 await act('member',{action:'report_progress',ids:['payment0000001'],status:'reported_in_progress'});assert.equal((await getOwnPersonnelTodos(db,user('member'))).length,1);
 await act('member',{action:'dispute',ids:['payment0000001'],note:'历史状态需核对'});await assert.rejects(act('member',{action:'report_progress',ids:['payment0000001'],status:'reported_settled'}),/异议/);
 assert.equal(raw.prepare("SELECT count(*) n FROM expense_events WHERE action='report_progress'").get().n,2);
});

test('personnel replies resolve linked aliases, use fresh ledger evidence and respect account scope',async()=>{
 const {answerPersonnelQuestion}=await import('../lib/personnel-chat.mjs');const {db,user,act,raw}=fixture();
 const u=id=>({...user(id),ndaCompleted:true});await act('admin',{action:'import',csv,filename:'synthetic.csv'});
 raw.prepare("UPDATE expense_people SET bill_name='小甲' WHERE id='person'").run();
 let answer=await answerPersonnelQuestion(db,u('admin'),'小甲做了什么工作，买了什么，有什么贡献');
 assert.match(answer.answer,/80.00 元/);assert.match(answer.answer,/待本人确认 1 笔/);assert.match(answer.answer,/具体物品和用途尚待本人补充/);assert.match(answer.answer,/没有已审核归档的贡献/);assert.equal(answer.personnelLinks[0].href,'/people-workbench?person=member&tab=work');
 assert.equal(await answerPersonnelQuestion(db,u('other'),'小甲买了什么'),null);
 assert.equal(await answerPersonnelQuestion(db,u('admin'),'机器人导航怎么做'),null);
 answer=await answerPersonnelQuestion(db,u('admin'),'他买了什么',[{role:'user',content:'小甲的情况'}]);assert.match(answer.answer,/80.00 元/);
 await act('member',{action:'report_progress',ids:['payment0000001'],status:'reported_settled'});
 answer=await answerPersonnelQuestion(db,u('admin'),'测试甲报销了吗');assert.match(answer.answer,/已报销（本人填报） 1 笔/);assert.doesNotMatch(answer.answer,/待本人确认 1 笔/);
 raw.prepare("UPDATE members SET status='departed' WHERE id='other'").run();await assert.rejects(answerPersonnelQuestion(db,u('other'),'我的账单'),/权限已变化/);
});

test('finance role binds exact OAuth identity without granting an email lookalike',async()=>{
 const {financeIdentities}=await import('../lib/finance-identities.mjs');const subject='feishu_'+'a'.repeat(64),email=subject.slice(0,63)+'@feishu.invalid';
 assert.deepEqual(financeIdentities(undefined),[]);assert.equal(financeIdentities(JSON.stringify([{email,accountUserId:subject,displayName:'财务测试'}]))[0].accountUserId,subject);
 assert.throws(()=>financeIdentities(JSON.stringify([{email,accountUserId:'feishu_'+'b'.repeat(64),displayName:'财务测试'}])),/bound/);
 assert.throws(()=>financeIdentities(JSON.stringify([{email:'other@test.invalid',accountUserId:subject,displayName:'财务测试'}])),/bound/);
});

test('authorized bill aliases deduplicate into one person without rewriting source or claim history',async()=>{
 const {db,user,act,raw}=fixture();
 raw.exec(readFileSync(new URL('../migrations/expense-person-aliases-20261007.sql',import.meta.url),'utf8'));
 raw.prepare('UPDATE expense_people SET aliases_json=? WHERE id=?').run(JSON.stringify(['历史账单名']),'person');
 const source=csv.replaceAll('测试甲','历史账单名');
 await act('admin',{action:'import',csv:source,filename:'historic.csv'});
 await act('member',{action:'report_progress',ids:['payment0000001'],status:'reported_settled'});
 const result=await act('admin',{action:'import',csv:source,filename:'historic-again.csv'});
 assert.equal(result.preview.newCount,0);assert.equal(result.preview.duplicateCount,2);
 const ledger=await loadLedger(db,user('admin'));assert.equal(ledger.records.length,1);assert.equal(ledger.people[0].netCents,8000);assert.equal(ledger.records[0].claim.stage,'reported_settled');assert.match(ledger.records[0].source_json,/历史账单名/);
 const {answerPersonnelQuestion}=await import('../lib/personnel-chat.mjs');assert.match((await answerPersonnelQuestion(db,{...user('admin'),ndaCompleted:true},'历史账单名报销了吗')).answer,/测试甲的个人情况/);
 assert.throws(()=>parseAlipay(source,[{id:'a',bill_name:'历史账单名'},{id:'b',bill_name:'另一个人',aliases_json:JSON.stringify(['历史账单名'])}]),/对应多个人员/);
});
