import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeArenaActivity, compareArenaResults, createArenaAdmin } from '../aliyun/arena-admin.mjs';
import { validStarsPayload } from '../chat-cloudflare/src/future-stars-bridge.mjs';
const now=1791260400000,day=86400000;
const run=(id,extra={})=>({id,createdAt:new Date(now-1000).toISOString(),mapId:'map-a',mapName:'地图A',quickPractice:false,status:'COMPLETE',found:10,total:10,returned:true,time:100,...extra});
const person=(id,extra={})=>({email:id+'@test.cn',displayName:id,lastSeen:now-500,runs:[],jobs:[],resultsError:'',...extra});
test('complete challenge uses official mean time rather than the first trial',()=>{
 assert.ok(compareArenaResults(run('a',{ranked:true,rankTime:80,time:150}),run('b',{ranked:true,rankTime:100,time:10}))<0);
});
test('unique people and exact rolling windows, including online users with no result',()=>{
 const r=summarizeArenaActivity([person('a'),person('b',{lastSeen:now-2*day}),person('c',{lastSeen:now-6*day}),person('old',{lastSeen:now-8*day})],{},now);
 assert.deepEqual(r.summary.onlineCounts,{'24h':1,'3d':2,'7d':3});assert.equal(r.records.length,1);assert.equal(r.records[0].best,null);
 const seven=summarizeArenaActivity([person('a'),person('b',{lastSeen:now-2*day})],{window:'7d',q:'a@test'},now);assert.equal(seven.records.length,1);assert.equal(seven.summary.active,2);
});
test('result window, map and mode isolation; best is not just the most recent',()=>{
 const a=person('a',{runs:[run('old',{createdAt:new Date(now-2*day).toISOString(),time:1}),run('best',{time:50}),run('latest',{time:150,createdAt:new Date(now-100).toISOString()}),run('quick',{quickPractice:true,time:5}),run('other',{mapId:'map-b',time:4})]});
 const r=summarizeArenaActivity([a],{mapId:'map-a',mode:'full'},now);assert.equal(r.records[0].testCount,2);assert.equal(r.records[0].best.id,'best');assert.equal(r.records[0].latest.id,'latest');assert.equal(r.summary.completed,2);
});
test('complete and return outrank partial; global ordering happens before pagination',()=>{
 const people=Array.from({length:25},(_,i)=>person('p'+i,{runs:[run(String(i),{time:i===24?1:100+i})]}));
 people.push(person('partial',{runs:[run('incomplete',{status:'INCOMPLETE',found:9,returned:false,time:0.1})]}));
 const r=summarizeArenaActivity(people,{mapId:'map-a',mode:'full'},now);assert.equal(r.records[0].email,'p24@test.cn');assert.equal(r.records.length,20);assert.equal(r.pagination.total,26);
 assert.ok(compareArenaResults(run('complete'),run('partial',{returned:false,status:'INCOMPLETE',time:0.1}))<0);
});
test('failed results stay visibly unavailable and do not become a zero-score winner',()=>{
 const r=summarizeArenaActivity([person('error',{resultsError:'读取失败',runs:[run('partial-read',{time:1})]}),person('ok',{runs:[run('ok')]})],{mapId:'map-a',mode:'full'},now);
 assert.equal(r.records[0].email,'ok@test.cn');assert.equal(r.summary.unavailable,1);assert.equal(r.records[1].best,null);
});
test('signed admin bridge accepts arena reads and rejects unlisted control parameters',()=>{
 const p={actor:{email:'admin@test.cn',subject:'test'},operation:'arena',params:{window:'7d',mapId:'map-a',mode:'full'}};
 assert.equal(validStarsPayload(p),true);assert.equal(validStarsPayload({...p,params:{...p.params,owner:'spoof'}}),false);
 assert.throws(()=>summarizeArenaActivity([],{window:'all'},now));assert.throws(()=>summarizeArenaActivity([],{sort:'bad'},now));
});
test('admin reads reuse verified account mapping, traverse history pages and never mark online',async()=>{
 const calls=[];const db={prepare:sql=>({all:async()=>({results:sql.includes('WITH accounts')?[{email:'a@test.cn',displayName:'A'}]:sql.includes('arena_account_activity')?[{owner:'hashed-a',lastSeen:now-500}]:[]})})};
 const overview=createArenaAdmin({db,ownerFor:email=>{assert.equal(email,'a@test.cn');return 'hashed-a';},clock:()=>now,activity:async(owner,input)=>{calls.push(input);assert.equal(owner,'hashed-a');return input.offset===0?{runs:Array.from({length:20},(_,i)=>run('p'+i)),jobs:[],hasMore:true}:{runs:[run('best',{time:1})],jobs:[],hasMore:false};}});
 const r=await overview({mapId:'map-a',mode:'full'});assert.equal(r.records[0].testCount,21);assert.equal(r.records[0].best.id,'best');assert.deepEqual(calls.map(x=>x.offset),[0,20]);
});

