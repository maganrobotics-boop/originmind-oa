import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeSignature, verifyAndDecrypt, parseCallbackXml, extractEncrypted } from '../lib/crypto.mjs';
import { createStore } from '../lib/store.mjs';
import { createKfApi } from '../lib/kf-api.mjs';
import { createProcessor, splitText } from '../lib/processor.mjs';

const kfid = 'wk-test-account';
const start = 1800000000000;
function customer(id = 'm1', user = 'u1', overrides = {}) {
  return { msgid: id, open_kfid: kfid, external_userid: user, origin: 3,
    send_time: start / 1000 + 1, msgtype: 'text', text: { content: '机器人如何导航？' }, ...overrides };
}
function fixture(maxQueue = 1000) { return createStore(':memory:', { openKfId: kfid, enabledAt: start, maxQueue }); }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }
function envelope(message, receiver = 'corp-test', { invalidPadding = false, falseLength = false } = {}) {
  const key = Buffer.from('abcdefghijklmnopqrstuvwxyz012345');
  const encodingAESKey = key.toString('base64').slice(0, -1);
  const bytes = Buffer.from(message);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(falseLength ? bytes.length + 10000 : bytes.length);
  const plain = Buffer.concat([Buffer.from('0123456789abcdef'), length, bytes, Buffer.from(receiver)]);
  const pad = 32 - plain.length % 32;
  const padding = Buffer.alloc(pad, pad);
  if (invalidPadding) padding[0] ^= 1;
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([plain, padding])), cipher.final()]).toString('base64');
  const args = { token: 'token-test', encodingAESKey, corpId: 'corp-test', timestamp: '1800000010', nonce: 'nonce-test', encrypted };
  return { ...args, signature: computeSignature(args) };
}

test('Tencent CBC envelope validates SHA1, UTF-8 byte length and receiver', () => {
  assert.equal(verifyAndDecrypt(envelope('你好，机器人🙂')), '你好，机器人🙂');
  const input = envelope('echo');
  assert.throws(() => verifyAndDecrypt({ ...input, signature: 'a'.repeat(40) }), { code: 'CALLBACK_SIGNATURE' });
  assert.throws(() => verifyAndDecrypt(envelope('echo', 'other-corp')), { code: 'CALLBACK_RECEIVER' });
  assert.throws(() => verifyAndDecrypt(envelope('echo', 'corp-test', { invalidPadding: true })), { code: 'CALLBACK_PADDING' });
  assert.throws(() => verifyAndDecrypt(envelope('echo', 'corp-test', { falseLength: true })), { code: 'CALLBACK_ENVELOPE' });
  assert.throws(() => verifyAndDecrypt({ ...input, encodingAESKey: input.encodingAESKey + '=' }), { code: 'CALLBACK_CONFIG' });
});

