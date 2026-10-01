import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { ACK_REPLY, attachBotClient, BotTransportError, splitStreamReply, BUSY_REPLY, createBotMessageHandler, createBridgeClient, createSafeLogger, EMPTY_REPLY,
  DEFAULT_BRIDGE_URL, FAILURE_REPLY, GROUP_HELP, MAX_BRIDGE_BYTES, MAX_STREAM_BYTES, PUBLIC_HELP,
  readBotEnvironment, signBridgeBody, validateBridgeSecret, validateBridgeUrl } from '../lib/wecom-bot-transport.mjs';
import { startBot } from '../scripts/wecom-bot.mjs';

const secret = randomBytes(32).toString('base64url');
const botId = 'trial_bot';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = (msgid = 'msg1', userid = 'user1', overrides = {}) => ({
  cmd: 'aibot_msg_callback', headers: { req_id: `req_${msgid}` }, body: {
    aibotid: botId, msgid, chattype: 'single', from: { userid }, msgtype: 'text', text: { content: '查询我的待办' }, ...overrides,
  },
});
const jsonResponse = (reply = '结果', opts = {}) => new Response(JSON.stringify({ ok: true, reply }), { status: 200, headers: { 'content-type': 'application/json' }, ...opts });
const harness = (options = {}) => {
  const forwarded = [];
  const replies = [];
  const logs = [];
  const logger = createSafeLogger((line) => logs.push(line));
  const handler = createBotMessageHandler({ botId, logger,
    bridge: async (payload) => { forwarded.push(payload); return '仅本人的待办'; },
    sendReply: async (...args) => replies.push(args),
    ...options,
  });
  return { handler, forwarded, replies, logs, logger };
};

test('runtime config accepts only operator-selected exact bridge endpoints and unpadded strong secrets', () => {
  assert.equal(validateBridgeUrl(DEFAULT_BRIDGE_URL), DEFAULT_BRIDGE_URL);
  const https = 'https://oa.omindos.cn/api/integrations/wecom-bot/messages';
  assert.equal(validateBridgeUrl(https), https);
  for (const value of [
    'http://localhost:3000/api/integrations/wecom-bot/messages',
    'http://127.0.0.1:3001/api/integrations/wecom-bot/messages',
    'http://oa.omindos.cn/api/integrations/wecom-bot/messages',
    `${https}/`, `${https}?x=1`, `${https}#x`,
    'https://user:password@oa.omindos.cn/api/integrations/wecom-bot/messages',
    'https://OA.omindos.cn/api/integrations/wecom-bot/messages',
    'https://oa.omindos.cn/api/x/../integrations/wecom-bot/messages',
    'https://oa.omindos.cn/api/integrations/wecom-bot/%6dessages',
  ]) assert.throws(() => validateBridgeUrl(value), BotTransportError);
  assert.equal(validateBridgeSecret(secret), secret);
  for (const value of [undefined, 'short', `${secret}=`, 'a'.repeat(42), 'Z'.repeat(43), ' '.repeat(43)]) {
    assert.throws(() => validateBridgeSecret(value), BotTransportError);
  }
  const env = { WECOM_BOT_ID: botId, WECOM_BOT_SECRET: 'provider_secret_123456789', WECOM_BOT_BRIDGE_SECRET: secret };
  assert.equal(readBotEnvironment(env).bridgeUrl, DEFAULT_BRIDGE_URL);
  assert.throws(() => readBotEnvironment({ ...env, WECOM_BOT_ID: 'bot\nraw' }));
  assert.throws(() => readBotEnvironment({ ...env, WECOM_BOT_SECRET: 'raw\nprovidersecret' }));
});

