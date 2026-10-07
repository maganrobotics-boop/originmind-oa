import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createLearningPeople } from '../aliyun/learning/future-stars.mjs';
import { readFutureStudents } from '../chat-cloudflare/src/future-stars-service.mjs';
import { validStarsPayload } from '../chat-cloudflare/src/future-stars-bridge.mjs';
const now = 1791252000000, day = 86400000;
function fixture() {
 const db = new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE learning_submissions(email TEXT,payload TEXT,review_state TEXT,created_at INTEGER);
 CREATE TABLE learning_course_drafts(email TEXT,course_id TEXT,revision INTEGER,updated_at INTEGER);
 CREATE TABLE learning_messages(email TEXT,created_at INTEGER); CREATE TABLE learning_git_runs(email TEXT,created_at INTEGER);
 CREATE TABLE learning_graduation_attempts(email TEXT,created_at INTEGER); CREATE TABLE learning_patrol_attempts(email TEXT,created_at INTEGER);`);
 const courses = [{id:'intro',title:'入门'},{id:'nav',title:'导航'},{id:'nav-child',title:'导航任务',parentId:'nav'},{id:'final',title:'毕业项目'}];
 const canonicalId = id => id === 'nav-child' ? 'nav' : id;
 const learning = createLearningPeople({db,courses,canonicalId,stages:[{id:'foundation',title:'新手村',courses:[courses[0]]},{id:'advanced',title:'训练营',courses:[courses[1]]},{id:'capstone',title:'实战营',courses:[courses[3]]}],
 progressFor: email => ({sequence:['intro','nav','final'],exemptedCourseIds:email==='exempt@x.cn'?['intro']:[],currentCourseId:'nav'}),graduationSummary:()=>({status:'not_attempted'})});
 const add = (email,id,time) => db.prepare('INSERT INTO learning_submissions VALUES(?,?,?,?)').run(email,JSON.stringify({courseId:id}),'done',time);
 const row = (email,at=0) => ({email,displayName:email,signerName:'',lastActivityAt:at});
 return {db,learning,add,row};
}
test('all stages, canonical task deduplication, repeat submissions and exemption separation', () => {
 const f=fixture();
 f.add('a@x.cn','intro',now-5*day); f.add('a@x.cn','intro',now-1000);
 f.add('a@x.cn','nav-child',now-2000); f.add('a@x.cn','nav',now-1000); f.add('a@x.cn','final',now-500);
 const [a,e] = f.learning.enrich([f.row('a@x.cn'),f.row('exempt@x.cn',now-100)],{since:now-day,now});
 assert.equal(a.recentSubmitted,2); assert.equal(a.overall.submitted,3); assert.equal(a.overall.total,3);
 assert.deepEqual(a.stageProgress.map(s=>s.completed),[1,1,1]);
 assert.equal(e.recentSubmitted,0); assert.equal(e.overall.submitted,0); assert.equal(e.overall.exempted,1);
 assert.deepEqual(f.learning.participants('nav'),['a@x.cn']); f.db.close();
});
test('authenticated presence is deduplicated and read-only enrichment never creates activity', () => {
 const f=fixture(); f.learning.touch('A@x.cn',now-1000); f.learning.touch('a@x.cn',now);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM learning_presence').get().n,1);
 const rows=f.learning.enrich([f.row('a@x.cn'),f.row('b@x.cn')],{since:now-day,now});
 assert.equal(rows[0].lastActivityAt,now-1000); assert.equal(rows[1].lastActivityAt,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM learning_presence').get().n,1); f.db.close();
});
test('global ranking before pagination, inactive exclusion, time windows and stable overview', async () => {
 const f=fixture(), people=[];
 for(let i=0;i<25;i++){const email=`s${i}@x.cn`;people.push(f.row(email,now-100));f.add(email,'intro',now-day*2);}
 f.add('s24@x.cn','nav',now-1000); f.add('s24@x.cn','final',now-500);
 people.push(f.row('old@x.cn',now-day*4));
 const db={prepare:()=>({first:async()=>null,bind(){return this;},all:async()=>({results:people})})};
 const result=await readFutureStudents(db,f.learning,{},now);
 assert.equal(result.records[0].email,'s24@x.cn'); assert.equal(result.records.length,20); assert.equal(result.pagination.total,25);
 assert.deepEqual(result.summary.onlineCounts,{'24h':25,'3d':25,'7d':26});
 const search=await readFutureStudents(db,f.learning,{q:'s24@x.cn'},now);
 assert.equal(search.pagination.total,1);assert.equal(search.summary.active,25);
 const second=await readFutureStudents(db,f.learning,{page:'2'},now);assert.equal(second.records.length,5);
 const seven=await readFutureStudents(db,f.learning,{window:'7d'},now);assert.equal(seven.pagination.total,26);
 await assert.rejects(readFutureStudents(db,f.learning,{window:'all'},now));
 await assert.rejects(readFutureStudents(db,f.learning,{sort:'sql'},now));f.db.close();
});
test('bridge permits only scoped read filters and still rejects unknown fields', () => {
 const payload={operation:'people',actor:{email:'admin@x.cn',subject:'test'},params:{window:'24h',sort:'fastest'}};
 assert.equal(validStarsPayload(payload),true); assert.equal(validStarsPayload({...payload,params:{...payload.params,admin:'true'}}),false);
});

test('default full-course progress wins over a recent-only surge; ties use activity immediately',async()=>{
 const f=fixture();
 f.add('steady@x.cn','intro',now-10*day);f.add('steady@x.cn','nav',now-10*day);f.add('surge@x.cn','intro',now-100);
 f.add('tie-old@x.cn','intro',now-2000);f.add('tie-new@x.cn','intro',now-10*day);
 const people=[f.row('steady@x.cn',now-10000),f.row('surge@x.cn',now-100),f.row('tie-old@x.cn',now-1000),f.row('tie-new@x.cn',now-50)];
 const db={prepare:()=>({first:async()=>null,bind(){return this;},all:async()=>({results:people})})};
 const result=await readFutureStudents(db,f.learning,{},now);
 assert.equal(result.sort,'progress');assert.deepEqual(result.records.map(row=>row.email),['steady@x.cn','tie-new@x.cn','surge@x.cn','tie-old@x.cn']);
 const filtered=await readFutureStudents(db,f.learning,{courseId:'nav'},now);
 assert.equal(filtered.records[0].overall.submitted,2);assert.deepEqual(filtered.summary,result.summary);f.db.close();
});
test('24h/3d/7d boundaries include exact cutoff, exclude future timestamps and missing activity',async()=>{
 const f=fixture();const times=[now-day,now-day-1,now-3*day,now-3*day-1,now-7*day,now-7*day-1,now+1,0];
 const people=times.map((at,i)=>f.row(`edge${i}@x.cn`,at));
 const db={prepare:()=>({first:async()=>null,bind(){return this;},all:async()=>({results:people})})};
 for(const [window,count] of [['24h',1],['3d',3],['7d',5]]){
  const result=await readFutureStudents(db,f.learning,{window},now);assert.equal(result.pagination.total,count);
  assert.deepEqual(result.summary.onlineCounts,{'24h':1,'3d':3,'7d':5});
 }
 const empty=await readFutureStudents(db,f.learning,{q:'absent'},now);assert.deepEqual(empty.records,[]);assert.equal(empty.pagination.total,0);
 f.db.close();
});
test('future submissions do not add progress and advanced-only learners count as started',async()=>{
 const f=fixture();f.add('advanced@x.cn','final',now-500);f.add('advanced@x.cn','intro',now+100);
 const people=[f.row('advanced@x.cn')];const db={prepare:()=>({first:async()=>null,bind(){return this;},all:async()=>({results:people})})};
 const result=await readFutureStudents(db,f.learning,{status:'started'},now);
 assert.equal(result.records.length,1);assert.equal(result.records[0].overall.submitted,1);assert.equal(result.records[0].currentCourseTitle,'毕业项目');
 assert.equal((await readFutureStudents(db,f.learning,{status:'not_started'},now)).records.length,0);f.db.close();
});

test('failed course account reads cannot be presented as an empty cohort',async()=>{
 const f=fixture();const db={prepare:()=>({first:async()=>null,bind(){return this;},all:async()=>({success:false})})};
 await assert.rejects(readFutureStudents(db,f.learning,{},now),error=>error.status===503);f.db.close();
});
