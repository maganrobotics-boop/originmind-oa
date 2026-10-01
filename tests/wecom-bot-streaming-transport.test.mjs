import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import {
  ACK_REPLY, attachBotClient, createBotMessageHandler, createBridgeClient, createSafeLogger,
  DEFAULT_BRIDGE_URL, FAILURE_REPLY, MAX_BRIDGE_BYTES, MAX_NDJSON_BYTES, MAX_STREAM_BYTES,
} from '../lib/wecom-bot-transport.mjs';

const secret = randomBytes(32).toString('base64url');
const botId = 'stream_fixture';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = (messageId = 'one', userId = 'member', overrides = {}) => ({
  cmd: 'aibot_msg_callback', headers: { req_id: 'req_' + messageId },
  body: { aibotid: botId, msgid: messageId, chattype: 'single',
    from: { userid: userId }, msgtype: 'text', text: { content: 'isolated question' }, ...overrides },
});
const ndjson = (events) => events.map((event) => JSON.stringify(event) + '\n').join('');
const response = (events) => new Response(ndjson(events), { headers: { 'content-type': 'application/x-ndjson' } });
const timeout = (promise, ms = 2000) => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error('fixture deadline')), ms);
  timer.unref();
})]);
const harness = (options = {}) => {
  const replies = [];
  const logs = [];
  const handler = createBotMessageHandler({ botId,
    logger: createSafeLogger((line) => logs.push(line)),
    bridge: async () => 'command result',
    sendReply: async (...args) => replies.push(args),
    ...options,
  });
  return { handler, replies, logs };
};
async function isolatedHttpBridge(t, handleRequest, options = {}) {
  const server = createServer(handleRequest);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const source = await readFile(new URL('../lib/wecom-bot-transport.mjs', import.meta.url), 'utf8');
  const pattern = 'http://127.0.0.1:3000' + '$' + '{BRIDGE_PATH}';
  assert.equal(source.split(pattern).length, 2);
  const isolated = source.replace(pattern, 'http://127.0.0.1:' + server.address().port + '$' + '{BRIDGE_PATH}');
  const transport = await import('data:text/javascript;base64,' + Buffer.from(isolated).toString('base64'));
  return transport.createBridgeClient({ endpoint: transport.DEFAULT_BRIDGE_URL, secret, ...options });
}

test('real HTTP UTF-8 fragments deliver an authorized delta before upstream finishes, after ACK gating', async (t) => {
  const first = '研究结果😀。'.repeat(150);
  const second = '\n\n后续完整段落。';
  let incoming = 0;
  let upstream;
  let ackRelease;
  let firstContentRelease;
  const firstContent = new Promise((resolve) => { firstContentRelease = resolve; });
  const bridge = await isolatedHttpBridge(t, async (req, res) => {
    for await (const chunk of req) void chunk;
    incoming += 1;
    assert.equal(req.headers.accept, 'application/x-ndjson, application/json');
    assert.equal(req.headers.host, 'oa.omindos.cn');
    upstream = res;
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const bytes = Buffer.from(ndjson([{ type: 'delta', text: first }]));
    const offset = bytes.indexOf(Buffer.from('研')) + 1;
    res.write(bytes.subarray(0, offset));
    await new Promise((resolve) => setTimeout(resolve, 20));
    res.write(bytes.subarray(offset));
  });
  const replies = [];
  let sending = 0;
  let maxSending = 0;
  const h = harness({ bridge, sendReply: async (...args) => {
    sending += 1;
    maxSending = Math.max(maxSending, sending);
    replies.push(args);
    if (args[2] === ACK_REPLY) await new Promise((resolve) => { ackRelease = resolve; });
    if (args[2] === first) firstContentRelease();
    sending -= 1;
  } });
  const pending = h.handler.handle(frame());
  await tick();
  assert.equal(incoming, 0, 'OA must wait for an acknowledged initial bubble');
  ackRelease();
  await timeout(firstContent);
  assert.equal(upstream.writableEnded, false, 'authorized content must be sent while the model response is open');
  assert.equal(replies[1][3], false);
  assert.ok(Buffer.byteLength(replies[1][2], 'utf8') > 2000);
  upstream.end(ndjson([{ type: 'delta', text: second }, { type: 'done' }]));
  assert.equal(await timeout(pending), 'replied');
  assert.equal(replies.at(-1)[2], first + second);
  assert.equal(replies.at(-1)[3], true);
  assert.equal(maxSending, 1);
  assert.equal(new Set(replies.map((reply) => reply[1])).size, 1);
});

