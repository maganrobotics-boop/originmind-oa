import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { signBotBody } from '../lib/wecom-bot-contract.mjs';
import { signOaChatRequest } from '../chat-cloudflare/src/oa-chat-bridge.mjs';

const key = '__wecomStreamRuntime';
const root = fileURLToPath(new URL('..', import.meta.url));
const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
globalThis[key] = {};
const vite = await createServer({ appType: 'custom', configFile: false, root, server: { middlewareMode: true, hmr: false },
  plugins: [{ name: 'private-wecom-stream-fixture', enforce: 'pre',
    resolveId(source) {
      if (source === 'cloudflare:workers') return '\0wecom-env';
      if (/wecom-bot-store$/u.test(source)) return '\0wecom-store';
      if (source.endsWith('/_lib/auth')) return '\0wecom-auth';
      if (/knowledge-policy$/u.test(source)) return '\0wecom-rank';
      if (/oa-chat-client$/u.test(source)) return '\0wecom-old-answer';
      return null;
    },
    load(id) {
      if (id === '\0wecom-env') return `export const env = new Proxy({}, {get(_t,p){return globalThis.${key}.env[p]}});`;
      if (id === '\0wecom-rank') return 'export const rankKnowledgeChunks = (_q,chunks)=>chunks;';
      if (id === '\0wecom-old-answer') return `export async function answerOaChatQuestion(){globalThis.${key}.oldAnswers++;return {answer:'旧JSON完整回答。'}};`;
      if (id === '\0wecom-auth') return `export async function getAuthorizedIntegrationMember(member,account){const s=globalThis.${key};if(member!=='member-1'||account!=='account-1')throw Error('forged identity');s.authCalls++;if(s.authGate)await s.authGate;return s.actor;}`;
      if (id === '\0wecom-store') return `
        const state=()=>globalThis.${key};
        export async function claimBotMessage(m){const s=state();if(!s.claimAllowed||s.claims.has(m.messageId))return false;s.claims.add(m.messageId);return true;}
        export async function claimBotPairing(){return true;}
        export async function getBotSenderLink(){return state().link;}
        export async function isBotLinkCurrent(){return state().linkCurrent;}
        export async function isBotKnowledgeCurrent(){state().evidenceCalls++;return state().evidenceCurrent;}
        export async function getBotActiveKnowledgeChunks(){return state().chunks;}
        export async function listBotOwnWorkItems(){return [];}
        export async function unlinkBotActor(){return true;}
      `;
      return null;
    },
  }],
});
const helper = await vite.ssrLoadModule('/lib/wecom-bot-answer-stream.ts');
const route = await vite.ssrLoadModule('/app/api/integrations/wecom-bot/messages/route.ts');
const chunk = { itemId: 'item-1', revisionId: 'revision-1', title: '内部测试资料', content: 'PRIVATE-AUTHORIZED-EVIDENCE', updatedAt: '2026-10-01', category: 'research' };
beforeEach(() => {
  const state = globalThis[key] = {
    env: { WECOM_BOT_ENABLED: 'true', WECOM_BOT_ID: 'bot-1', WECOM_BOT_BRIDGE_SECRET: 'b'.repeat(43), PUBLIC_LAB_AI_SERVICE_TOKEN: 's'.repeat(48) },
    actor: { memberId: 'member-1', accountUserId: 'account-1', memberMutationRevision: 'member-revision-1', isAdmin: false, ndaCompleted: true, ndaApprovalId: 'nda-1', ndaAgreementVersion: 'v1', ndaAcceptedAt: '2026-09-01' },
    link: { bot_id: 'bot-1', user_id: 'sender-1', member_id: 'member-1', account_user_id: 'account-1', revision: 'link-1' },
    claims: new Set(), claimAllowed: true, linkCurrent: true, evidenceCurrent: true, chunks: [chunk], calls: [], oldAnswers: 0, authCalls: 0, evidenceCalls: 0, cancelled: false, publicCalls: 0,
  };
  globalThis.fetch = async () => { state.publicCalls++; throw Error('anonymous fetch prohibited'); };
  state.env.CHAT_SERVICE = { async fetch(url, init) {
    state.calls.push({ url, init });
    if (state.response) return state.response;
    return new Response(JSON.stringify({ type: 'delta', text: '完整授权回答。' }) + '\n' + JSON.stringify({ type: 'done' }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
  } };
});
after(async () => { globalThis.fetch = originalFetch; delete globalThis[key]; await vite.close(); });
async function request(text = '机器人如何复位？', options = {}) {
  const state = globalThis[key];
  const body = JSON.stringify({ botId: 'bot-1', userId: 'sender-1', messageId: options.messageId || 'message-1', text });
  const timestamp = String(Date.now());
  return new Request('https://oa.omindos.cn/api/integrations/wecom-bot/messages', {
    method: 'POST', body, signal: options.signal,
    headers: { 'content-type': 'application/json', accept: options.accept || 'application/x-ndjson', 'x-oa-bot-timestamp': timestamp, 'x-oa-bot-signature': await signBotBody(state.env.WECOM_BOT_BRIDGE_SECRET, timestamp, body) },
  });
}
const record = value => JSON.parse(new TextDecoder().decode(value));

test('OA streams via its unchanged HMAC service binding with only authorized bounded evidence', async () => {
  const state = globalThis[key];
  const values = [];
  for await (const value of helper.streamBotOaAnswer('机器人如何复位？', [chunk], new AbortController().signal)) values.push(value);
  assert.deepEqual(values, ['完整授权回答。']);
  assert.equal(state.calls.length, 1); assert.equal(state.publicCalls, 0);
  const { url, init } = state.calls[0];
  assert.equal(url, 'https://chat.omindos.ai/api/internal/oa-answer');
  assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
  assert.equal(init.headers.accept, 'application/x-ndjson');
  const signed = await signOaChatRequest(init.body, state.env.PUBLIC_LAB_AI_SERVICE_TOKEN, { now: Number(init.headers['x-oa-chat-time']) * 1000, nonce: init.headers['x-oa-chat-nonce'] });
  assert.equal(signed.authorization, init.headers.authorization);
  const payload = JSON.parse(init.body);
  assert.equal(payload.operation, 'answer_stream'); assert.equal(payload.answerType, 'grounded');
  assert.equal(payload.documents[0].origin, 'oa_internal'); assert.equal(payload.documents[0].body, chunk.content);
  assert.equal(init.headers.cookie, undefined); assert.equal(init.headers.origin, undefined);
  assert.equal(Object.keys(payload).sort().join(','), 'answerType,documents,history,operation,question');
});

test('OA route rechecks actor and current evidence before every emitted part', async () => {
  const state = globalThis[key];
  const response = await route.POST(await request());
  const reader = response.body.getReader();
  assert.deepEqual(record((await reader.read()).value), { type: 'delta', text: '完整授权回答。' });
  assert.deepEqual(record((await reader.read()).value), { type: 'done' });
  assert.equal((await reader.read()).done, true);
  assert.ok(state.authCalls >= 6); assert.ok(state.evidenceCalls >= 5);
  assert.equal(state.oldAnswers, 0);
});

test('revoked binding between paragraphs blocks further internal output and aborts upstream', async () => {
  const state = globalThis[key];
  state.response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode('{"type":"delta","text":"第一段。"}\n{"type":"delta","text":"PRIVATE-SECOND-PARAGRAPH"}\n{"type":"done"}\n')); },
    cancel() { state.cancelled = true; },
  }), { headers: { 'content-type': 'application/x-ndjson' } });
  const reader = (await route.POST(await request())).body.getReader();
  assert.deepEqual(record((await reader.read()).value), { type: 'delta', text: '第一段。' });
  state.linkCurrent = false;
  assert.deepEqual(record((await reader.read()).value), { type: 'error', code: 'revoked' });
  assert.equal((await reader.read()).done, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.calls[0].init.signal.aborted, true); assert.equal(state.cancelled, true);
});