test('exact rolling cutoffs, duplicate identities/results, no-visit historical accounts and future dates',()=>{
 const people=[person('a',{lastSeen:now-day}),person('a',{email:'A@test.cn',lastSeen:now-day,runs:[run('duplicate')]}),person('a',{runs:[run('duplicate')]}),person('three',{lastSeen:now-3*day}),person('seven',{lastSeen:now-7*day}),person('old',{lastSeen:now-7*day-1}),person('future',{lastSeen:now+1,runs:[run('future',{createdAt:new Date(now+1000).toISOString()})]})];
 const result=summarizeArenaActivity(people,{mapId:'map-a',mode:'full'},now);
 assert.deepEqual(result.summary.onlineCounts,{'24h':1,'3d':2,'7d':3});assert.equal(result.summary.tests,1);
 assert.equal(summarizeArenaActivity(people,{window:'3d'},now).summary.active,2);assert.equal(summarizeArenaActivity(people,{window:'7d'},now).summary.active,3);
});
test('connected empty data is zero; malformed official scores are partial with null totals',()=>{
 const empty=summarizeArenaActivity([],{},now);assert.equal(empty.source.status,'connected');assert.equal(empty.summary.tests,0);assert.deepEqual(empty.records,[]);
 const broken=summarizeArenaActivity([person('bad',{runs:[run('missing-score',{ranked:true,rankTime:null})]})],{},now);
 assert.equal(broken.source.status,'partial');assert.equal(broken.summary.tests,null);assert.equal(broken.summary.onlineCounts['24h'],null);assert.equal(broken.records[0].best,null);
});
test('default map/mode are chosen inside selected window and mode follows latest result',()=>{
 const data=[person('a',{runs:[run('old-quick',{quickPractice:true,createdAt:new Date(now-2*day).toISOString()}),run('full',{createdAt:new Date(now-1000).toISOString()}),run('old-map',{mapId:'old-map',createdAt:new Date(now-2*day).toISOString()})]})];
 const result=summarizeArenaActivity(data,{},now);assert.equal(result.mode,'full');assert.deepEqual(result.maps.map(map=>map.id),['map-a']);assert.equal(result.summary.tests,1);
});
test('adapter traverses accounts without presence and caps unreadable reads without inventing zero',async()=>{
 const db={prepare:sql=>({all:async()=>({results:sql.includes('WITH accounts')?[{email:'a@test.cn',displayName:'A'}]:[]})})};
 const overview=createArenaAdmin({db,ownerFor:()=> 'owner',clock:()=>now,activity:async()=>({runs:[run('from-history')],jobs:[],hasMore:false})});
 assert.equal((await overview({})).summary.active,1);
 const timeout=createArenaAdmin({db,ownerFor:()=> 'owner',clock:()=>now,budgetMs:10,activity:async()=>new Promise(()=>{})});
 const result=await timeout({});assert.equal(result.source.status,'partial');assert.equal(result.summary.tests,null);assert.equal(result.summary.onlineCounts['7d'],null);
});
