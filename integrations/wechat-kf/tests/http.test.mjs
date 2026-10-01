import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { computeSignature } from '../lib/crypto.mjs';
import { CALLBACK_PATH, createCallbackServer, MAX_CALLBACK_BYTES } from '../lib/server.mjs';
import { buildChatBody, createChatAnswer, FAILURE_TEXT, MAX_RESPONSE_BYTES, parseFinalSse } from '../lib/chat.mjs';

const config = {
  corpId: 'wwtestcorp', secret: 'not-a-real-secret', openKfId: 'wkTestKf', token: 'token123',
  encodingAESKey: Buffer.alloc(32, 7).toString('base64').slice(0, -1),
};
const modelFinal = { answer: '可以先练习 ROS 2 的 Topic。', provider: 'bailian', mode: 'ai', fallbackReason: null, sources: [] };

function envelope(plaintext, receiver = config.corpId) {
  const message = Buffer.from(plaintext);
  const length = Buffer.alloc(4); length.writeUInt32BE(message.length);
  const raw = Buffer.concat([randomBytes(16), length, message, Buffer.from(receiver)]);
  const padding = 32 - raw.length % 32;
  const key = Buffer.from(config.encodingAESKey + '=', 'base64');
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64');
}

function callbackUrl(base, encrypted, { badSignature = false, echo = false } = {}) {
  const timestamp = '1790812800'; const nonce = 'testnonce';
  const signature = badSignature ? '0'.repeat(40) : computeSignature({ token: config.token, timestamp, nonce, encrypted });
  const query = new URLSearchParams({ timestamp, nonce, msg_signature: signature });
  if (echo) query.set('echostr', encrypted);
  return `${base}${CALLBACK_PATH}?${query}`;
}