test('bridge signs exact UTF-8 JSON request with milliseconds and never forwards frame URLs', async () => {
  const calls = [];
  const bridge = createBridgeClient({ endpoint: DEFAULT_BRIDGE_URL, secret, now: () => 1790806700000,
    fetchImpl: async (...args) => { calls.push(args); return jsonResponse(); },
  });
  const payload = { botId, userId: 'user1', messageId: 'msg1', text: '我的资料？', response_url: 'http://evil.local', url: 'https://evil.local' };
  assert.equal(await bridge(payload), '结果');
  const [url, options] = calls[0];
  assert.equal(url, DEFAULT_BRIDGE_URL);
  assert.equal(options.redirect, 'manual');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['content-type'], 'application/json');
  assert.equal(options.headers['x-oa-bot-timestamp'], '1790806700000');
  assert.equal(options.headers['x-oa-bot-signature'], createHmac('sha256', secret).update(`1790806700000\n${options.body}`).digest('hex'));
  assert.deepEqual(JSON.parse(options.body), { botId, userId: 'user1', messageId: 'msg1', text: '我的资料？' });
  assert.notEqual(signBridgeBody(secret, '1790806700000', options.body), signBridgeBody(secret, '1790806700001', options.body));
  assert.throws(() => signBridgeBody(secret, '0', '{}'));
});

test('default loopback HTTP bridge passes the Aliyun proxy-origin guard on the wire', async (t) => {
  // Isolated fixture of aliyun/oa-server.mjs's production guard. No OA process,
  // business data, provider connection or existing configuration is accessed.
  const publicOrigin = new URL('https://oa.omindos.cn/');
  const accepted = [];
  let responseMode = 'normal';
  let hangingClosed;
  const server = createServer(async (req, res) => {
    const trustedHost = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      && req.headers.host === publicOrigin.host
      && req.headers['x-forwarded-host'] === publicOrigin.host;
    if (!trustedHost || req.headers['x-forwarded-proto'] !== 'https') {
      res.writeHead(421, { 'cache-control': 'no-store' });
      res.end('Invalid proxy origin');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    accepted.push({ method: req.method, path: req.url, headers: req.headers, body });
    if (responseMode === 'redirect') {
      res.writeHead(302, { location: 'https://example.test/never-follow' });
      res.end();
    } else if (responseMode === 'too_large') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(Buffer.alloc(MAX_BRIDGE_BYTES));
      res.end(Buffer.alloc(1));
    } else if (responseMode === 'hanging_body') {
      hangingClosed = once(res, 'close');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reply: 'isolated guard accepted' }));
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const localUrl = `http://127.0.0.1:${server.address().port}/api/integrations/wecom-bot/messages`;
  const rejected = await fetch(localUrl, { method: 'POST', body: '{}' });
  assert.equal(rejected.status, 421);
  await rejected.arrayBuffer();
  // Remap only the fixed local port in an isolated copy of the actual module,
  // because production occupies port 3000. Exercise its default transport,
  // proxy headers, response parser and HMAC without injecting a fake fetch.
  const source = await readFile(new URL('../lib/wecom-bot-transport.mjs', import.meta.url), 'utf8');
  const fixedPort = 'http://127.0.0.1:3000${BRIDGE_PATH}';
  assert.equal(source.split(fixedPort).length, 2);
  const isolatedSource = source.replace(fixedPort, `http://127.0.0.1:${server.address().port}\${BRIDGE_PATH}`);
  const transport = await import(`data:text/javascript;base64,${Buffer.from(isolatedSource).toString('base64')}`);
  assert.equal(transport.DEFAULT_BRIDGE_URL, localUrl);
  const bridge = transport.createBridgeClient({ endpoint: localUrl, secret });
  const payload = { botId, userId: 'user1', messageId: 'fixture1', text: 'isolated request' };
  assert.equal(await bridge(payload), 'isolated guard accepted');
  assert.equal(accepted.length, 1);
  const request = accepted[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/api/integrations/wecom-bot/messages');
  assert.equal(request.headers.host, 'oa.omindos.cn');
  assert.equal(request.headers['x-forwarded-host'], 'oa.omindos.cn');
  assert.equal(request.headers['x-forwarded-proto'], 'https');
  assert.deepEqual(JSON.parse(request.body), payload);
  assert.equal(request.headers['x-oa-bot-signature'],
    signBridgeBody(secret, request.headers['x-oa-bot-timestamp'], request.body));
  responseMode = 'redirect';
  await assert.rejects(bridge(payload), (error) => error.code === 'bridge_redirect_rejected');
  responseMode = 'too_large';
  await assert.rejects(bridge(payload), (error) => error.code === 'bridge_response_too_large');
  responseMode = 'hanging_body';
  const timedBridge = transport.createBridgeClient({ endpoint: localUrl, secret, timeoutMs: 100 });
  await assert.rejects(timedBridge(payload), (error) => error.code === 'bridge_timeout');
  assert.ok(hangingClosed, 'request must reach the fixture before the timeout');
  // Abort must close the actual local response stream rather than merely reject
  // a Promise while leaving an unbounded body read or socket alive.
  await Promise.race([hangingClosed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('timed-out socket remained open')), 1000);
    timer.unref();
  })]);
});