test('a long streamed answer continues in fresh bounded bubbles and never updates a finished ID', async () => {
  const text = '😀汉字'.repeat(2500);
  const events = [];
  for (let index = 0; index < text.length; index += 1024) events.push({ type: 'delta', text: text.slice(index, index + 1024) });
  events.push({ type: 'done' });
  const bridge = createBridgeClient({ endpoint: DEFAULT_BRIDGE_URL, secret, fetchImpl: async () => response(events) });
  const h = harness({ bridge });
  assert.equal(await h.handler.handle(frame()), 'replied');
  const finished = h.replies.filter((reply) => reply[3]);
  assert.equal(finished.length, 2);
  assert.equal(finished.map((reply) => reply[2]).join(''), text);
  assert.ok(h.replies.every((reply) => Buffer.byteLength(reply[2], 'utf8') <= MAX_STREAM_BYTES));
  assert.ok(h.replies.every((reply) => Buffer.from(reply[2]).toString('utf8') === reply[2]));
  for (const [index, reply] of h.replies.entries()) {
    if (reply[3]) assert.equal(h.replies.slice(index + 1).some((later) => later[1] === reply[1]), false);
  }
  assert.ok(h.replies.every((reply) => reply[0].headers.req_id === 'req_one'));
});

test('NDJSON validates terminal success, event shapes, UTF-8 and bounded wire/answer budgets', async () => {
  const cases = [
    response([{ type: 'delta', text: 'partial' }]),
    response([{ type: 'done' }, { type: 'delta', text: 'late' }]),
    response([{ type: 'delta', text: 'private', raw: 'forbidden' }, { type: 'done' }]),
    response([{ type: 'unexpected' }]),
    response([{ type: 'error', code: 'unavailable' }]),
    response([{ type: 'error', code: 'revoked' }]),
    response([{ type: 'delta', text: 'a'.repeat(12_001) }, { type: 'done' }]),
    new Response(new Uint8Array([0xff, 0x0a]), { headers: { 'content-type': 'application/x-ndjson' } }),
    new Response('a'.repeat(MAX_BRIDGE_BYTES + 1), { headers: { 'content-type': 'application/x-ndjson' } }),
    new Response('{}\n', { headers: { 'content-type': 'application/x-ndjson', 'content-length': String(MAX_NDJSON_BYTES + 1) } }),
  ];
  for (const reply of cases) {
    const bridge = createBridgeClient({ endpoint: DEFAULT_BRIDGE_URL, secret, fetchImpl: async () => reply });
    await assert.rejects(bridge({ botId, userId: 'member', messageId: 'case', text: 'fixture' }));
  }
});

test('stream failure cancels future content and ends the open bubble with a static safe error', async () => {
  const bridge = createBridgeClient({ endpoint: DEFAULT_BRIDGE_URL, secret,
    fetchImpl: async () => response([{ type: 'delta', text: 'authorized paragraph' }, { type: 'error', code: 'revoked' }]),
  });
  const h = harness({ bridge });
  assert.equal(await h.handler.handle(frame()), 'bridge_failed');
  assert.equal(h.replies[1][2], 'authorized paragraph');
  assert.equal(h.replies.at(-1)[2], FAILURE_REPLY);
  assert.equal(h.replies.at(-1)[3], true);
  assert.ok(h.logs.every((line) => !line.includes('authorized paragraph')));
});

test('disconnect aborts the real HTTP body and prevents a stale final after reauthentication', async (t) => {
  let responseClosed;
  let firstContentRelease;
  const firstContent = new Promise((resolve) => { firstContentRelease = resolve; });
  const bridge = await isolatedHttpBridge(t, async (req, res) => {
    for await (const chunk of req) void chunk;
    responseClosed = once(res, 'close');
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(ndjson([{ type: 'delta', text: 'authorized early content' }]));
  });
  const h = harness({ bridge, sendReply: async (...args) => {
    h.replies.push(args);
    if (args[2] === 'authorized early content') firstContentRelease();
  } });
  const client = new EventEmitter();
  client.disconnect = () => {};
  const runtime = attachBotClient(client, h.handler, { botId, logger: createSafeLogger(() => {}) });
  client.emit('authenticated');
  client.emit('message', frame());
  await timeout(firstContent);
  client.emit('disconnected');
  client.emit('authenticated');
  await timeout(responseClosed);
  await tick();
  assert.equal(h.replies.filter((reply) => reply[3]).length, 0);
  assert.equal(runtime.isAuthenticated(), true);
  runtime.stop();
});

test('a failed intermediate ACK cancels the body immediately and sends no final concurrently', async (t) => {
  let responseClosed;
  const bridge = await isolatedHttpBridge(t, async (req, res) => {
    for await (const chunk of req) void chunk;
    responseClosed = once(res, 'close');
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(ndjson([{ type: 'delta', text: 'authorized content' }]));
  });
  const h = harness({ bridge, replyTimeoutMs: 20, sendReply: async (...args) => {
    h.replies.push(args);
    if (args[2] !== ACK_REPLY) return new Promise(() => {});
  } });
  assert.equal(await timeout(h.handler.handle(frame())), 'reply_failed');
  await timeout(responseClosed);
  assert.equal(h.replies.length, 2);
  assert.equal(h.replies.some((reply) => reply[3]), false);
});

