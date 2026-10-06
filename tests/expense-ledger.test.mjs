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