test('operator-selected HTTPS bridge uses its normal Host without Aliyun proxy headers', async () => {
  const endpoint = 'https://bridge.example.test/api/integrations/wecom-bot/messages';
  let requestHeaders;
  const bridge = createBridgeClient({ endpoint, secret, fetchImpl: async (url, options) => {
    assert.equal(url, endpoint);
    requestHeaders = options.headers;
    return jsonResponse();
  } });
  assert.equal(await bridge({ botId, userId: 'user1', messageId: 'https1', text: 'hello' }), '结果');
  for (const key of ['host', 'x-forwarded-host', 'x-forwarded-proto']) {
    assert.equal(Object.hasOwn(requestHeaders, key), false);
  }
  assert.equal(requestHeaders['content-type'], 'application/json');
});

test('bridge refuses redirects, external final URLs, content type and HTTP error bodies', async () => {
  const cases = [
    new Response('raw confidential response', { status: 302, headers: { location: 'https://evil.local' } }),
    new Response('raw response', { status: 401 }),
    new Response('{"reply":"raw response"}', { status: 200, headers: { 'content-type': 'text/plain' } }),
    Object.defineProperty(jsonResponse(), 'url', { value: 'https://evil.local/elsewhere' }),
    Object.defineProperty(jsonResponse(), 'redirected', { value: true }),
  ];
  for (const response of cases) {
    const bridge = createBridgeClient({ endpoint: DEFAULT_BRIDGE_URL, secret, fetchImpl: async () => response });
    await assert.rejects(bridge({ botId, userId: 'user1', messageId: 'msg1', text: 'hello' }), BotTransportError);
  }
});

test('bridge bounds streamed responses even without Content-Length and validates decoded JSON', async () => {
  const replyTooLong = jsonResponse('a'.repeat(10_001));
  const bodyTooLarge = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(MAX_BRIDGE_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close();
  } }), { headers: { 'content-type': 'application/json' } });
  const advertisedTooLarge = jsonResponse('ok', { headers: { 'content-type': 'application/json', 'content-length': String(MAX_BRIDGE_BYTES + 1) } });
  const invalidUtf8 = new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } });
  for (const response of [replyTooLong, bodyTooLarge, advertisedTooLarge, invalidUtf8, jsonResponse(123),
    new Response('not json', { headers: { 'content-type': 'application/json' } })]) {
    const bridge = createBridgeClient({ endpoint: DEFAULT_BRIDGE_URL, secret, fetchImpl: async () => response });
    await assert.rejects(bridge({ botId, userId: 'user1', messageId: 'msg1', text: 'hello' }), BotTransportError);
  }
});