test('refreshes share the conversation budget and reserve space for a final complete answer', async () => {
  let time = 1790806700000;
  let streaming = false;
  const h = harness({ now: () => time, bridge: async (_, { onUpdate }) => {
    if (!streaming) return 'command result';
    let text = '';
    for (let index = 0; index < 12; index += 1) {
      text += 'paragraph ' + index + '\n';
      await onUpdate(text);
      time += 2500;
    }
    return text;
  } });
  for (let index = 0; index < 11; index += 1) assert.equal(await h.handler.handle(frame('pre_' + index)), 'replied');
  assert.equal(h.replies.length, 22);
  streaming = true;
  assert.equal(await h.handler.handle(frame('stream')), 'replied');
  const updates = h.replies.slice(22);
  assert.equal(updates.length, 5, 'ACK, first content, two reserved updates, and final');
  assert.equal(updates.at(-1)[2], Array.from({ length: 12 }, (_, index) => 'paragraph ' + index + '\n').join(''));
  assert.equal(updates.at(-1)[3], true);
  assert.equal(h.handler.getRateStats().frames, 27);
});

test('all outgoing frames obey 30 per minute, and waiting ACKs cancel without querying OA', async () => {
  let time = 1790806700000;
  let forwarded = 0;
  const h = harness({ now: () => time, bridge: async () => { forwarded += 1; return 'ok'; } });
  for (let index = 0; index < 15; index += 1) await h.handler.handle(frame('rate_' + index));
  assert.equal(h.replies.length, 30);
  const waiting = h.handler.handle(frame('waiting'));
  await tick();
  assert.equal(h.replies.length, 30);
  assert.equal(forwarded, 15);
  h.handler.stop();
  await timeout(waiting);
  assert.equal(h.replies.length, 30);
  assert.equal(forwarded, 15);
});

test('hourly frame budget is bounded and expires without retaining idle conversations', async () => {
  let time = 1790806700000;
  let forwarded = 0;
  const h = harness({ now: () => time, bridge: async () => { forwarded += 1; return 'ok'; } });
  for (let index = 0; index < 500; index += 1) {
    time += 4001;
    assert.equal(await h.handler.handle(frame('hour_' + index)), 'replied');
  }
  assert.equal(h.replies.length, 1000);
  time += 4001;
  assert.equal(await h.handler.handle(frame('hour_exhausted')), 'reply_failed');
  assert.equal(h.replies.length, 1000);
  assert.equal(forwarded, 500);
  time += 60 * 60_000;
  assert.equal(await h.handler.handle(frame('fresh', 'another_member')), 'replied');
  assert.deepEqual(h.handler.getRateStats(), { conversations: 1, frames: 2 });
});

test('unsafe or absent group chat IDs share one conservative bucket, and bucket maps stay bounded', async () => {
  let time = 1790806700000;
  const h = harness({ now: () => time, maxSeen: 4096 });
  for (let index = 0; index < 30; index += 1) {
    await h.handler.handle(frame('group_' + index, 'sender_' + index, { chattype: 'group', chatid: index % 2 ? 'bad\nid' : undefined }));
  }
  assert.equal(h.replies.length, 30);
  assert.equal(h.handler.getRateStats().conversations, 1);
  const waiting = h.handler.handle(frame('next_group', 'other_sender', { chattype: 'group' }));
  await tick();
  assert.equal(h.replies.length, 30);
  time += 60_001;
  await timeout(waiting);
  assert.equal(h.replies.length, 31);
  for (let index = 0; index < 1024; index += 1) {
    await h.handler.handle(frame('distinct_' + index, 'sender', { chattype: 'group', chatid: 'safe_' + index }));
  }
  assert.equal(h.handler.getRateStats().conversations, 1024);
  assert.equal(h.replies.length, 1054, 'last distinct group receives no over-cap allocation');
});


test('JSON escape fragments hold a trailing high surrogate until the next authorized delta', async () => {
  const updates = [];
  const bridge = createBridgeClient({ endpoint: DEFAULT_BRIDGE_URL, secret,
    fetchImpl: async () => response([
      { type: 'delta', text: 'paragraph\ud83d' },
      { type: 'delta', text: '\ude00complete' },
      { type: 'done' },
    ]),
  });
  const text = await bridge({ botId, userId: 'member', messageId: 'utf16', text: 'fixture' }, { onUpdate: (value) => updates.push(value) });
  assert.equal(text, 'paragraph😀complete');
  assert.deepEqual(updates, ['paragraph', 'paragraph😀complete']);
  const invalid = createBridgeClient({ endpoint: DEFAULT_BRIDGE_URL, secret,
    fetchImpl: async () => response([{ type: 'delta', text: 'incomplete\ud83d' }, { type: 'done' }]),
  });
  await assert.rejects(invalid({ botId, userId: 'member', messageId: 'utf16bad', text: 'fixture' }));
});

test('parent cancellation settles promptly even when an injected fetch ignores AbortSignal', async () => {
  const controller = new AbortController();
  const bridge = createBridgeClient({ endpoint: DEFAULT_BRIDGE_URL, secret, fetchImpl: async () => new Promise(() => {}) });
  const pending = bridge({ botId, userId: 'member', messageId: 'cancel', text: 'fixture' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(timeout(pending, 100), (error) => error.code === 'bridge_cancelled');
});
