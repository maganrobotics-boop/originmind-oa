import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source = await readFile(new URL('../frontend/message-actions.js', import.meta.url), 'utf8');
function helpers(overrides = {}) {
  return vm.runInNewContext(`${source}\n({ answerSnapshot, createAnswerShareUrl, decodeAnswerShare, boundedShareStream })`, {
    TextEncoder, TextDecoder, URL, Blob, CompressionStream, DecompressionStream, Uint8Array, btoa, atob, ...overrides,
  });
}
const sample = { v: 1, question: '机器人如何运动？', answer: String.raw`## 运动模型\n\n**完整回答** $a=\frac{v^2}{r}$，中文与 emoji 🤖。` };
test('share round-trip preserves Unicode, markdown and formulas exactly', async () => {
  const h = helpers(); const url = await h.createAnswerShareUrl(sample, 'https://chat.example/manage?token=SECRET#private');
  assert.equal(new URL(url).pathname, '/'); assert.equal(new URL(url).search, '');
  assert.deepEqual(JSON.parse(JSON.stringify(await h.decodeAnswerShare(new URL(url).hash))), sample);
});
test('share payload allowlist excludes signed tokens, history, sources and personal fields', () => {
  const value = helpers().answerSnapshot({ ...sample, conversationToken:'SECRET', messages:[{ content:'PRIVATE' }], sources:['PRIVATE'], user:{ email:'PRIVATE' }, images:['PRIVATE'] });
  assert.deepEqual(JSON.parse(JSON.stringify(value)), sample);
});
test('uncompressed fallback is lossless', async () => {
  const h = helpers({ CompressionStream: undefined });
  const url = await h.createAnswerShareUrl(sample, 'https://chat.example');
  assert.match(url, /#answer=1\.text\./); assert.equal((await h.decodeAnswerShare(new URL(url).hash)).answer, sample.answer);
});
test('compressed long answers retain their ending', async () => {
  const h = helpers(); const answer = '机器人完整回答与公式 $x^2$。'.repeat(1500) + '最后一段';
  const url = await h.createAnswerShareUrl({ ...sample, answer }, 'https://chat.example');
  assert.match(url, /1\.gzip\./); assert.equal((await h.decodeAnswerShare(new URL(url).hash)).answer, answer);
});
test('unsupported, malformed and oversized links fail without execution', async () => {
  for (const value of ['#answer=2.text.e30', '#answer=1.text.%', '#answer=1.text.bm90LWpzb24', '#answer=1.gzip.a']) await assert.rejects(helpers().decodeAnswerShare(value));
  await assert.rejects(helpers().decodeAnswerShare('#answer=' + 'a'.repeat(60000)));
});
test('invalid payloads and oversized questions fail', () => {
  for (const value of [null, {}, { ...sample, v:2 }, { ...sample, answer:'' }, { ...sample, question:'x'.repeat(2001) }]) assert.throws(() => helpers().answerSnapshot(value));
});
test('oversized answers are rejected rather than truncated', async () => {
  await assert.rejects(helpers().createAnswerShareUrl({ ...sample, answer:'中'.repeat(100000) }, 'https://chat.example'), /过长/);
});
test('decompression bombs are bounded', async () => {
  const stream = new Blob([new Uint8Array(300000)]).stream();
  await assert.rejects(helpers().boundedShareStream(stream), /过长/);
});
test('shared text cannot set HTML or carry a javascript origin', async () => {
  const h = helpers(); const value = { ...sample, answer:'<script>alert(1)</script>' };
  assert.equal(h.answerSnapshot(value).answer, value.answer);
  await assert.rejects(h.createAnswerShareUrl(sample, 'javascript:alert(1)'));
  assert.doesNotMatch(source, /\.innerHTML\s*=|eval\s*\(|new Function\s*\(/);
});
test('share import never fetches or sends a chat request', () => {
  const incoming = source.slice(source.indexOf('async function openIncomingSharedAnswer'));
  assert.doesNotMatch(incoming, /fetch\(|\/api\/chat|dispatchQuestion|localStorage\.setItem/);
  assert.match(incoming, /未经独立核验/);
});