test('bridge timeout aborts requests and covers hanging fetch and response-body reads', async () => {
  let fetchSignal;
  const bridge = createBridgeClient({ endpoint: DEFAULT_BRIDGE_URL, secret, timeoutMs: 10, fetchImpl: async (_, options) => {
    fetchSignal = options.signal; return new Promise(() => {});
  } });
  await assert.rejects(bridge({ botId, userId: 'user1', messageId: 'msg1', text: 'hello' }), (error) => error.code === 'bridge_timeout');
  assert.equal(fetchSignal.aborted, true);
  const bodyBridge = createBridgeClient({ endpoint: DEFAULT_BRIDGE_URL, secret, timeoutMs: 10,
    fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(bodyBridge({ botId, userId: 'user1', messageId: 'msg1', text: 'hello' }), (error) => error.code === 'bridge_timeout');
  assert.throws(() => createBridgeClient({ endpoint: DEFAULT_BRIDGE_URL, secret, timeoutMs: 150_001 }));
});

test('bridge accepts empty successful dedupe reply and rejects false/missing success', async () => {
  const payload = { botId, userId: 'user1', messageId: 'msg1', text: 'hello' };
  const bridge = createBridgeClient({ endpoint: DEFAULT_BRIDGE_URL, secret, fetchImpl: async () => jsonResponse('') });
  assert.equal(await bridge(payload), '');
  for (const body of [{ reply: 'unsafe' }, { ok: false, reply: 'unsafe' }]) {
    const invalid = createBridgeClient({ endpoint: DEFAULT_BRIDGE_URL, secret, fetchImpl: async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }) });
    await assert.rejects(invalid(payload));
  }
  const h = harness({ bridge: async () => '' });
  assert.equal(await h.handler.handle(frame()), 'replied');
  assert.equal(h.replies[1][2], EMPTY_REPLY);
});

test('only validated private text is forwarded; group help contains no OA data', async () => {
  const h = harness();
  assert.equal(await h.handler.handle(frame()), 'replied');
  assert.deepEqual(h.forwarded[0], { botId, userId: 'user1', messageId: 'msg1', text: '查询我的待办' });
  assert.equal(await h.handler.handle(frame('group1', 'user2', { chattype: 'group', chatid: 'group_chat', text: { content: '查询保密资料' } })), 'help');
  assert.equal(h.forwarded.length, 1);
  assert.equal(h.replies[2][2], GROUP_HELP);
  assert.deepEqual(h.replies[0][0], { headers: { req_id: 'req_msg1' } });
  assert.equal(h.replies[0][3], false);
  assert.equal(h.replies[0][2], ACK_REPLY);
  assert.equal(h.replies[0][1], h.replies[1][1]);
  assert.equal(h.replies[1][3], true);
  assert.equal(await h.handler.handle(frame('image1', 'user2', { msgtype: 'image', image: { url: 'http://evil.local', aeskey: 'raw_secret' } })), 'help');
  assert.equal(h.replies[3][2], PUBLIC_HELP);
  assert.equal(h.forwarded.length, 1);
});

test('wrong bot, command, missing header, unsafe identities and ambiguous chat types fail closed', async () => {
  const h = harness();
  const wrongCmd = frame('wrong1'); wrongCmd.cmd = 'aibot_event_callback';
  const missingHeader = frame('wrong2'); delete missingHeader.headers;
  for (const f of [wrongCmd, missingHeader, frame('wrong3', 'user1', { aibotid: 'other_bot' }),
    frame('wrong4', 'user\nraw'), frame('x'.repeat(129)), frame('wrong5', 'x'.repeat(129)),
    frame('wrong6', 'user1', { chattype: 'unknown' }), frame('wrong7', 'user1', { chatid: 'group_shadow' })]) {
    assert.equal(await h.handler.handle(f), 'rejected');
  }
  assert.equal(h.forwarded.length, 0);
  assert.equal(h.replies.length, 0);
});

test('oversized or control-character input receives safe help without bridge request', async () => {
  const h = harness();
  for (const [i, content] of ['', ' '.repeat(20), 'x'.repeat(4001), 'hello\u0000raw'].entries()) {
    assert.equal(await h.handler.handle(frame(`invalid${i}`, 'user1', { text: { content } })), 'help');
  }
  assert.equal(h.forwarded.length, 0);
  assert.ok(h.replies.every((reply) => reply[2] === PUBLIC_HELP));
});

