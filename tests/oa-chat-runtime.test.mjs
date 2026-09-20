import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { signOaChatRequest } from '../chat-cloudflare/src/oa-chat-bridge.mjs';

const stateKey = '__oaChatRuntimeBindingTest';
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
globalThis[stateKey] = {};
const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType:'custom', configFile:false, root,
  server:{middlewareMode:true,hmr:false},
  plugins:[{ name:'oa-chat-runtime-bindings', enforce:'pre',
    resolveId(source) {
      if (source === 'cloudflare:workers') return '\0oa-chat-test-env';
      if (/(^|\/)db$/u.test(source)) return '\0oa-chat-test-db';
      if (/knowledge-assets$/u.test(source)) return '\0oa-chat-test-assets';
      return null;
    },
    load(id) {
      if (id === '\0oa-chat-test-env') return `export const env = new Proxy({}, { get(_target,key) { return globalThis.${stateKey}.env[key]; } });`;
      if (id === '\0oa-chat-test-db') return 'export async function getDb() { throw new Error("Unexpected image database access"); }';
      if (id === '\0oa-chat-test-assets') return 'export async function listKnowledgeRevisionAssets() { return []; }';
      return null;
    },
  }],
});
const client = await vite.ssrLoadModule('/lib/oa-chat-client.ts');
beforeEach(() => {
  globalThis[stateKey] = { env:{PUBLIC_LAB_AI_SERVICE_TOKEN:'s'.repeat(43)}, calls:[], publicCalls:0, warnings:[], reply:{received:true,bridgeReady:true,modelReady:true,budgetReady:true,answer:'**完整回答**。',mode:'ai'} };
  const state = globalThis[stateKey];
  console.warn = (...args) => state.warnings.push(args);
  globalThis.fetch = async () => {
    state.publicCalls++;
    throw new Error('Same-zone public-network fetch must not be used');
  };
  state.env.CHAT_SERVICE = {
    async fetch(url, init) {
      // Retain compatibility with workerd versions that reject redirect: 'error'.
      // This is a conservative test double, not a production runtime probe.
      if (init.redirect !== undefined && !['follow','manual'].includes(init.redirect)) {
        throw new TypeError('legacy workerd only accepts follow or manual redirect modes');
      }
      assert.equal(this, state.env.CHAT_SERVICE);
      state.calls.push({url,init});
      if (state.error) throw state.error;
      return state.response || Response.json(state.reply);
    },
  };
});
after(async () => { globalThis.fetch=originalFetch; console.warn=originalWarn; delete globalThis[stateKey]; await vite.close(); });
const chunk = { itemId:'11111111-2222-4333-8444-555555555555',revisionId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',title:'内部测试资料',content:'内部测试正文，不得拼接成未经模型生成的答复。',updatedAt:'2026-09-17',category:'research',sectionTitle:'测试',paragraphRef:'1' };

test('OA uses the signed service binding even when same-zone public fetch is unavailable', async () => {
  assert.deepEqual(await client.oaChatModelStatus(),{bridgeReady:true,modelReady:true,budgetReady:true});
  const {url,init}=globalThis[stateKey].calls[0];
  assert.equal(url,'https://chat.omindos.ai/api/internal/oa-answer');
  assert.equal(globalThis[stateKey].publicCalls,0);
  assert.equal(init.cache,'no-store'); assert.equal(init.redirect,'manual'); assert.equal(init.credentials,'omit');
  assert.equal(init.headers.cookie,undefined); assert.equal(init.headers.origin,undefined);
  assert.deepEqual(JSON.parse(init.body),{operation:'status'});
  const headers=await signOaChatRequest(init.body,globalThis[stateKey].env.PUBLIC_LAB_AI_SERVICE_TOKEN,{now:Number(init.headers['x-oa-chat-time'])*1000,nonce:init.headers['x-oa-chat-nonce']});
  assert.equal(init.headers.authorization,headers.authorization);
  assert.ok(!JSON.stringify(init).includes(globalThis[stateKey].env.PUBLIC_LAB_AI_SERVICE_TOKEN));
});

test('OA sends a bounded authorized context and keeps internal image access local', async () => {
  const result=await client.answerOaChatQuestion('请说明测试结果',Array.from({length:8},(_,index)=>({...chunk,title:`资料 ${index}`,content:'甲'.repeat(4000)})),[{role:'user',content:'之前的问题'}]);
  assert.equal(result.answer,'**完整回答**。'); assert.equal(result.citations.length,6); assert.deepEqual(result.images,[]);
  const payload=JSON.parse(globalThis[stateKey].calls[0].init.body);
  assert.equal(payload.documents.length,6); assert.ok(payload.documents.every(document=>document.body.length===3500 && document.origin==='oa_internal'));
  assert.deepEqual(payload.history,[{role:'user',content:'之前的问题'}]);
});

test('a missing Worker credential fails closed before any outbound request or raw-evidence fallback', async () => {
  globalThis[stateKey].env={};
  assert.deepEqual(await client.oaChatModelStatus(),{bridgeReady:false,modelReady:false,budgetReady:false});
  const result=await client.answerOaChatQuestion('请说明测试结果',[chunk]);
  assert.equal(result.mode,'retrieval'); assert.equal(result.fallbackReason,'shared_model_unavailable');
  assert.ok(!result.answer.includes(chunk.content)); assert.equal(globalThis[stateKey].calls.length,0);
});

test('no authorized evidence means no model request', async () => {
  const result=await client.answerOaChatQuestion('请说明测试结果',[]);
  assert.equal(result.mode,'no_evidence'); assert.equal(globalThis[stateKey].calls.length,0);
});

test('ordinary general knowledge bypasses weak OA retrieval matches and is labeled', async () => {
  globalThis[stateKey].reply={received:true,answer:'水在标准大气压下的沸点通常是 100 摄氏度。',mode:'general',provider:'bailian'};
  const result=await client.answerOaChatQuestion('水的沸点是多少？',[chunk]);
  assert.equal(result.mode,'general'); assert.equal(result.sourceType,'model_general_knowledge');
  assert.match(result.answer,/来源类型：模型通用知识/u);
  const payload=JSON.parse(globalThis[stateKey].calls[0].init.body);
  assert.equal(payload.answerType,'general'); assert.deepEqual(payload.documents,[]);
});

test('retrieval is bypassed only for unmistakable general questions', () => {
  for (const question of ['今天深圳天气如何？','水的沸点是多少？','100 美元换算成人民币']) {
    assert.equal(client.questionPrefersGeneralKnowledge(question),true,question);
  }
  for (const question of ['研究方向是什么？','详细介绍研究方向','请解释数学模型']) {
    assert.equal(client.questionPrefersGeneralKnowledge(question),false,question);
  }
});

test('internal and project questions still require approved OA evidence', async () => {
  for (const question of ['我们项目进度怎么样？','OA 审批流程是什么？','机器人底盘如何复位？']) {
    assert.equal(client.questionRequiresKnowledgeEvidence(question),true);
    const result=await client.answerOaChatQuestion(question,[]);
    assert.equal(result.mode,'no_evidence'); assert.equal(result.sourceType,'oa_knowledge_required');
  }
  assert.equal(globalThis[stateKey].calls.length,0);
});

test('oversized model answers are rejected rather than silently truncated', async () => {
  globalThis[stateKey].reply.answer='甲'.repeat(12001);
  await assert.rejects(client.answerOaChatQuestion('请说明测试结果',[chunk]),/CHAT_BRIDGE_INVALID_ANSWER/u);
});


test('missing service binding fails closed without a public-network fallback', async () => {
  delete globalThis[stateKey].env.CHAT_SERVICE;
  assert.deepEqual(await client.oaChatModelStatus(),{bridgeReady:false,modelReady:false,budgetReady:false});
  const result = await client.answerOaChatQuestion('请说明测试结果',[chunk]);
  assert.equal(result.fallbackReason,'shared_model_unavailable');
  assert.deepEqual(result.citations,[]); assert.deepEqual(result.images,[]);
  assert.equal(globalThis[stateKey].publicCalls,0); assert.equal(globalThis[stateKey].calls.length,0);
  assert.deepEqual(globalThis[stateKey].warnings,[['OA_CHAT_BRIDGE_FAILURE','CHAT_BRIDGE_SERVICE_BINDING_MISSING']]);
});

for (const status of [301,302,303,307,308,401,403,404,429,503]) {
  test(`service HTTP ${status} produces only a safe diagnostic and never retries publicly`, async () => {
    const state = globalThis[stateKey];
    const headers = status < 400 ? {location:'https://untrusted.example/never-follow'} : {};
    state.response = new Response(`private: ${chunk.content} ${state.env.PUBLIC_LAB_AI_SERVICE_TOKEN}`,{status,headers});
    const result = await client.answerOaChatQuestion('请说明测试结果',[chunk]);
    assert.equal(result.fallbackReason,'shared_model_unavailable');
    assert.deepEqual(state.warnings,[['OA_CHAT_BRIDGE_FAILURE',`CHAT_BRIDGE_HTTP_${status}`]]);
    assert.ok(!JSON.stringify(result).includes(chunk.content));
    assert.equal(state.calls.length,status === 429 || status >= 500 ? 2 : 1); assert.equal(state.publicCalls,0);
  });
}

test('transport errors and timeouts never log private upstream exception messages', async () => {
  const state = globalThis[stateKey];
  for (const name of ['Error','TimeoutError','AbortError']) {
    state.error = new Error(`private ${chunk.content} ${state.env.PUBLIC_LAB_AI_SERVICE_TOKEN}`);
    state.error.name = name;
    const result = await client.answerOaChatQuestion('请说明测试结果',[chunk]);
    assert.equal(result.fallbackReason,'shared_model_unavailable');
    assert.deepEqual(state.warnings.at(-1),['OA_CHAT_BRIDGE_FAILURE',name === 'Error' ? 'CHAT_BRIDGE_TRANSPORT_ERROR' : 'CHAT_BRIDGE_TIMEOUT']);
  }
  assert.equal(state.publicCalls,0); assert.equal(state.calls.length,6);
});

test('one transient grounded failure is retried and can recover without exposing evidence', async () => {
  const state = globalThis[stateKey]; let attempts = 0;
  state.env.CHAT_SERVICE.fetch = async function(url, init) {
    state.calls.push({url,init}); attempts++;
    if (attempts === 1) return new Response('', { status: 503 });
    return Response.json({ received:true, answer:'重试后生成的完整回答。', mode:'ai', provider:'bailian' });
  };
  const result = await client.answerOaChatQuestion('请说明测试结果',[chunk]);
  assert.equal(result.answer,'重试后生成的完整回答。'); assert.equal(state.calls.length,2);
  assert.deepEqual(state.warnings,[]);
});

test('invalid JSON or an unacknowledged bridge response cannot count as a generated answer', async () => {
  const state = globalThis[stateKey];
  for (const body of ['null','{}','{"received":false}','private invalid json']) {
    state.response = new Response(body,{headers:{'content-type':'application/json'}});
    const result = await client.answerOaChatQuestion('请说明测试结果',[chunk]);
    assert.equal(result.fallbackReason,'shared_model_unavailable');
    assert.deepEqual(state.warnings.at(-1),['OA_CHAT_BRIDGE_FAILURE','CHAT_BRIDGE_INVALID_RESPONSE']);
  }
  assert.equal(state.publicCalls,0);
});
