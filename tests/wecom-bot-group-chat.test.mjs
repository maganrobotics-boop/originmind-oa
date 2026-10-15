import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotMessageHandler, createBridgeClient, GROUP_CHAT_HELP, GROUP_FAILURE_REPLY } from '../lib/wecom-bot-transport.mjs';
import { createGroupChatClient, GROUP_CHAT_ENDPOINT, groupQuestion } from '../lib/wecom-group-chat.mjs';

const payload = (chatId = 'group-a', userId = 'user-a', text = '@源灵助手 什么是 SLAM？') => ({ chatId, userId, text });
const frame = (changes = {}) => ({ cmd: 'aibot_msg_callback', headers: { req_id: 'req-test' }, body: {
  aibotid: 'bot-test', chattype: 'group', chatid: 'group-a', from: { userid: 'user-a' }, msgid: 'msg-1',
  msgtype: 'text', text: { content: '@源灵助手 什么是 SLAM？' }, ...changes,
} });
const response = (answer = 'SLAM 是同时定位与建图。', extra = {}) => Response.json({ answer, mode: 'general', provider: 'bailian', ...extra });

test('group questions only reach the public channel, while private queries keep their own bridge', async () => {
  const privateCalls = [], groupCalls = [], replies = [];
  const handler = createBotMessageHandler({ botId: 'bot-test', bridge: async p => { privateCalls.push(p); return '本人待办'; },
    groupBridge: async p => { groupCalls.push(p); return '群聊回答'; },
    sendReply: async (f, id, text, finish) => replies.push({ f, id, text, finish }), streamUpdateIntervalMs: 1 });
  assert.equal(await handler.handle(frame({ response_url: 'https://internal.invalid', cookie: 'private-cookie', botId: 'spoof' })), 'replied');
  assert.deepEqual(groupCalls, [payload()]);
  assert.equal(privateCalls.length, 0);
  assert.equal(replies.at(-1).text, '群聊回答');
  assert.equal(replies.at(-1).finish, true);
  assert.deepEqual(replies.at(-1).f, { headers: { req_id: 'req-test' } });
  assert.equal(await handler.handle(frame({ chattype: 'single', chatid: undefined, msgid: 'msg-2', text: { content: '我的待办' } })), 'replied');
  assert.equal(privateCalls.length, 1);
  assert.deepEqual(privateCalls[0], { botId: 'bot-test', userId: 'user-a', messageId: 'msg-2', text: '我的待办' });
  assert.equal(groupCalls.length, 1);
  handler.stop();
});

test('contradictory callbacks, unsupported media and private image objects cannot escape into a group', async () => {
  let calls = 0; const replies = [];
  const handler = createBotMessageHandler({ botId: 'bot-test', bridge: async () => { throw Error('private bridge must not run'); },
    groupBridge: async () => { calls++; return { reply: 'private image', images: [] }; },
    uploadImage: async () => { throw Error('upload must not run'); }, sendImage: async () => { throw Error('media must not run'); },
    sendReply: async (_, __, text) => replies.push(text) });
  assert.equal(await handler.handle(frame({ chatid: undefined })), 'rejected');
  assert.equal(await handler.handle(frame({ chattype: 'single', msgid: 'msg-2' })), 'rejected');
  assert.equal(await handler.handle(frame({ msgtype: 'image', msgid: 'msg-3' })), 'help');
  assert.equal(replies.at(-1), GROUP_CHAT_HELP);
  assert.equal(calls, 0);
  assert.equal(await handler.handle(frame({ msgid: 'msg-4' })), 'bridge_failed');
  assert.equal(replies.at(-1), GROUP_FAILURE_REPLY);
  handler.stop();
});