test('duplicate queued and completed message IDs never forward or reply twice', async () => {
  let complete;
  const h = harness({ bridge: () => new Promise((resolve) => { complete = resolve; }) });
  const first = h.handler.handle(frame());
  await tick();
  assert.equal(await h.handler.handle(frame()), 'duplicate');
  complete('ok');
  assert.equal(await first, 'replied');
  assert.equal(await h.handler.handle(frame()), 'duplicate');
  assert.equal(h.replies.length, 2);
});

test('ACK failure or timeout prevents any OA query and bounds reply wait', async () => {
  let forwarded = 0;
  const failed = harness({ bridge: async () => { forwarded += 1; return 'private'; }, sendReply: async () => { throw new Error('raw secret'); } });
  assert.equal(await failed.handler.handle(frame('a1')), 'reply_failed');
  const hung = harness({ replyTimeoutMs: 10, bridge: async () => { forwarded += 1; return 'private'; }, sendReply: () => new Promise(() => {}) });
  assert.equal(await hung.handler.handle(frame('a2')), 'reply_failed');
  assert.equal(forwarded, 0);
  assert.equal(hung.handler.getStats().active, 0);
});

test('queued payload is detached from original body and colon-containing IDs do not collide', async () => {
  let release;
  const payloads = [];
  const h = harness({ maxConcurrent: 1, bridge: async (payload) => {
    payloads.push(payload);
    if (payloads.length === 1) return new Promise((resolve) => { release = resolve; });
    return 'ok';
  } });
  const first = h.handler.handle(frame('b:c', 'a'));
  const queuedFrame = frame('c', 'a:b', { text: { content: 'original query' }, response_url: 'http://evil.local', untrusted: new Uint8Array(1024 * 1024) });
  const queued = h.handler.handle(queuedFrame);
  queuedFrame.body.text.content = 'replacement';
  queuedFrame.body.untrusted = null;
  await tick(); release('ok'); await Promise.all([first, queued]);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[1], { botId, userId: 'a:b', messageId: 'c', text: 'original query' });
});

test('per-user serialization preserves order while other users run within global concurrency', async () => {
  const starts = [];
  const resolvers = new Map();
  const h = harness({ maxConcurrent: 2, bridge: (payload) => {
    starts.push(payload.messageId);
    return new Promise((resolve) => resolvers.set(payload.messageId, resolve));
  } });
  const tasks = [h.handler.handle(frame('m1')), h.handler.handle(frame('m2')), h.handler.handle(frame('m3', 'user2'))];
  await tick();
  assert.deepEqual(starts, ['m1', 'm3']);
  assert.equal(h.handler.getStats().active, 2);
  resolvers.get('m1')('one'); await tasks[0]; await tick();
  assert.deepEqual(starts, ['m1', 'm3', 'm2']);
  resolvers.get('m2')('two'); resolvers.get('m3')('three');
  await Promise.all(tasks);
  assert.equal(h.handler.getStats().active, 0);
  assert.equal(h.handler.getStats().users, 0);
});

test('queue, per-user and replay-cache exhaustion stay bounded and allocate no extra replies', async () => {
  const releases = [];
  const h = harness({ maxConcurrent: 1, maxPending: 1, maxPerUser: 2, bridge: () => new Promise((resolve) => releases.push(resolve)) });
  const one = h.handler.handle(frame('q1')); const two = h.handler.handle(frame('q2'));
  await tick();
  assert.equal(await h.handler.handle(frame('q3')), 'busy');
  assert.equal(await h.handler.handle(frame('q4', 'user2')), 'busy');
  assert.deepEqual(h.handler.getStats(), { active: 1, queued: 1, users: 1, seen: 2 });
  assert.equal(h.replies.length, 2);
  releases[0]('ok'); await one; await tick(); releases[1]('ok'); await two;
  const limited = harness({ maxSeen: 1 });
  await limited.handler.handle(frame('c1'));
  assert.equal(await limited.handler.handle(frame('c2')), 'busy');
  assert.equal(limited.handler.getStats().seen, 1);
});

