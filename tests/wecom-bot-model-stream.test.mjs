import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from '../chat-cloudflare/src/app.mjs';
import { D1DatabaseAdapter } from '../chat-cloudflare/test/d1-adapter.mjs';
import { encryptSecret } from '../chat-cloudflare/src/crypto.mjs';
import { OA_CHAT_PATH, signOaChatRequest, validOaChatPayload } from '../chat-cloudflare/src/oa-chat-bridge.mjs';
import { readModelSse } from '../chat-cloudflare/src/wecom-oa-answer-stream.mjs';

const secret = 's'.repeat(48);
const encoder = new TextEncoder();
const docs = [{ id: '1', title: '内部机器人记录', body: '先解除急停再复位。PRIVATE-EVIDENCE-ONLY', updatedAt: '2026-10-01', origin: 'oa_internal', assets: [] }];
const payload = () => ({ operation: 'answer_stream', question: '机器人如何复位？', history: [], documents: docs });
const packet = (text = '', finish = null, extra = {}) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text, ...extra }, finish_reason: finish }] }) + '\n\n';
const end = 'data: [DONE]\n\n';
function sse(text, finish = 'stop') {
  return new Response(packet(text) + packet('', finish) + end, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
async function fixture(t, fetcher) {
  const database = new D1DatabaseAdapter(); t.after(() => database.close());
  const env = { DB: database, APP_ORIGIN: 'https://chat.omindos.ai', ADMIN_EMAIL: 'owner@example.test', APP_ENCRYPTION_KEY: 'e'.repeat(48), RATE_LIMIT_HMAC_KEY: 'r'.repeat(48), PUBLIC_LAB_AI_SERVICE_TOKEN: secret };
  const config = { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'configured-qwen', encryptedKey: await encryptSecret('synthetic-provider-key', env.APP_ENCRYPTION_KEY), verifiedAt: '2026-10-01' };
  await database.prepare('INSERT INTO settings(id,value) VALUES (?,?)').bind('model', JSON.stringify(config)).run();
  const calls = [];
  return { env, calls, async reply(value = payload(), { headers: changed = {}, signal } = {}) {
    const body = JSON.stringify(value);
    const headers = { ...await signOaChatRequest(body, secret), ...changed };
    const request = new Request(env.APP_ORIGIN + OA_CHAT_PATH, { method: 'POST', headers, body, signal });
    return handleRequest(request, env, {}, { fetch: async (url, init) => {
      calls.push({ url, init });
      return fetcher(url, init, calls.length);
    } });
  } };
}
async function records(response) {
  return (await response.text()).trim().split('\n').map(line => JSON.parse(line));
}

test('true model streaming delivers the first filtered paragraph before upstream finishes', async t => {
  let upstream;
  const source = new ReadableStream({ start(controller) { upstream = controller; controller.enqueue(encoder.encode(packet('**先解除急停**，再复位。[1]\n\n'))); } });
  let completed = false;
  const f = await fixture(t, (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.stream, true); assert.equal(request.enable_thinking, false); assert.equal(request.max_tokens, 2000);
    assert.match(request.messages[0].content, /60至150字/u);
    return new Response(source, { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await f.reply();
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.match(response.headers.get('cache-control'), /private, no-store/u);
  const reader = response.body.getReader();
  const first = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  assert.deepEqual(first, { type: 'delta', text: '**先解除急停**，再复位。' });
  assert.equal(completed, false);
  upstream.enqueue(encoder.encode(packet('检查安全区域。[1]') + packet('', 'stop') + end)); upstream.close(); completed = true;
  const rest = [];
  for (;;) { const { value, done } = await reader.read(); if (done) break; rest.push(JSON.parse(new TextDecoder().decode(value))); }
  assert.deepEqual(rest, [{ type: 'delta', text: '\n\n检查安全区域。' }, { type: 'done' }]);
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify([first, ...rest]), /PRIVATE-EVIDENCE|内部机器人记录/u);
});

for (const answer of ['复位即可。\n\n', '复位。[2]\n\n', '联系 13800138000。[1]\n\n', '访问 https://example.test 。[1]\n\n', '邮箱 owner@example.test 。[1]\n\n']) {
  test('grounded paragraphs lacking valid evidence or containing contact details never leave the stream', async t => {
    const f = await fixture(t, () => sse(answer));
    assert.deepEqual(await records(await f.reply()), [{ type: 'error', code: 'unavailable' }]);
  });
}

test('general answers use real streaming with no evidence and retain existing contact filtering', async t => {
  const f = await fixture(t, (_url, init) => {
    const messages = JSON.parse(init.body).messages;
    assert.doesNotMatch(messages[0].content, /PRIVATE-EVIDENCE|内部机器人记录/u);
    return sse('标准大气压下，水的沸点通常是100摄氏度。\n\n');
  });
  const value = { operation: 'answer_stream', answerType: 'general', question: '水的沸点是多少？', history: [], documents: [] };
  assert.deepEqual(await records(await f.reply(value)), [{ type: 'delta', text: '标准大气压下，水的沸点通常是100摄氏度。' }, { type: 'done' }]);
  assert.equal(validOaChatPayload({ ...value, documents: docs }), false);
});

test('stream opt-in keeps HMAC authentication and paid-call replay protection', async t => {
  const f = await fixture(t, () => sse('确认安全后复位。[1]'));
  const body = JSON.stringify(payload());
  const signed = await signOaChatRequest(body, secret);
  const make = headers => new Request(f.env.APP_ORIGIN + OA_CHAT_PATH, { method: 'POST', headers, body });
  const runtime = { fetch: async () => { f.calls.push({}); return sse('确认安全后复位。[1]'); } };
  const unsigned = { ...signed }; delete unsigned.authorization;
  assert.equal((await handleRequest(make(unsigned), f.env, {}, runtime)).status, 401);
  assert.equal(f.calls.length, 0);
  const request = make(signed); const replay = request.clone();
  assert.equal((await records(await handleRequest(request, f.env, {}, runtime))).at(-1).type, 'done');
  assert.equal((await handleRequest(replay, f.env, {}, runtime)).status, 503);
  assert.equal(f.calls.length, 1);
});

test('length stops permit one bounded continuation and consume another budget slot', async t => {
  const f = await fixture(t, (_url, init, index) => {
    const messages = JSON.parse(init.body).messages;
    if (index === 1) return sse('先解除急停。[1]\n\n然后检查', 'length');
    assert.equal(messages.at(-2).role, 'assistant');
    assert.equal(messages.at(-2).content, '先解除急停。[1]\n\n然后检查');
    assert.match(messages.at(-1).content, /断点继续/u);
    return sse('传感器。[1]');
  });
  const result = await records(await f.reply());
  assert.deepEqual(result, [{ type: 'delta', text: '先解除急停。' }, { type: 'delta', text: '\n\n然后检查传感器。' }, { type: 'done' }]);
  assert.equal(f.calls.length, 2);
  const budget = await f.env.DB.prepare("SELECT count FROM limits WHERE key LIKE 'model-day:%'").first();
  assert.equal(budget.count, 2);
});

test('consumer cancellation promptly aborts the paid upstream and cancels its body', async t => {
  let upstream; let cancelled = false; let signal;
  const f = await fixture(t, (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({
      start(controller) { upstream = controller; upstream.enqueue(encoder.encode(packet('先解除急停。[1]\n\n'))); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const reader = (await f.reply()).body.getReader();
  assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type, 'delta');
  await reader.cancel();
  assert.equal(signal.aborted, true); assert.equal(cancelled, true);
  assert.equal(f.calls.length, 1);
});

test('request abort while awaiting more tokens never reports completion', async t => {
  const abort = new AbortController(); let modelSignal;
  const f = await fixture(t, (_url, init) => {
    modelSignal = init.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(packet('先解除急停。[1]\n\n'))); } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const reader = (await f.reply(payload(), { signal: abort.signal })).body.getReader();
  await reader.read(); const waiting = reader.read(); abort.abort();
  await assert.rejects(waiting, /OA_ANSWER_STREAM_UNAVAILABLE/u);
  assert.equal(modelSignal.aborted, true);
});

test('split UTF-8 and CRLF SSE frames are decoded safely and reasoning tokens stay private', async () => {
  const data = packet('答案。', null, { reasoning_content: 'PRIVATE-REASONING' }).replaceAll('\n', '\r\n') + packet('', 'stop').replaceAll('\n', '\r\n') + end.replaceAll('\n', '\r\n');
  const bytes = encoder.encode(data); let index = 0;
  const response = new Response(new ReadableStream({ pull(controller) { if (index >= bytes.length) return controller.close(); controller.enqueue(bytes.slice(index, ++index)); } }), { headers: { 'content-type': 'text/event-stream' } });
  const deltas = [];
  for await (const delta of readModelSse(response, new AbortController().signal)) deltas.push(delta);
  assert.deepEqual(deltas, [{ text: '答案。', finishReason: null }, { text: '', finishReason: 'stop' }]);
  assert.doesNotMatch(JSON.stringify(deltas), /PRIVATE-REASONING/u);
});

for (const body of [packet('未完成回答。'), 'data: invalid-json\n\n' + end, packet('答复。', 'content_filter') + end]) {
  test('malformed, interrupted or filtered model streams fail closed', async t => {
    const f = await fixture(t, () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    assert.deepEqual(await records(await f.reply()), [{ type: 'error', code: 'unavailable' }]);
  });
}

test('redirects are never followed and model error bodies are cancelled without inspection', async t => {
  let cancelled = false;
  const f = await fixture(t, (_url, init) => {
    assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { location: 'https://example.test', 'content-type': 'text/event-stream' } });
  });
  assert.deepEqual(await records(await f.reply()), [{ type: 'error', code: 'unavailable' }]);
  assert.equal(cancelled, true);
});

for (const answer of ['联系电话：+44 20 7946 0958。[1]', '电话：+8613812345678。[1]', '[联系](tel:+442079460958)。[1]', '<b>复位</b>。[1]', '![设备](assets/robot.png)。[1]']) {
  test('stream-specific contact and markup filters cover punctuation and relative links', async t => {
    const f = await fixture(t, () => sse(answer + '\n\n'));
    assert.deepEqual(await records(await f.reply()), [{ type: 'error', code: 'unavailable' }]);
  });
}

for (const body of [
  packet('PRIVATE-FILTERED-PARAGRAPH。[1]\n\n', 'content_filter') + end,
  packet('', 'content_filter') + packet('PRIVATE-AFTER-FILTER。[1]\n\n', 'stop') + end,
  packet('完整答复。[1]', 'stop') + packet('PRIVATE-AFTER-STOP。[1]\n\n') + end,
]) {
  test('terminal provider state cannot be overridden or leak filtered terminal-frame content', async t => {
    const f = await fixture(t, () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    assert.deepEqual(await records(await f.reply()), [{ type: 'error', code: 'unavailable' }]);
  });
}

for (const trailer of [packet('AFTER-DONE'), end, 'invalid-trailer']) {
  test('provider DONE requires real EOF with no duplicate or trailing records', async () => {
    let index = 0; const chunks = [packet('答案。', 'stop') + end, trailer];
    const response = new Response(new ReadableStream({ pull(controller) { if (index === chunks.length) return controller.close(); controller.enqueue(encoder.encode(chunks[index++])); } }), { headers: { 'content-type': 'text/event-stream' } });
    await assert.rejects(async () => { for await (const delta of readModelSse(response, new AbortController().signal)) void delta; }, /OA_ANSWER_STREAM_UNAVAILABLE/u);
  });
}

test('provider DONE cannot hide trailing incomplete UTF-8 in a later chunk', async () => {
  let index = 0;
  const response = new Response(new ReadableStream({ pull(controller) { if (index++ === 0) return controller.enqueue(encoder.encode(packet('答案。', 'stop') + end)); if (index === 2) return controller.enqueue(Uint8Array.of(0xe4)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(async () => { for await (const delta of readModelSse(response, new AbortController().signal)) void delta; });
});

test('usage-only frame after a unique terminal choice remains valid', async () => {
  const response = new Response(packet('答案。', 'stop') + 'data: {"choices":[],"usage":{"total_tokens":4}}\n\n' + end, { headers: { 'content-type': 'text/event-stream' } });
  const deltas = [];
  for await (const delta of readModelSse(response, new AbortController().signal)) deltas.push(delta);
  assert.deepEqual(deltas, [{ text: '答案。', finishReason: 'stop' }]);
});
