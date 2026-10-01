import test from 'node:test';
import assert from 'node:assert/strict';
import {
  botConfiguration, parseBotMessage, parseBotCommand, parseBotLinkAction, strictBotBrowserOrigin,
  createBotPairingCode, hashBotPairingCode, readSignedBotMessage, signBotBody, BOT_MAX_BODY_BYTES,
} from '../lib/wecom-bot-contract.mjs';

const configuration = { secret: 'A'.repeat(43), botId: 'bot-1' };
const now = Date.parse('2026-10-01T00:00:00.000Z');
const body = JSON.stringify({ botId: 'bot-1', userId: 'user-1', messageId: 'message-1', text: '/待办' });
async function signedRequest(raw = body, timestamp = String(now), signatureBody = raw) {
  return new Request('https://oa.example.test/api/integrations/wecom-bot/messages', {
    method: 'POST', body: raw, headers: {
      'content-type': 'application/json', 'x-oa-bot-timestamp': timestamp,
      'x-oa-bot-signature': await signBotBody(configuration.secret, timestamp, signatureBody),
    },
  });
}

test('bot config is disabled until every credential and explicit flag is valid', () => {
  const environment = { WECOM_BOT_ENABLED: 'true', WECOM_BOT_BRIDGE_SECRET: configuration.secret, WECOM_BOT_ID: configuration.botId };
  assert.deepEqual(botConfiguration(environment), configuration);
  for (const patch of [{ WECOM_BOT_ENABLED: undefined }, { WECOM_BOT_ENABLED: 'TRUE' }, { WECOM_BOT_BRIDGE_SECRET: 'short' }, { WECOM_BOT_ID: 'bot\n1' }]) {
    assert.equal(botConfiguration({ ...environment, ...patch }), null);
  }
});

test('signed private canonical messages verify exact body with bounded timestamp', async () => {
  const result = await readSignedBotMessage(await signedRequest(), configuration, now);
  assert.deepEqual(result, { ok: true, message: JSON.parse(body) });
  assert.deepEqual(await readSignedBotMessage(await signedRequest(body.replace('user-1', 'user-2'), String(now), body), configuration, now), { ok: false, status: 401 });
  assert.deepEqual(await readSignedBotMessage(await signedRequest(body, String(now - 60_001)), configuration, now), { ok: false, status: 401 });
  assert.deepEqual(await readSignedBotMessage(await signedRequest(body, String(now + 60_001)), configuration, now), { ok: false, status: 401 });
  assert.equal((await readSignedBotMessage(await signedRequest(body, String(now - 60_000)), configuration, now)).ok, true);
  const wrongKey = { ...configuration, secret: 'B'.repeat(43) };
  assert.deepEqual(await readSignedBotMessage(await signedRequest(), wrongKey, now), { ok: false, status: 401 });
});

test('group, member, role and bot identity claims are never accepted by the signed endpoint', async () => {
  for (const patch of [{ chatType: 'group' }, { isPrivate: true }, { memberId: 'someone-else' }, { role: 'admin' }, { botId: 'another-bot' }]) {
    const raw = JSON.stringify({ ...JSON.parse(body), ...patch });
    assert.deepEqual(await readSignedBotMessage(await signedRequest(raw), configuration, now), { ok: false, status: 400 });
  }
});

test('bounded reader rejects oversized streams even without declared length', async () => {
  const bytes = new TextEncoder().encode(' '.repeat(BOT_MAX_BODY_BYTES + 1));
  const request = new Request('https://oa.example.test/messages', {
    method: 'POST', duplex: 'half', body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    headers: { 'content-type': 'application/json', 'x-oa-bot-timestamp': String(now), 'x-oa-bot-signature': '0'.repeat(64) },
  });
  assert.deepEqual(await readSignedBotMessage(request, configuration, now), { ok: false, status: 413 });
  assert.equal(parseBotMessage({ ...JSON.parse(body), text: 'x'.repeat(4001) }, configuration.botId), null);
  assert.equal(parseBotMessage({ ...JSON.parse(body), userId: 'x'.repeat(129) }, configuration.botId), null);
  assert.equal(parseBotMessage({ ...JSON.parse(body), text: '\ud800' }, configuration.botId), null);
  assert.equal(parseBotMessage({ ...JSON.parse(body), text: '\u0000' }, configuration.botId), null);
});

test('browser mutations require canonical HTTPS Origin and cannot specify target user', () => {
  const environment = { OA_PUBLIC_ORIGIN: 'https://oa.example.test' };
  const request = (origin, extra = {}) => new Request('https://oa.example.test/api/integrations/wecom-bot/link', { headers: { ...(origin ? { origin } : {}), ...extra } });
  assert.equal(strictBotBrowserOrigin(request('https://oa.example.test'), environment), true);
  assert.equal(strictBotBrowserOrigin(request(null), environment), false);
  assert.equal(strictBotBrowserOrigin(request('https://attacker.test'), environment), false);
  assert.equal(strictBotBrowserOrigin(request('https://oa.example.test', { 'sec-fetch-site': 'cross-site' }), environment), false);
  assert.equal(strictBotBrowserOrigin(request('https://oa.example.test'), { OA_PUBLIC_ORIGIN: 'https://oa.example.test/path' }), false);
  assert.equal(strictBotBrowserOrigin(request('https://oa.example.test'), { OA_PUBLIC_ORIGIN: 'http://oa.example.test' }), false);
  assert.equal(parseBotLinkAction({ action: 'create', memberId: 'other' }), null);
  assert.equal(parseBotLinkAction({ action: 'confirm', pairingId: 'a960b817-7abc-4c9e-a682-0c08e6f7c591', userId: 'other' }), null);
  assert.deepEqual(parseBotLinkAction({ action: 'confirm', pairingId: 'a960b817-7abc-4c9e-a682-0c08e6f7c591' }), { action: 'confirm', pairingId: 'a960b817-7abc-4c9e-a682-0c08e6f7c591' });
});

test('pairing codes have 128-bit random entropy and commands remain read only', async () => {
  const codes = new Set(Array.from({ length: 100 }, () => createBotPairingCode()));
  assert.equal(codes.size, 100);
  for (const code of codes) assert.match(code, /^[A-Za-z0-9_-]{22}$/u);
  const code = [...codes][0];
  assert.match(await hashBotPairingCode(code), /^[0-9a-f]{64}$/u);
  assert.deepEqual(parseBotCommand(`/绑定 ${code}`), { kind: 'bind', code });
  assert.deepEqual(parseBotCommand('/绑定 short'), { kind: 'invalid_binding' });
  assert.deepEqual(parseBotCommand('我的待办'), { kind: 'work_items' });
  assert.deepEqual(parseBotCommand('帮我通过所有审批'), { kind: 'question', question: '帮我通过所有审批' });
});