test('queued messages expire instead of querying stale data; completed cache expires', async () => {
  let time = 1790806700000;
  let release;
  const starts = [];
  const h = harness({ now: () => time, queueTimeoutMs: 10, dedupeTtlMs: 20, maxConcurrent: 1,
    bridge: (payload) => { starts.push(payload.messageId); return new Promise((resolve) => { release = resolve; }); },
  });
  const one = h.handler.handle(frame('e1')); const two = h.handler.handle(frame('e2'));
  await tick(); time += 11; release('ok'); await one;
  assert.equal(await two, 'queue_expired');
  assert.deepEqual(starts, ['e1']);
  assert.equal(h.replies[3][2], BUSY_REPLY);
  time += 21;
  const later = h.handler.handle(frame('e1')); await tick(); release('ok'); await later;
  assert.deepEqual(starts, ['e1', 'e1']);
});

test('bridge/reply failures never leak raw errors, credentials, question or answer to logs', async () => {
  const h = harness({ bridge: async () => { throw new Error(`raw secret=${secret} question=private_question`); } });
  await h.handler.handle(frame());
  assert.equal(h.replies[1][2], FAILURE_REPLY);
  h.logger.sdk.debug('raw_question', secret); h.logger.sdk.info('raw_reply', secret);
  h.logger.sdk.warn('raw warning', { password: secret }); h.logger.sdk.error(new Error(secret));
  h.logger.status('private_question');
  assert.ok(h.logs.length > 0);
  for (const line of h.logs) {
    assert.equal(line.includes(secret), false);
    assert.equal(/raw|private_question|仅本人的|查询我的/.test(line), false);
    assert.deepEqual(Object.keys(JSON.parse(line)), ['service', 'status']);
  }
  const invalid = harness({ bridge: async () => 'x'.repeat(12_001) });
  await invalid.handler.handle(frame());
  assert.equal(invalid.replies[1][2], FAILURE_REPLY);
});

test('long answers preserve every code point across bounded, finished stream bubbles', async () => {
  const content = '😀这是一个较长的回答'.repeat(1000);
  const pieces = splitStreamReply(content);
  assert.ok(pieces.length > 1);
  assert.equal(pieces.join(''), content);
  assert.ok(pieces.every((piece) => Buffer.byteLength(piece, 'utf8') <= MAX_STREAM_BYTES));
  assert.ok(pieces.every((piece) => Buffer.from(piece).toString('utf8') === piece));
  const answer = '这是完整长回答。'.repeat(1200);
  const h = harness({ bridge: async () => answer });
  assert.equal(await h.handler.handle(frame()), 'replied');
  const finished = h.replies.filter((reply) => reply[3] === true);
  assert.ok(finished.length > 1);
  assert.equal(finished.map((reply) => reply[2]).join(''), answer);
  assert.equal(new Set(finished.map((reply) => reply[1])).size, finished.length);
  assert.ok(h.replies.every((reply) => Buffer.byteLength(reply[2], 'utf8') <= MAX_STREAM_BYTES));
  assert.ok(h.replies.every((reply) => reply[0].headers.req_id === 'req_msg1'));
  for (const [index, reply] of h.replies.entries()) {
    if (reply[3]) assert.equal(h.replies.slice(index + 1).some((next) => next[1] === reply[1]), false);
  }
});