async function withServer(t, options = {}) {
  const server = createCallbackServer({ config, queueReady: true, processor: { notify: async () => {} }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function eventXml(openKfId = config.openKfId) {
  return `<xml><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[kf_msg_or_event]]></Event><OpenKfId><![CDATA[${openKfId}]]></OpenKfId><Token><![CDATA[sync-token-not-chat]]></Token></xml>`;
}

test('callback GET validates and decrypts echostr without an API secret', async (t) => {
  const base = await withServer(t, { config: { ...config, secret: '', openKfId: '' }, queueReady: false });
  const encrypted = envelope('echo-123');
  const response = await fetch(callbackUrl(base, encrypted, { echo: true }));
  assert.equal(response.status, 200); assert.equal(await response.text(), 'echo-123');
  const rejected = await fetch(callbackUrl(base, encrypted, { echo: true, badSignature: true }));
  assert.equal(rejected.status, 400);
});

test('callback POST is acknowledged only after persistence and never waits on a model', async (t) => {
  let completePersistence; let startedPersistence;
  const started = new Promise((resolve) => { startedPersistence = resolve; });
  const persisted = new Promise((resolve) => { completePersistence = resolve; });
  let seen;
  const base = await withServer(t, { processor: { notify: async (token) => { seen = token; startedPersistence(); await persisted; } } });
  const encrypted = envelope(eventXml());
  let responseResolved = false;
  const pending = fetch(callbackUrl(base, encrypted), { method: 'POST', body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>` }).then((response) => { responseResolved = true; return response; });
  await started;
  assert.equal(responseResolved, false); assert.equal(seen, 'sync-token-not-chat');
  completePersistence();
  const response = await pending;
  assert.equal(response.status, 200); assert.equal(await response.text(), 'success');
});

test('rejected signature, wrong receiver, and other account never enqueue', async (t) => {
  let count = 0;
  const base = await withServer(t, { processor: { notify: async () => { count++; } } });
  const encrypted = envelope(eventXml());
  const rejected = await fetch(callbackUrl(base, encrypted, { badSignature: true }), { method: 'POST', body: `<xml><Encrypt>${encrypted}</Encrypt></xml>` });
  assert.equal(rejected.status, 400);
  const wrongReceiver = envelope(eventXml(), 'wwdifferent');
  const wrong = await fetch(callbackUrl(base, wrongReceiver), { method: 'POST', body: `<xml><Encrypt>${wrongReceiver}</Encrypt></xml>` });
  assert.equal(wrong.status, 400);
  const otherAccount = envelope(eventXml('wkOtherKf'));
  const ignored = await fetch(callbackUrl(base, otherAccount), { method: 'POST', body: `<xml><Encrypt>${otherAccount}</Encrypt></xml>` });
  assert.equal(ignored.status, 200); assert.equal(count, 0);
});

test('callback rejects oversized body and persistence failure remains retryable', async (t) => {
  const base = await withServer(t, { processor: { notify: async () => { throw new Error('private failure'); } } });
  const encrypted = envelope(eventXml());
  const oversized = await fetch(callbackUrl(base, encrypted), { method: 'POST', body: 'x'.repeat(MAX_CALLBACK_BYTES + 1) });
  assert.equal(oversized.status, 413);
  const failed = await fetch(callbackUrl(base, encrypted), { method: 'POST', body: `<xml><Encrypt>${encrypted}</Encrypt></xml>` });
  assert.equal(failed.status, 503); assert.equal((await failed.text()).includes('private failure'), false);
});

test('health contains booleans only and incomplete configuration serves no callbacks', async (t) => {
  const base = await withServer(t, { config: { ...config, corpId: '', secret: '', openKfId: '' }, queueReady: false });
  const response = await fetch(`${base}/health`); const health = await response.json();
  assert.deepEqual(health, { ok: true, callbackReady: false, configured: false, queueReady: false, workerRunning: false });
  assert(Object.values(health).every((value) => typeof value === 'boolean'));
  const callback = await fetch(`${base}${CALLBACK_PATH}`); assert.equal(callback.status, 503);
});

test('chat adapter only calls the public loopback chat API without OA credentials or user identifiers', async () => {
  let request;
  const answer = createChatAnswer({ fetchImpl: async (url, options) => { request = { url, options }; return Response.json(modelFinal); } });
  assert.equal(await answer({ userId: 'external-user-private', text: '怎么学 ROS 2？', history: [{ role: 'user', content: '上一个问题' }] }), modelFinal.answer);
  assert.equal(request.url, 'http://127.0.0.1:3001/api/chat');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.origin, 'https://chat.omindos.cn');
  assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.cookie, undefined); assert.equal(request.options.headers.authorization, undefined);
  const body = JSON.parse(request.options.body);
  assert.equal(body.topic, 'student'); assert.equal(body.messages.at(-1).role, 'user');
  assert(body.messages.every((message) => ['user', 'assistant'].includes(message.role)));
  assert.equal(request.options.body.includes('external-user-private'), false);
  assert.equal(request.options.body.includes('sync-token-not-chat'), false);
});

test('chat history is finite, excludes injected roles, and stays under byte limit', () => {
  const body = buildChatBody({ text: '中'.repeat(200000), history: [{ role: 'system', content: 'Injected system' }, ...Array.from({ length: 20 }, () => ({ role: 'assistant', content: '中'.repeat(20000) }))] });
  assert(Buffer.byteLength(body) < 160000);
  const parsed = JSON.parse(body);
  assert.equal(parsed.messages.length, 8);
  assert.equal(body.includes('Injected system'), false);
  assert(parsed.messages.every((message) => message.content.length <= 12000));
  const longAscii = JSON.parse(buildChatBody({ text: 'a'.repeat(20000) }));
  assert.equal(longAscii.messages.at(-1).content.length, 12000);
  const surrogateBoundary = JSON.parse(buildChatBody({ text: 'a'.repeat(11999) + '😀' + 'b' }));
  assert.equal(surrogateBoundary.messages.at(-1).content.length, 11999);
  assert.equal(/\uFFFD|[\uD800-\uDBFF]$/.test(surrogateBoundary.messages.at(-1).content), false);
});

test('SSE uses only validated final and refuses draft, error, truncated, and fallback responses', async () => {
  const final = `data: ${JSON.stringify({ type: 'final', data: modelFinal })}\n\n`;
  const draft = 'data: {"type":"delta","data":{"text":"draft must never leave"}}\n\n';
  assert.equal(parseFinalSse(draft + final), modelFinal.answer);
  const failures = [draft, draft + 'data: {"type":"error","data":{"message":"fail"}}\n\n' + final,
    draft + final.trimEnd(), draft + final + 'event: error\ndata: {}\n\n',
    `data: ${JSON.stringify({ type: 'final', data: { ...modelFinal, mode: 'fallback', fallbackReason: 'failed' } })}\n\n`];
  for (const stream of failures) {
    const answer = createChatAnswer({ fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) });
    assert.equal(await answer({ text: 'test' }), FAILURE_TEXT);
  }
});

test('chat errors, oversized responses, and an aborted request return a short failure', async () => {
  for (const fetchImpl of [
    async () => new Response('private error', { status: 500 }),
    async () => Response.json({ ...modelFinal, provider: 'fallback' }),
    async () => Response.json({ ...modelFinal, mode: 'retrieval', fallbackReason: null }),
    async () => new Response('x'.repeat(MAX_RESPONSE_BYTES + 1), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const answer = createChatAnswer({ fetchImpl });
    const result = await answer({ text: 'test' });
    assert.equal(result, FAILURE_TEXT);
    assert(!result.includes('private error'));
  }
  const aborted = createChatAnswer({ fetchImpl: async (_url, { signal }) => { signal.throwIfAborted(); return Response.json(modelFinal); } });
  assert.equal(await aborted({ text: 'test', signal: AbortSignal.abort() }), FAILURE_TEXT);
});

test('SSE stream preserves split UTF-8 code points and waits for its final frame', async () => {
  const bytes = Buffer.from(`data: ${JSON.stringify({ type: 'final', data: modelFinal })}\n\n`);
  const stream = new ReadableStream({ start(controller) { for (let start = 0; start < bytes.length; start += 7) controller.enqueue(bytes.subarray(start, start + 7)); controller.close(); } });
  const answer = createChatAnswer({ fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(await answer({ text: 'test' }), modelFinal.answer);
});