test('public Chat receives only a fixed anonymous question without OA credentials or identifiers', async () => {
  const calls = [];
  const client = createGroupChatClient({ fetchImpl: async (url, options) => { calls.push({ url, options }); return response('**来源类型：模型通用知识（未引用公开知识库资料）**\n\n你好！'); } });
  assert.equal(await client(payload()), '你好！');
  assert.equal(calls[0].url, GROUP_CHAT_ENDPOINT);
  const headers = new Headers(calls[0].options.headers);
  assert.equal(headers.get('origin'), 'https://chat.omindos.cn');
  assert.equal(headers.get('host'), 'chat.omindos.cn');
  for (const name of ['authorization', 'cookie', 'x-oa-bot-signature', 'x-oa-bot-timestamp']) assert.equal(headers.has(name), false);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(body).sort(), ['messages', 'topic']);
  assert.equal(body.messages.at(-1).content, '什么是 SLAM？');
  assert.equal(JSON.stringify(body).includes('user-a'), false);
  assert.equal(JSON.stringify(body).includes('group-a'), false);
  assert.equal(groupQuestion('@源灵助手 @吴国军 你好'), '@吴国军 你好');
});

test('conversation tokens stay within the same sender and group, expire, and can be reset', async () => {
  let time = 1000; const bodies = [];
  const client = createGroupChatClient({ now: () => time, conversationTtlMs: 10,
    fetchImpl: async (_, options) => { bodies.push(JSON.parse(options.body)); return response('公开回答', { conversationToken: `token-${bodies.length}` }); } });
  await client(payload());
  await client(payload('group-a', 'user-a', '继续'));
  assert.equal(bodies[1].conversationToken, 'token-1');
  await client(payload('group-b'));
  assert.equal(bodies[2].conversationToken, undefined);
  await client(payload('group-a', 'user-b'));
  assert.equal(bodies[3].conversationToken, undefined);
  assert.match(await client(payload('group-a', 'user-a', '清除上下文')), /已清除/);
  assert.equal(bodies.length, 4);
  await client(payload());
  assert.equal(bodies[4].conversationToken, undefined);
  time += 11;
  await client(payload());
  assert.equal(bodies[5].conversationToken, undefined);
});

test('mention-only messages and private OA commands get guidance without calling any query service', async () => {
  const client = createGroupChatClient({ fetchImpl: async () => { throw Error('must not query'); } });
  assert.equal(await client(payload('group-a', 'user-a', '@源灵助手')), GROUP_CHAT_HELP);
  for (const text of ['我的待办', '/待办', '查看吴国军的工资', '查询 OA 内部资料', '绑定123ABC']) {
    assert.match(await client(payload('group-a', 'user-a', text)), /单聊/);
  }
  await assert.rejects(client({ ...payload(), botId: 'spoof' }), /invalid_payload/);
  const privateBridge = createBridgeClient({ endpoint: 'http://127.0.0.1:3000/api/integrations/wecom-bot/messages', secret: Buffer.alloc(32, 7).toString('base64url'),
    fetchImpl: async () => { throw Error('group must not reach private bridge'); } });
  await assert.rejects(privateBridge(payload()), /invalid_payload/);
});

test('redirects, incomplete responses, excessive output, cancellation and stalled requests fail safely', async () => {
  for (const fake of [
    () => new Response('', { status: 302, headers: { location: 'https://oa.omindos.cn' } }),
    () => Response.json({ answer: 'not confirmed' }),
    () => response('x'.repeat(12001)),
    () => response('fallback', { fallbackReason: 'generation_failed' }),
    () => new Response('x', { headers: { 'content-type': 'application/json', 'content-length': '999999' } }),
  ]) {
    const client = createGroupChatClient({ fetchImpl: async () => fake() });
    await assert.rejects(client(payload()), /bridge_/);
  }
  const stalled = createGroupChatClient({ timeoutMs: 10, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(stalled(payload()), /bridge_timeout/);
  const controller = new AbortController(); controller.abort();
  let called = false;
  const cancelled = createGroupChatClient({ fetchImpl: async () => { called = true; return response(); } });
  await assert.rejects(cancelled(payload(), { signal: controller.signal }), /bridge_cancelled/);
  assert.equal(called, false);
});