test('evidence revoked while waiting for model data blocks that pending paragraph', async () => {
  const state = globalThis[key]; let upstream; let start;
  const started = new Promise(resolve => { start = resolve; });
  state.env.CHAT_SERVICE.fetch = async (_url, init) => {
    state.calls.push({ init }); start();
    return new Response(new ReadableStream({ start(controller) { upstream = controller; }, cancel() { state.cancelled = true; } }), { headers: { 'content-type': 'application/x-ndjson' } });
  };
  const reader = (await route.POST(await request())).body.getReader();
  const pending = reader.read(); await started;
  state.evidenceCurrent = false;
  upstream.enqueue(encoder.encode('{"type":"delta","text":"PRIVATE-PENDING-PARAGRAPH"}\n'));
  assert.deepEqual(record((await pending).value), { type: 'error', code: 'revoked' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.calls[0].init.signal.aborted, true); assert.equal(state.cancelled, true);
});

test('cancel during awaited authorization cannot enqueue another buffered paragraph', async () => {
  const state = globalThis[key];
  state.response = new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('{"type":"delta","text":"第一段。"}\n{"type":"delta","text":"PRIVATE-PENDING"}\n{"type":"done"}\n')); }, cancel() { state.cancelled = true; } }), { headers: { 'content-type': 'application/x-ndjson' } });
  const reader = (await route.POST(await request())).body.getReader();
  await reader.read();
  let release;
  state.authGate = new Promise(resolve => { release = resolve; });
  const pending = reader.read();
  const cancellation = reader.cancel();
  release(); await cancellation;
  assert.equal((await pending).done, true);
  assert.equal(state.calls[0].init.signal.aborted, true); assert.equal(state.cancelled, true);
});