test('fixed XML scalars reject DTD, duplicate fields and unsupported events', () => {
  const xml = '<xml><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[kf_msg_or_event]]></Event><OpenKfId><![CDATA[wk-test]]></OpenKfId><Token><![CDATA[notify-token]]></Token></xml>';
  assert.deepEqual(parseCallbackXml(xml), { msgType: 'event', event: 'kf_msg_or_event', openKfId: 'wk-test', token: 'notify-token' });
  assert.equal(extractEncrypted('<xml><Encrypt><![CDATA[abcd==]]></Encrypt></xml>'), 'abcd==');
  assert.throws(() => parseCallbackXml(xml.replace('</xml>', '<Token>second</Token></xml>')), { code: 'CALLBACK_XML' });
  assert.throws(() => parseCallbackXml('<!DOCTYPE foo [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + xml), { code: 'CALLBACK_XML' });
  assert.throws(() => parseCallbackXml(xml.replace('kf_msg_or_event', 'enter_session')), { code: 'CALLBACK_UNSUPPORTED' });
});

test('first pull advances history cursor without replying to old, outbound or other account messages', () => {
  const store = fixture();
  try {
    const result = store.ingestBatch({ cursor: 'page1', now: start + 2000, messages: [
      customer('old', 'u1', { send_time: start / 1000 - 1 }),
      customer('operator', 'u1', { origin: 5 }),
      customer('other', 'u1', { open_kfid: 'wk-other' }), customer(),
    ] });
    assert.deepEqual(result, { accepted: 1, ignored: 3 });
    assert.equal(store.cursor(), 'page1');
    assert.equal(store.backlogCount(), 1);
    store.ingestBatch({ cursor: 'page2', now: start + 2000, messages: [customer()] });
    assert.equal(store.backlogCount(), 1);
  } finally { store.close(); }
});

test('queue pressure rolls back both cursor and all receipts for safe replay', () => {
  const store = fixture(1);
  try {
    assert.throws(() => store.ingestBatch({ cursor: 'unsafe', now: start + 2000, messages: [customer('one'), customer('two', 'u2')] }), { code: 'QUEUE_FULL' });
    assert.equal(store.cursor(), '');
    assert.equal(store.backlogCount(), 0);
    assert.deepEqual(store.ingestBatch({ cursor: 'safe', now: start + 2000, messages: [customer('one')] }), { accepted: 1, ignored: 0 });
  } finally { store.close(); }
});

test('enabledAt, cursor, signal and prepared reply survive restart; processing resumes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-kf-core-'));
  const path = join(directory, 'state.sqlite');
  let store = createStore(path, { openKfId: kfid, enabledAt: start });
  try {
    store.saveSignal('safe-notify-token', start + 2000);
    store.ingestBatch({ cursor: 'durable-cursor', now: start + 2000, messages: [customer()] });
    const [pending] = store.listPending(1, start + 2000);
    store.claim(pending.id);
    store.prepareAnswer(pending.id, 'final answer', ['final answer']);
    const outbox = store.outbox(pending.id);
    store.close();
    store = createStore(path, { openKfId: kfid, enabledAt: start + 900000 });
    assert.equal(store.enabledAt, start);
    assert.equal(store.cursor(), 'durable-cursor');
    assert.equal(store.latestSignal().token, 'safe-notify-token');
    assert.equal(store.listPending(1, start + 3000)[0].answer, 'final answer');
    assert.deepEqual(store.outbox(pending.id), outbox);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('history and oldest-first queue stay isolated by customer', () => {
  const store = fixture();
  try {
    store.ingestBatch({ cursor: 'c', now: start + 3000, messages: [customer('a1','a'), customer('a2','a'), customer('b1','b')] });
    const pending = store.listPending(8, start + 3000);
    assert.deepEqual(pending.map((m) => m.userId), ['a', 'b']);
    store.prepareAnswer(pending[0].id, 'customer a answer', ['customer a answer']); store.done(pending[0].id);
    assert.equal(store.getHistory('b').length, 0);
    assert.equal(store.getHistory('a')[1].content, 'customer a answer');
    assert.equal(store.listPending(8, start + 3000)[0].userId, 'a');
  } finally { store.close(); }
});

test('UTF-8 replies respect 2048 bytes and four parts including truncation notice', () => {
  const parts = splitText('🙂汉字'.repeat(3000));
  assert.equal(parts.length, 4);
  assert.ok(parts.every((part) => Buffer.byteLength(part) <= 2048));
  assert.ok(parts.every((part) => !part.includes('\uFFFD')));
  assert.ok(parts.at(-1).endsWith('（回复较长，后续可继续提问。）'));
  assert.deepEqual(splitText('简短回答'), ['简短回答']);
  assert.equal(splitText('汉'.repeat(1000), { maxParts: 1 }).length, 1);
});

test('processor persists notification before pull and continues empty has_more pages', async () => {
  const store = fixture();
  let pulls = 0;
  let replies = 0;
  const api = {
    async syncMessages(options) {
      pulls++;
      assert.equal(options.token, 'notify-token');
      assert.equal(options.openKfId, kfid);
      if (pulls === 1) return { messages: [], nextCursor: 'first', hasMore: true };
      assert.equal(options.cursor, 'first');
      return { messages: [customer()], nextCursor: 'second', hasMore: false };
    },
    async getServiceState() { return 1; },
    async sendText({ text }) { assert.equal(text, '导航答复'); replies++; },
  };
  const processor = createProcessor({ store, kfApi: api, openKfId: kfid, answer: async () => '导航答复', now: () => start + 2000 });
  try {
    await processor.notify('notify-token');
    assert.equal(store.latestSignal().token, 'notify-token');
    await Promise.all([processor.drain(), processor.drain()]);
    assert.equal(pulls, 2); assert.equal(replies, 1);
    assert.equal(store.cursor(), 'second'); assert.equal(store.latestSignal(), undefined);
  } finally { await processor.close(); store.close(); }
});

test('human session and expired customer message never generate or send', async () => {
  const store = fixture();
  store.ingestBatch({ cursor: 'c', now: start + 2000, messages: [customer()] });
  let generations = 0;
  let sent = 0;
  const processor = createProcessor({ store, openKfId: kfid, now: () => start + 2000,
    answer: async () => { generations++; return 'answer'; },
    kfApi: { getServiceState: async () => 3, sendText: async () => { sent++; } },
  });
  try { await processor.drain(); assert.equal(generations, 0); assert.equal(sent, 0); }
  finally { await processor.close(); store.close(); }
  const expiredStore = fixture();
  expiredStore.ingestBatch({ cursor: 'c', now: start + 2000, messages: [customer()] });
  const expired = createProcessor({ store: expiredStore, openKfId: kfid, now: () => start + 49 * 3600000,
    answer: async () => { generations++; return 'answer'; },
    kfApi: { getServiceState: async () => { throw new Error('must not read expired state'); } },
  });
  try { await expired.drain(); assert.equal(generations, 0); }
  finally { await expired.close(); expiredStore.close(); }
});

test('a human takeover during generation cancels the prepared reply', async () => {
  const store = fixture();
  store.ingestBatch({ cursor: 'c', now: start + 2000, messages: [customer()] });
  let state = 1;
  let sent = 0;
  const processor = createProcessor({ store, openKfId: kfid, now: () => start + 2000,
    answer: async () => { state = 3; return 'should not send'; },
    kfApi: { getServiceState: async () => state, sendText: async () => { sent++; } },
  });
  try { await processor.drain(); assert.equal(sent, 0); assert.deepEqual(store.statusCounts().map((row) => ({ ...row })), [{ status: 'skipped', count: 1 }]); }
  finally { await processor.close(); store.close(); }
});

test('transient send retry reuses durable generated text and the same idempotent messageId', async () => {
  const store = fixture();
  store.ingestBatch({ cursor: 'c', now: start + 2000, messages: [customer()] });
  let clock = start + 2000;
  let generated = 0;
  const attempts = [];
  const processor = createProcessor({ store, openKfId: kfid, now: () => clock,
    answer: async () => { generated++; return 'one final reply'; },
    kfApi: { getServiceState: async () => 0, async sendText(options) {
      attempts.push(options);
      if (attempts.length === 1) { const error = new Error('URL containing secret must be hidden'); error.code = 'KF_NETWORK'; throw error; }
    } },
  });
  try {
    await processor.drain();
    clock += 3000; await processor.drain();
    assert.equal(generated, 1); assert.equal(attempts.length, 2);
    assert.equal(attempts[0].messageId, attempts[1].messageId);
    assert.equal(store.quota('u1', clock), 4);
    assert.equal(store.getHistory('u1')[1].content, 'one final reply');
  } finally { await processor.close(); store.close(); }
});

test('per-user serial processing permits independent users concurrently', async () => {
  const store = fixture();
  store.ingestBatch({ cursor: 'c', now: start + 3000, messages: [customer('a1','a'), customer('a2','a'), customer('b1','b')] });
  const active = new Set();
  const order = [];
  let concurrent = false;
  const processor = createProcessor({ store, openKfId: kfid, now: () => start + 3000,
    async answer({ userId, history }) {
      assert.ok(!active.has(userId)); active.add(userId);
      if (active.size > 1) concurrent = true;
      order.push([userId, history.length]);
      await new Promise((resolve) => setImmediate(resolve));
      active.delete(userId); return 'reply';
    }, kfApi: { getServiceState: async () => 1, sendText: async () => {} },
  });
  try {
    await processor.drain(); await processor.drain();
    assert.ok(concurrent);
    assert.deepEqual(order.filter(([u]) => u === 'a'), [['a', 0], ['a', 2]]);
  } finally { await processor.close(); store.close(); }
});

test('one drain processes only one batch and syncs the notification before model work', async () => {
  const store = fixture();
  store.ingestBatch({ cursor: 'previous', now: start + 3000, messages: [customer('a','a'), customer('b','b'), customer('c','c')] });
  const events = [];
  const processor = createProcessor({ store, openKfId: kfid, now: () => start + 3000,
    answer: async () => { events.push('answer'); return 'reply'; },
    kfApi: {
      syncMessages: async () => { events.push('sync'); return { messages: [], nextCursor: 'next', hasMore: false }; },
      getServiceState: async () => 1, sendText: async () => {},
    },
  });
  try {
    await processor.notify('token'); await processor.drain();
    assert.equal(events[0], 'sync');
    assert.equal(events.filter((event) => event === 'answer').length, 2);
    assert.equal(store.backlogCount(), 1);
  } finally { await processor.close(); store.close(); }
});

test('a newly synced question retains replies sent after its real send time', async () => {
  const store = fixture();
  let clock = start + 2000;
  store.ingestBatch({ cursor: 'first', now: clock, messages: [customer('first')] });
  let generations = 0;
  let sends = 0;
  const processor = createProcessor({ store, openKfId: kfid, now: () => clock,
    answer: async () => { generations++; clock = start + 10000; return '汉'.repeat(4000); },
    kfApi: { getServiceState: async () => 1, sendText: async () => { sends++; } },
  });
  try {
    await processor.drain(); assert.equal(sends, 4);
    // The second question happened at t=5 seconds, but was only discovered after
    // the previous four-part answer was accepted at t=10 seconds.
    store.ingestBatch({ cursor: 'second', now: clock, messages: [customer('second','u1', { send_time: start / 1000 + 5 })] });
    assert.equal(store.quota('u1', clock), 1);
    await processor.drain();
    assert.equal(sends, 5); assert.equal(generations, 2);
    assert.equal(store.quota('u1', clock), 0);
  } finally { await processor.close(); store.close(); }
});

test('delivery failure event marks existing outbox failed and never invokes the model', async () => {
  const store = fixture();
  store.ingestBatch({ cursor: 'one', now: start + 2000, messages: [customer()] });
  const [message] = store.listPending(1, start + 2000);
  store.prepareAnswer(message.id, 'reply', ['reply']);
  const messageId = store.outbox(message.id)[0].messageId;
  store.markSent(messageId); store.done(message.id);
  store.ingestBatch({ cursor: 'two', now: start + 3000, messages: [{ msgid: 'fail-event', msgtype: 'event', event: {
    event_type: 'msg_send_fail', open_kfid: kfid, external_userid: 'u1', fail_msgid: messageId, fail_type: 4,
  } }] });
  try { assert.equal(store.outbox(message.id)[0].status, 'failed'); assert.equal(store.getHistory('u1').length, 0); assert.equal(store.backlogCount(), 0); }
  finally { store.close(); }
});

test('API cache coalesces refresh, uses only fixed HTTPS endpoint and refreshes expired token once', async () => {
  const calls = [];
  let tokenReads = 0;
  let expired = true;
  const api = createKfApi({ corpId: 'corp', secret: 'secret', now: () => start,
    async fetchImpl(url, options) {
      assert.equal(url.origin, 'https://qyapi.weixin.qq.com');
      assert.equal(options.redirect, 'error'); calls.push(url.pathname);
      if (url.pathname === '/cgi-bin/gettoken') return json({ errcode: 0, access_token: `t${++tokenReads}`, expires_in: 7200 });
      if (expired) { expired = false; return json({ errcode: 42001, errmsg: 'url contains secret' }); }
      return json({ errcode: 0, service_state: 1 });
    },
  });
  assert.equal(await api.getServiceState({ openKfId: kfid, userId: 'u' }), 1);
  assert.equal(await api.getServiceState({ openKfId: kfid, userId: 'v' }), 1);
  assert.equal(tokenReads, 2);
  assert.equal(calls.filter((path) => path === '/cgi-bin/kf/service_state/get').length, 3);
});

test('API error never exposes credentials or upstream errmsg and rejects overlong sends before fetching', async () => {
  let reads = 0;
  const api = createKfApi({ corpId: 'corp', secret: 'TOP_SECRET', async fetchImpl(url) {
    reads++;
    if (url.pathname === '/cgi-bin/gettoken') return json({ errcode: 0, access_token: 'a', expires_in: 7200 });
    return json({ errcode: 48002, errmsg: 'TOP_SECRET secret credential content' });
  } });
  await assert.rejects(api.getServiceState({ openKfId: kfid, userId: 'u' }), (error) => error.message === 'KF_API_48002' && !String(error.stack).includes('TOP_SECRET'));
  const before = reads;
  await assert.rejects(api.sendText({ openKfId: kfid, userId: 'u', messageId: 'm', text: '字'.repeat(1000) }), { code: 'KF_INVALID_ARGUMENT' });
  assert.equal(reads, before);
});

test('API rejects unbounded upstream response bodies', async () => {
  const api = createKfApi({ corpId: 'corp', secret: 'secret', async fetchImpl() {
    return new Response('x'.repeat(2 * 1024 * 1024 + 1));
  } });
  await assert.rejects(api.getServiceState({ openKfId: kfid, userId: 'u' }), { code: 'KF_RESPONSE_TOO_LARGE' });
});
