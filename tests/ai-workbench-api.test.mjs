import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { feishuDigest } from '../lib/ai-workbench-feishu-crypto.mjs';

globalThis.__aiWorkbenchTest = {};
const vite = await createServer({ appType:'custom',configFile:false,root:fileURLToPath(new URL('..',import.meta.url)),server:{middlewareMode:true,hmr:false},plugins:[{
  name:'ai-workbench-test-dependencies',enforce:'pre',
  resolveId(source){if(source==='cloudflare:workers')return '\0ai-env';if(source.endsWith('/_lib/auth'))return '\0ai-auth';if(source.endsWith('/oa-chat-client'))return '\0ai-model';if(source.endsWith('/db'))return '\0ai-db';},
  load(id){if(id==='\0ai-env')return 'export const env=new Proxy({}, {get:(_,k)=>globalThis.__aiWorkbenchTest.env[k]});';if(id==='\0ai-auth')return 'export const getAuthorizedUser=async()=>globalThis.__aiWorkbenchTest.actor;';if(id==='\0ai-db')return 'export const getD1Database=async()=>globalThis.__aiWorkbenchTest.env.DB;';if(id==='\0ai-model')return 'export const generateOaTask=async(input)=>globalThis.__aiWorkbenchTest.generate(input);';}
}]});
const store=await vite.ssrLoadModule('/lib/ai-workbench-store.ts');
const api=await vite.ssrLoadModule('/app/api/lab-ai/tasks/route.ts');
const feishu=await vite.ssrLoadModule('/lib/ai-workbench-feishu.ts');
const runner=await vite.ssrLoadModule('/lib/ai-workbench-runner.ts');
let sqlite,db,env,actor,sent,modelCalls,deliveryFailure;
const originalFetch=globalThis.fetch;
const input={kind:'document',title:'测试报告',instruction:'整理原文，缺失项目待补充',material:'本周已完成接口联调，实机验收尚未进行。'};
const output='# 测试报告\n\n## 本周进展\n已完成接口联调，实机验收待进行。';
function adapter(query,params=[]){return{bind(...values){return adapter(query,values);},async first(){return sqlite.prepare(query).get(...params)||null;},async all(){return{results:sqlite.prepare(query).all(...params)};},async run(){return sqlite.prepare(query).run(...params);}};}
function state(id){return sqlite.prepare('SELECT * FROM ai_workbench_tasks WHERE id=?').get(id);}
function req(body,origin='https://oa.omindos.ai'){return new Request('https://oa.omindos.ai/api/lab-ai/tasks',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(body)});}
async function create(){return store.createTask(db,actor,input,`oa:${crypto.randomUUID()}`);}
const eventRequest=async(message,changes={})=>{
  const event={schema:'2.0',header:{token:env.FEISHU_AI_VERIFICATION_TOKEN,event_type:'im.message.receive_v1',app_id:'cli_test',tenant_key:'tenant_test',...changes.header},event:{sender:{sender_type:'user',tenant_key:'tenant_test',sender_id:{open_id:'ou_alice123'},...changes.sender},message:{message_id:'om_message123',chat_type:'p2p',chat_id:'oc_chat123',message_type:'text',content:JSON.stringify({text:'任务：整理原文\n材料：本周已完成接口联调。'}),...message}}};
  const enc=new TextEncoder(),iv=crypto.getRandomValues(new Uint8Array(16)),key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',enc.encode(env.FEISHU_AI_ENCRYPT_KEY)),'AES-CBC',false,['encrypt']);
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-CBC',iv},key,enc.encode(JSON.stringify(event)))),bytes=new Uint8Array(16+encrypted.length);bytes.set(iv);bytes.set(encrypted,16);
  const body=JSON.stringify({encrypt:btoa(String.fromCharCode(...bytes))}),time=String(Math.floor(Date.now()/1000)),nonce='event_nonce';
  return new Request('https://oa.omindos.ai/api/integrations/feishu/ai-events',{method:'POST',headers:{'content-type':'application/json','x-lark-request-timestamp':time,'x-lark-request-nonce':nonce,'x-lark-signature':await feishuDigest(time+nonce+env.FEISHU_AI_ENCRYPT_KEY+body)},body});
};
beforeEach(()=>{
  sqlite?.close();sqlite=new DatabaseSync(':memory:');
  const dir=new URL('../drizzle/',import.meta.url);
  for(const file of readdirSync(dir).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort())sqlite.exec(readFileSync(new URL(file,dir),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/oa/0002_ai_workbench.sql',import.meta.url),'utf8'));
  for(const id of ['alice','bob']){
    sqlite.prepare("INSERT INTO members(id,full_name,chatgpt_account,account_user_id,status,mutation_revision,nda_accepted_at,nda_agreement_version) VALUES (?,?,?,?,'active','revision-1','accepted','nda-1')").run(id,id,`${id}@example.com`,`email:${id}@example.com`);
    sqlite.prepare("UPDATE members SET nda_approval_id=? WHERE id=?").run(`nda-${id}`,id);
    sqlite.prepare("INSERT INTO approvals(id,type,title,project,requester_name,requester_email,created_at,updated_at,status,current_step,owner,payload_json) VALUES (?,'保密协议','保密协议','测试',?,?,'now','now','已归档','归档',?,?)").run(`nda-${id}`,id,`${id}@example.com`,id,JSON.stringify({signerAccountUserId:`email:${id}@example.com`,agreementVersion:'nda-1'}));
    sqlite.prepare("INSERT INTO auth_identities(id,member_id,provider,provider_subject) VALUES (?,?,'feishu',?)").run(id,id,`cli_test:tenant_test:ou_${id}123`);
  }
  db={prepare:adapter};env={DB:db,OA_AI_TASKS_ENABLED:'true',FEISHU_AI_TASKS_ENABLED:'true',FEISHU_LOGIN_APP_ID:'cli_test',FEISHU_LOGIN_APP_SECRET:'dummy-test-secret',FEISHU_LOGIN_TENANT_KEY:'tenant_test',FEISHU_AI_ENCRYPT_KEY:'unit-test-encryption-value',FEISHU_AI_VERIFICATION_TOKEN:'unit-test-verification-value'};
  actor={memberId:'alice',accountUserId:'email:alice@example.com',memberMutationRevision:'revision-1',ndaCompleted:true,user:{displayName:'Alice',email:'alice@example.com'}};
  sent=[];modelCalls=0;deliveryFailure=false;
  globalThis.__aiWorkbenchTest={env,actor,generate:async value=>{modelCalls++;assert.deepEqual(Object.keys(value).sort(),['instruction','kind','material','title']);return output;}};
  globalThis.fetch=async(url,init)=>{
    assert.ok(String(url).startsWith('https://open.feishu.cn/open-apis/'));
    if(String(url).includes('tenant_access_token'))return Response.json({code:0,tenant_access_token:'dummy-token'});
    const body=JSON.parse(init.body);sent.push(body);if(deliveryFailure)throw new Error('simulated lost acknowledgement');
    return Response.json({code:0,data:{message_id:'om_reply123'}});
  };
});
after(async()=>{globalThis.fetch=originalFetch;delete globalThis.__aiWorkbenchTest;sqlite?.close();await vite.close();});
test('OA admission and feature flag are mandatory, including for administrators',async()=>{
  for(const [user,status] of [[null,401],[{...actor,ndaCompleted:false},403],[{...actor,memberId:null,isAdmin:true},403]]){globalThis.__aiWorkbenchTest.actor=user;assert.equal((await api.GET(new Request('https://oa.omindos.ai/api/lab-ai/tasks'))).status,status);}
  globalThis.__aiWorkbenchTest.actor=actor;env.OA_AI_TASKS_ENABLED='false';assert.equal((await api.GET(new Request('https://oa.omindos.ai/api/lab-ai/tasks'))).status,503);
});
test('OA mutations reject cross-site, oversized and unexpected fields',async()=>{
  const body={action:'create',requestId:crypto.randomUUID(),...input};
  assert.equal((await api.POST(req(body,'https://attacker.invalid'))).status,403);
  assert.equal((await api.POST(req({...body,tools:['send']}))).status,400);
  assert.equal((await api.POST(req({...body,material:'x'.repeat(100000)}))).status,413);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM ai_workbench_tasks').get().n,0);
});
test('OA create, execute, persisted result and real Word/Markdown download form a closed loop',async()=>{
  const created=await api.POST(req({action:'create',requestId:crypto.randomUUID(),...input}));assert.equal(created.status,201);
  const {task}=await created.json();assert.equal(task.status,'queued');assert.equal(task.result,'');
  assert.equal((await api.GET(new Request(`https://oa.omindos.ai/api/lab-ai/tasks?id=${task.id}&format=docx`))).status,409);
  const finished=await api.POST(req({action:'run',id:task.id}));assert.equal((await finished.json()).task.status,'succeeded');assert.equal(modelCalls,1);
  assert.equal(state(task.id).result,output);
  const docx=await api.GET(new Request(`https://oa.omindos.ai/api/lab-ai/tasks?id=${task.id}&format=docx`));assert.equal(docx.status,200);assert.match(docx.headers.get('content-type'),/wordprocessingml/);assert.match(docx.headers.get('cache-control'),/no-store/);assert.equal(new Uint8Array(await docx.arrayBuffer())[0],0x50);
  const md=await api.GET(new Request(`https://oa.omindos.ai/api/lab-ai/tasks?id=${task.id}&format=md`));assert.match(await md.text(),/接口联调/);
});
test('task records and downloads cannot be read or run by another member',async()=>{
  const row=await create();globalThis.__aiWorkbenchTest.actor={...actor,memberId:'bob',accountUserId:'email:bob@example.com'};
  for(const format of ['', '&format=docx'])assert.equal((await api.GET(new Request(`https://oa.omindos.ai/api/lab-ai/tasks?id=${row.id}${format}`))).status,404);
  assert.equal((await api.POST(req({action:'run',id:row.id}))).status,404);assert.equal(modelCalls,0);
});
test('duplicate submit and concurrent execution do not double-create or double-generate',async()=>{
  const id=`oa:${crypto.randomUUID()}`;
  const [a,b]=await Promise.all([store.createTask(db,actor,input,id),store.createTask(db,actor,input,id)]);assert.equal(a.id,b.id);
  await Promise.all([store.runTask(db,a.id,globalThis.__aiWorkbenchTest.generate),store.runTask(db,a.id,globalThis.__aiWorkbenchTest.generate)]);
  assert.equal(modelCalls,1);assert.equal(state(a.id).attempts,1);
  await assert.rejects(store.createTask(db,actor,{...input,material:'different material'},id),/IDEMPOTENCY/);
});
test('failure never produces a success artifact; retry limit is enforced',async()=>{
  const row=await create();const fail=async()=>{throw new Error('private upstream details');};
  for(let i=0;i<3;i++){if(i)assert.ok(await store.retryTask(db,actor,row.id));await store.runTask(db,row.id,fail);}
  assert.equal(state(row.id).status,'failed');assert.equal(state(row.id).result,'');assert.equal(state(row.id).attempts,3);assert.equal(await store.retryTask(db,actor,row.id),null);
  assert.ok(!JSON.stringify(state(row.id)).includes('private upstream'));
});
test('cancel and membership revocation during generation prevent publishing a late result',async()=>{
  for(const cancel of [true,false]){
    const row=await create();let resolve;const pending=store.runTask(db,row.id,()=>new Promise(r=>{resolve=r;}));
    await new Promise(setImmediate);
    if(cancel)await store.cancelTask(db,actor,row.id);else sqlite.exec("UPDATE members SET nda_accepted_at=NULL WHERE id='alice'");
    resolve(output);await pending;assert.equal(state(row.id).status,cancel?'cancelled':'failed');assert.equal(state(row.id).result,'');
    sqlite.exec("UPDATE members SET nda_accepted_at='accepted' WHERE id='alice'");
  }
});
test('stale running leases fail without an automatic model retry',async()=>{
  const row=await create();sqlite.prepare("UPDATE ai_workbench_tasks SET status='running',attempts=1,lease_until=0 WHERE id=?").run(row.id);
  await store.runTask(db,row.id,globalThis.__aiWorkbenchTest.generate);assert.equal(modelCalls,0);assert.equal(state(row.id).failure_code,'TASK_INTERRUPTED');
});
test('Feishu callback deduplicates tasks, validates tenant and rejects group messages',async()=>{
  const first=await feishu.receiveFeishuTask(await eventRequest(),env);assert.equal(first.status,200);const task=(await first.json()).taskId;
  assert.equal((await (await feishu.receiveFeishuTask(await eventRequest(),env)).json()).taskId,task);
  await feishu.receiveFeishuTask(await eventRequest({message_id:'om_group123',chat_type:'group'}),env);
  await feishu.receiveFeishuTask(await eventRequest({message_id:'om_wrong123'},{header:{tenant_key:'wrong_tenant'}}),env);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM ai_workbench_tasks').get().n,1);assert.equal(modelCalls,0);
});
test('forwarded text needs an explicit command and must belong to the same user and chat',async()=>{
  const source={message_id:'om_source123',content:JSON.stringify({text:'本周已完成接口联调。'})};
  assert.equal((await (await feishu.receiveFeishuTask(await eventRequest(source),env)).json()).materialOnly,true);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM ai_workbench_tasks').get().n,0);
  const result=await feishu.receiveFeishuTask(await eventRequest({message_id:'om_command123',parent_id:'om_source123',content:JSON.stringify({text:'/任务 整理成周报'})}),env);
  const row=state((await result.json()).taskId);assert.equal(row.material,'本周已完成接口联调。');assert.equal(row.status,'queued');
  const other=await feishu.receiveFeishuTask(await eventRequest({message_id:'om_other123',parent_id:'om_source123',chat_id:'oc_different',content:JSON.stringify({text:'/任务 整理成周报'})}),env);
  assert.equal(state((await other.json()).taskId).failure_code,'TASK_MATERIAL_MISSING');
});
test('unsupported Feishu attachments are explicitly failed and never sent to a model',async()=>{
  const result=await feishu.receiveFeishuTask(await eventRequest({message_type:'file',content:'{"file_key":"do-not-fetch"}'}),env);
  const row=state((await result.json()).taskId);assert.equal(row.failure_code,'TASK_UNSUPPORTED_MATERIAL');
  await runner.processAiWorkbench(env);assert.equal(modelCalls,0);assert.equal(sent.length,1);assert.match(sent[0].content,/暂不支持/);
  assert.equal(await store.retryTask(db,actor,row.id),null);
});
test('Feishu unlinked identities cannot enqueue tasks or run already queued tasks',async()=>{
  const result=await feishu.receiveFeishuTask(await eventRequest(),env),id=(await result.json()).taskId;
  sqlite.exec("UPDATE auth_identities SET unlinked_at='unlinked' WHERE member_id='alice'");
  await store.runTask(db,id,globalThis.__aiWorkbenchTest.generate);assert.equal(modelCalls,0);assert.equal(state(id).status,'failed');
  await feishu.receiveFeishuTask(await eventRequest({message_id:'om_unlinked123'}),env);assert.equal(sqlite.prepare('SELECT count(*) n FROM ai_workbench_tasks').get().n,1);
});
test('completed Feishu tasks send the actual content only to their verified owner',async()=>{
  const result=await feishu.receiveFeishuTask(await eventRequest(),env),id=(await result.json()).taskId;
  await runner.processAiWorkbench(env);assert.equal(modelCalls,1);assert.equal(state(id).status,'succeeded');assert.equal(state(id).delivery_status,'sent');
  assert.equal(sent[0].receive_id,'ou_alice123');assert.match(sent[0].content,/接口联调/);assert.match(sent[0].content,/Word/);
  await runner.processAiWorkbench(env);assert.equal(sent.length,1);assert.equal(modelCalls,1);
});
test('ambiguous Feishu retries use a stable UUID and stop after dedupe window',async()=>{
  const result=await feishu.receiveFeishuTask(await eventRequest(),env),id=(await result.json()).taskId;
  deliveryFailure=true;await runner.processAiWorkbench(env);assert.equal(state(id).delivery_status,'pending');
  deliveryFailure=false;await feishu.deliverFeishuTasks(env);assert.equal(sent[0].uuid,sent[1].uuid);assert.equal(state(id).delivery_status,'sent');
  sqlite.prepare("UPDATE ai_workbench_tasks SET delivery_status='pending',delivery_started_at=?,delivery_parts=0 WHERE id=?").run(Date.now()-51*60000,id);
  await feishu.deliverFeishuTasks(env);assert.equal(sent.length,2);assert.equal(state(id).delivery_status,'needs_review');
});
test('revoked members or changed Feishu namespace cannot receive generated content',async()=>{
  const result=await feishu.receiveFeishuTask(await eventRequest(),env),id=(await result.json()).taskId;
  await store.runTask(db,id,globalThis.__aiWorkbenchTest.generate);env.FEISHU_LOGIN_TENANT_KEY='other_tenant';
  await feishu.deliverFeishuTasks(env);assert.equal(sent.length,0);assert.equal(state(id).delivery_status,'skipped');
});
test('disabled task processing does not generate, deliver or consume the source inbox',async()=>{
  await create();env.OA_AI_TASKS_ENABLED='false';await runner.processAiWorkbench(env);assert.equal(modelCalls,0);assert.equal(sent.length,0);
});

test('revoked NDA archives block new Feishu tasks and late task results despite cached admission',async()=>{
  const row=await create();
  await store.runTask(db,row.id,async()=>{sqlite.exec("UPDATE approvals SET status='已作废' WHERE id='nda-alice'");return output;});
  assert.equal(state(row.id).status,'failed');assert.equal(state(row.id).result,'');
  const result=await feishu.receiveFeishuTask(await eventRequest(),env);assert.equal((await result.json()).ignored,true);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM ai_workbench_tasks').get().n,1);
});