for (const mutation of [state => { state.actor.ndaCompleted = false; }, state => { state.linkCurrent = false; }, state => { state.claimAllowed = false; }]) {
  test('NDA, binding and message-rate admission denial prevents a paid stream', async () => {
    const state = globalThis[key]; mutation(state);
    const response = await route.POST(await request());
    assert.deepEqual(await response.json(), { ok: true, reply: '' });
    assert.equal(state.calls.length, 0);
  });
}

test('replay, ordinary commands and old JSON callers preserve existing behavior', async () => {
  const state = globalThis[key];
  assert.deepEqual(await (await route.POST(await request('/待办'))).json(), { ok: true, reply: '你目前没有负责或创建的未完成工作项。' });
  assert.deepEqual(await (await route.POST(await request('机器人如何复位？'))).json(), { ok: true, reply: '' });
  assert.equal(state.calls.length, 0);
  assert.deepEqual(await (await route.POST(await request('机器人如何复位？', { messageId: 'message-2', accept: 'application/json' }))).json(), { ok: true, reply: '旧JSON完整回答。' });
  assert.equal(state.oldAnswers, 1);
});

for (const trailer of ['{"type":"delta","text":"AFTER-DONE"}\n', '{"type":"done"}\n', 'invalid-trailer']) {
  test('authenticated completion must reach strict EOF without later records', async () => {
    const state = globalThis[key]; const pieces = ['{"type":"delta","text":"答复。"}\n{"type":"done"}\n', trailer]; let i = 0;
    state.response = new Response(new ReadableStream({ pull(controller) { if (i === pieces.length) return controller.close(); controller.enqueue(encoder.encode(pieces[i++])); } }), { headers: { 'content-type': 'application/x-ndjson' } });
    const values = [];
    await assert.rejects(async () => { for await (const value of helper.streamBotOaAnswer('机器人如何复位？', [chunk], new AbortController().signal)) values.push(value); }, /WECOM_ANSWER_STREAM_UNAVAILABLE/u);
    assert.deepEqual(values, ['答复。']);
  });
}

test('trailing incomplete UTF-8 after done is rejected by fatal decoder', async () => {
  const state = globalThis[key]; let i = 0;
  state.response = new Response(new ReadableStream({ pull(controller) { if (i++ === 0) return controller.enqueue(encoder.encode('{"type":"delta","text":"答复。"}\n{"type":"done"}\n')); if (i === 2) return controller.enqueue(Uint8Array.of(0xe4)); controller.close(); } }), { headers: { 'content-type': 'application/x-ndjson' } });
  await assert.rejects(async () => { for await (const value of helper.streamBotOaAnswer('机器人如何复位？', [chunk], new AbortController().signal)) void value; });
});

test('missing evidence answers locally without outbound model or copied raw excerpts', async () => {
  const state = globalThis[key];
  state.chunks = [];
  const response = await route.POST(await request());
  const text = await response.text();
  assert.match(text, /目前知识库没有找到足够依据/u);
  assert.doesNotMatch(text, /PRIVATE-AUTHORIZED/u); assert.equal(state.calls.length, 0);
});
