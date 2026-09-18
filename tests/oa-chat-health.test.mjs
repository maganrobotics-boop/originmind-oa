import assert from 'node:assert/strict';
import test from 'node:test';
import { chatHealthLights, replyOutcome } from '../lib/oa-chat-health.mjs';
const ready = { kind:'ready', at:10, data:{ authorized:true, bridgeReady:true, modelReady:true, budgetReady:true, knowledgeReady:true, retrievalReady:true } };
const idle = { state:'idle', at:0 };

test('each circle has an independent stable meaning; no answer is not a successful answer', () => {
 const lights=chatHealthLights(ready,idle);
 assert.deepEqual(lights.map(x=>x.label),['网络连接','OA 成员身份','共享模型服务','知识检索','本次回答']);
 assert.deepEqual(lights.map(x=>x.state),['ready','ready','ready','ready','unknown']);
});
test('a retrieval-only HTTP 200 response is not successful model generation',()=>{
 const outcome=replyOutcome({mode:'retrieval',fallbackReason:'shared_model_unavailable'},20);
 assert.equal(outcome.state,'degraded');
 assert.deepEqual(chatHealthLights(ready,outcome).map(x=>x.state),['ready','ready','unavailable','ready','unavailable']);
});
test('stale status completion cannot overwrite the later answer failure',()=>{
 const failure=replyOutcome({mode:'retrieval'},20);
 assert.equal(chatHealthLights({...ready,at:15},failure)[2].state,'unavailable');
 assert.equal(chatHealthLights({...ready,at:30},failure)[4].state,'unavailable');
});
test('the fifth circle becomes green only after an actual complete answer',()=>{
 assert.equal(chatHealthLights(ready,{state:'asking',at:20})[4].state,'attention');
 assert.equal(chatHealthLights(ready,replyOutcome({mode:'ai'},30))[4].state,'ready');
});
test('model budget failure must not turn successful knowledge retrieval red',()=>{
 const lights=chatHealthLights({...ready,data:{...ready.data,budgetReady:false}},idle);
 assert.equal(lights[2].state,'unavailable');assert.equal(lights[3].state,'ready');
});
for(const httpStatus of [429,500,503]) test(`HTTP ${httpStatus} is not evidence of invalid member identity`,()=>{
 const lights=chatHealthLights({kind:'http',at:10,httpStatus},idle);
 assert.equal(lights[0].state,'ready');assert.equal(lights[1].state,'unknown');assert.equal(lights[2].state,'unknown');
});
for(const httpStatus of [401,403]) test(`HTTP ${httpStatus} correctly identifies an admission failure`,()=>{
 assert.equal(chatHealthLights({kind:'http',at:10,httpStatus},idle)[1].state,'unavailable');
});
test('malformed or incomplete status data stays unknown, not all red',()=>{
 assert.equal(chatHealthLights({kind:'ready',at:10,data:{}},idle)[2].state,'unknown');
 assert.equal(chatHealthLights({kind:'invalid',at:10},idle)[0].state,'ready');
});
test('missing evidence and explicit cancellation are not model failures',()=>{
 const absent=chatHealthLights(ready,replyOutcome({mode:'no_evidence'},20));
 assert.equal(absent[3].state,'attention');assert.equal(absent[4].state,'attention');
 assert.equal(chatHealthLights(ready,{state:'stopped',at:20})[2].state,'ready');
});
test('network status failure does not fabricate authentication or model failure',()=>{
 assert.deepEqual(chatHealthLights({kind:'network',at:20},idle).slice(0,3).map(x=>x.state),['unavailable','unknown','unknown']);
});