test('client runs only after authentication and suppresses old queued/results across reconnects', async () => {
  const client = new EventEmitter(); client.disconnect = () => {};
  let release;
  const calls = [];
  const h = harness({ bridge: async (payload) => { calls.push(payload); return new Promise((resolve) => { release = resolve; }); } });
  const runtime = attachBotClient(client, h.handler, { botId, logger: h.logger });
  client.emit('connected'); client.emit('message', frame('before_auth')); await tick();
  assert.equal(calls.length, 0);
  client.emit('authenticated'); client.emit('message', frame('during_auth')); await tick();
  assert.equal(calls.length, 1);
  client.emit('disconnected', 'raw_secret_reason'); client.emit('authenticated'); release('old_private_answer'); await tick();
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0][2], ACK_REPLY);
  assert.equal(runtime.isAuthenticated(), true);
  assert.ok(h.logs.every((line) => !line.includes('raw_secret_reason')));
});

test('provider replacement disconnect event stops permanently without reconnect contest', async () => {
  const client = new EventEmitter(); let disconnected = 0; let stopCalls = 0;
  client.disconnect = () => { disconnected += 1; };
  const h = harness();
  const runtime = attachBotClient(client, h.handler, { botId, logger: h.logger, onIntentionalStop: () => { stopCalls += 1; } });
  client.emit('authenticated');
  client.emit('event', { cmd: 'aibot_event_callback', body: { aibotid: 'other_bot', event: { eventtype: 'disconnected_event' } } });
  assert.equal(runtime.isAuthenticated(), true);
  client.emit('event', { cmd: 'aibot_event_callback', body: { aibotid: botId, event: { eventtype: 'disconnected_event' } } });
  client.emit('authenticated'); client.emit('message', frame()); await tick();
  assert.equal(runtime.isAuthenticated(), false);
  assert.equal(disconnected, 1);
  assert.equal(stopCalls, 1);
  assert.equal(h.forwarded.length, 0);
});

test('terminal SDK auth and network failures exit through fatal callback without raw errors', () => {
  for (const code of ['WS_AUTH_FAILURE_EXHAUSTED', 'WS_RECONNECT_EXHAUSTED']) {
    const client = new EventEmitter(); let disconnects = 0; let fatals = 0; let intentional = 0;
    client.disconnect = () => { disconnects += 1; };
    const h = harness();
    const runtime = attachBotClient(client, h.handler, { botId, logger: h.logger, onFatalStop: () => { fatals += 1; }, onIntentionalStop: () => { intentional += 1; } });
    client.emit('authenticated');
    client.emit('error', { code, message: `secret=${secret}` });
    client.emit('authenticated');
    assert.equal(runtime.isAuthenticated(), false);
    assert.equal(disconnects, 1);
    assert.equal(fatals, 1);
    assert.equal(intentional, 0);
    assert.ok(h.logs.every((line) => !line.includes(secret)));
  }
});

test('daemon constructs SDK with private runtime config and sanitized logger; no credentials on startup failure', async () => {
  const logs = []; const logger = createSafeLogger((line) => logs.push(line));
  let options; let connects = 0;
  class FakeClient extends EventEmitter {
    constructor(value) { super(); options = value; }
    connect() { connects += 1; }
    disconnect() {}
    replyStream() { throw new Error('must not send live messages'); }
  }
  const env = { WECOM_BOT_ID: botId, WECOM_BOT_SECRET: 'provider_secret_123456789', WECOM_BOT_BRIDGE_SECRET: secret };
  const runtime = await startBot({ env, loadSdk: async () => ({ default: { WSClient: FakeClient } }), logger, onStop() {} });
  assert.equal(options.botId, botId);
  assert.equal(options.secret, env.WECOM_BOT_SECRET);
  assert.equal(options.logger, logger.sdk);
  assert.equal(options.maxReconnectAttempts, 10);
  assert.equal(options.maxAuthFailureAttempts, 3);
  assert.equal(options.wsOptions.maxPayload, 65536);
  assert.equal(connects, 1);
  assert.equal(runtime.isAuthenticated(), false);
  runtime.stop();
  assert.ok(logs.every((line) => !line.includes(secret) && !line.includes(env.WECOM_BOT_SECRET)));
  await assert.rejects(startBot({ env: {}, loadSdk: () => { throw new Error('SDK must not load invalid credentials'); }, logger }));
});
