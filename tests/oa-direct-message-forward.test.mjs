import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { drizzle } from 'drizzle-orm/d1';
import { parseDirectMessageInput, DIRECT_MESSAGE_MAX_LENGTH } from '../lib/direct-message-contract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const key = '__oaMemberMessageTests';
let database;
class Statement {
  constructor(sqlite, query, bindings=[]) { this.sqlite=sqlite; this.query=query; this.bindings=bindings; }
  bind(...bindings) { return new Statement(this.sqlite,this.query,bindings); }
  async all() { return {success:true,results:this.sqlite.prepare(this.query).all(...this.bindings)}; }
  async first() { return this.sqlite.prepare(this.query).get(...this.bindings) || null; }
  async raw() { const s=this.sqlite.prepare(this.query);s.setReturnArrays(true);return s.all(...this.bindings); }
  async run() { const r=this.sqlite.prepare(this.query).run(...this.bindings);return {success:true,meta:{changes:Number(r.changes)}}; }
}
globalThis[key]={};
const vite = await createServer({appType:'custom',configFile:false,root,server:{middlewareMode:true,hmr:false},plugins:[{
  name:'member-message-auth-test',enforce:'pre',resolveId(source) {
    if (/\/_lib\/auth$/u.test(source)) return '\0test-member-message-auth';
    if (/^(?:\.\.\/)+db$/u.test(source)) return '\0test-member-message-db';
    if (/lib\/write-rate-limit$/u.test(source)) return '\0test-member-message-limit';
    return null;
  },load(id) {
    if (id==='\0test-member-message-auth') return `import {sql} from 'drizzle-orm';
      export async function getAuthorizedUser(){return globalThis.${key}.authorized;}
      export async function getReviewerDirectory(){return [];}
      export function isNdaAdmittedMember(member){return Boolean(member.ndaAcceptedAt && member.ndaAgreementVersion);}
      export function parseMemberPermissions(){return [];}
      export function authorizedMemberGuard(){return globalThis.${key}.changed ? sql\`0=1\` : sql\`1=1\`;}`;
    if (id==='\0test-member-message-db') return `export async function getDb(){return globalThis.${key}.db;}`;
    if (id==='\0test-member-message-limit') return `export async function consumeWriteRateLimit(){return globalThis.${key}.rateAllowed;}`;
    return null;
  }
}]});
const route = await vite.ssrLoadModule('/app/api/direct-messages/route.ts');
const actor = (email='a@example.test',displayName='成员甲') => ({ user:{email,displayName},ndaCompleted:true,accountUserId:`account-${email}`,memberId:`id-${email}`,memberMutationRevision:'r1' });
const post = (value,headers={}) => route.POST(new Request('https://oa.example.test/api/direct-messages',{method:'POST',headers:{'content-type':'application/json',origin:'https://oa.example.test',...headers},body:JSON.stringify(value)}));
const input = (values={}) => ({recipientEmail:'b@example.test',body:'完整正文，而不是分享链接。',clientMessageId:'11111111-2222-4333-8444-555555555555',...values});
const count = () => database.prepare('SELECT count(*) n FROM direct_messages').get().n;
beforeEach(() => {
  database?.close(); database=new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE direct_messages(id TEXT PRIMARY KEY,sender_email TEXT NOT NULL,sender_name TEXT NOT NULL,recipient_email TEXT NOT NULL,recipient_name TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE members(id TEXT PRIMARY KEY,full_name TEXT,chatgpt_account TEXT,account_user_id TEXT,role TEXT,permissions_json TEXT,nda_accepted_at TEXT,nda_agreement_version TEXT,status TEXT);`);
  for (const [email,name] of [['a@example.test','成员甲'],['b@example.test','成员乙'],['c@example.test','成员丙']]) database.prepare('INSERT INTO members VALUES (?,?,?,?,?,?,?,?,?)').run(email,name,email,`account-${email}`,'member','[]','2026-09-18','NDA-2026-09','active');
  globalThis[key]={authorized:actor(),rateAllowed:true,changed:false,db:drizzle({prepare:q=>new Statement(database,q)})};
});
after(async()=>{database?.close();await vite.close();delete globalThis[key];});

test('forwards the complete long body under the authenticated user, and the recipient replies directly',async()=>{
  const body='# 测试结果\n\n**结论**\n\n|指标|结果|\n|---|---|\n|误差|$e^2$|\n\n'+'完整内容。'.repeat(2500);
  const response=await post(input({body}));assert.equal(response.status,201);
  const message=(await response.json()).message;
  assert.equal(message.body,body);assert.equal(message.senderEmail,'a@example.test');assert.equal(message.senderName,'成员甲');assert.equal(message.recipientName,'成员乙');
  globalThis[key].authorized=actor('b@example.test','成员乙');
  const received=await route.GET(new Request('https://oa.example.test/api/direct-messages?with=a%40example.test'));
  assert.equal((await received.json()).messages[0].body,body);
  const reply=await post(input({recipientEmail:'a@example.test',body:'已收到正文，我来核对。',clientMessageId:crypto.randomUUID()}));assert.equal(reply.status,201);
  globalThis[key].authorized=actor();
  const history=await route.GET(new Request('https://oa.example.test/api/direct-messages?with=b%40example.test'));
  const messages=(await history.json()).messages;
  assert.equal(messages.length,2);assert.ok(messages.some(item=>item.senderName==='成员乙'&&item.body==='已收到正文，我来核对。'));
});
test('no caller-supplied sender or AI identity is accepted',async()=>{
  for(const key of ['senderEmail','senderName','role','sender','asAi']) assert.equal((await post({...input(),[key]:'AI'})).status,400);
  assert.equal(count(),0);
});
test('retry after a lost acknowledgement is idempotent with the same content and recipient',async()=>{
  assert.equal((await post(input())).status,201);assert.equal((await post(input())).status,200);assert.equal(count(),1);
});
test('concurrent retries create at most one message',async()=>{
  const responses=await Promise.all([post(input()),post(input())]);assert.ok(responses.every(response=>[200,201].includes(response.status)));assert.equal(count(),1);
});
test('a reused message ID cannot change content, recipient or sender and never discloses another message',async()=>{
  await post(input());
  for(const changed of [{body:'替换内容'},{recipientEmail:'c@example.test'}]) {const response=await post(input(changed));assert.equal(response.status,409);assert.equal((await response.json()).message,undefined);}
  globalThis[key].authorized=actor('c@example.test','成员丙');const response=await post(input());assert.equal(response.status,409);assert.equal(count(),1);
});
test('unrelated members cannot retrieve a conversation between two other members',async()=>{
  await post(input());globalThis[key].authorized=actor('c@example.test','成员丙');
  const response=await route.GET(new Request('https://oa.example.test/api/direct-messages?with=a%40example.test'));assert.deepEqual((await response.json()).messages,[]);
});
test('login, NDA, active recipient and atomic sender admission remain enforced',async()=>{
  globalThis[key].authorized=null;assert.equal((await post(input())).status,401);
  globalThis[key].authorized={...actor(),ndaCompleted:false};assert.equal((await post(input())).status,403);
  globalThis[key].authorized=actor();database.exec("UPDATE members SET status='disabled' WHERE chatgpt_account='b@example.test'");assert.equal((await post(input())).status,404);
  database.exec("UPDATE members SET status='active' WHERE chatgpt_account='b@example.test'");globalThis[key].changed=true;assert.equal((await post(input())).status,409);assert.equal(count(),0);
});
test('self-send, cross-site, oversized, malformed and rate-limited requests never send a message',async()=>{
  assert.equal((await post(input({recipientEmail:'a@example.test'}))).status,400);
  assert.equal((await post(input(),{origin:'https://other.example'})).status,403);
  assert.equal((await post(input(),{'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await post(input({body:'甲'.repeat(DIRECT_MESSAGE_MAX_LENGTH+1)}))).status,400);
  assert.equal((await post(input({body:'恶意\u0000内容'}))).status,400);
  assert.equal((await post(input({body:'\ud800'}))).status,400);
  assert.equal((await post(input(),{'content-type':'text/plain'})).status,415);
  globalThis[key].rateAllowed=false;assert.equal((await post(input())).status,429);assert.equal(count(),0);
});
test('legacy short messages remain compatible and private responses are never cacheable',async()=>{
  const response=await post({recipientEmail:'b@example.test',body:'旧入口仍能发送'});assert.equal(response.status,201);assert.match(response.headers.get('cache-control'),/private, no-store/);
  const legacy=await response.json();assert.equal(legacy.message.senderName,'成员甲');
});
test('the shared input contract accepts only complete Unicode text and safe idempotency IDs',()=>{
  assert.ok(parseDirectMessageInput(input({body:'甲'.repeat(16000)})));
  for (const value of [null,[],{...input(),extra:true},input({clientMessageId:'someone-else'}),input({recipientEmail:'not-an-email'}),input({body:''})]) assert.equal(parseDirectMessageInput(value),null);
});
