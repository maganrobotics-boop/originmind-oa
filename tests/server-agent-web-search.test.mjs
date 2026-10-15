import assert from 'node:assert/strict';
import test from 'node:test';
import { encryptSecret } from '../chat-cloudflare/src/crypto.mjs';
import { completeServerAgentWebSearch, createBailianWebSearch, normalizeServerAgentWebSearchReply,
  validServerAgentWebSearchPayload, supportsServerAgentWebSearch } from '../chat-cloudflare/src/server-agent-web-search.mjs';

const encryption = 'synthetic-web-search-encryption'.repeat(3);
const apiKey = 'synthetic-web-search-provider-key';
const input = overrides => ({ operation: 'server_agent_web_search', query: '深圳本周末天气预报', ...overrides });
const upstream = overrides => ({ status: 'completed', output: [
  { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [
    { type: 'url', url: 'https://weather.example.com/shenzhen', title: '深圳天气' },
  ] } },
  { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '预报显示周末有小雨。' }] },
], ...overrides });
async function fixture({ provider = 'bailian', model = 'qwen3.8-max', baseUrl = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', budget, fetcher } = {}) {
  let calls = 0, budgets = 0, captured;
  const config = { model, baseUrl, encryptedKey: await encryptSecret(apiKey, encryption) };
  const context = { env: { APP_ENCRYPTION_KEY: encryption }, runtime: { fetch: async (url, init) => {
    calls++; captured = { url, body: JSON.parse(init.body), init };
    return fetcher ? fetcher(url, init) : Response.json(upstream());
  } } };
  const engine = { modelProvider: () => ({ provider }), globalBudget: async () => { budgets++; if (budget) await budget(); } };
  return { send: value => completeServerAgentWebSearch(context, engine, config, value === undefined ? input() : value), config,
    state: () => ({ calls, budgets, captured }) };
}

test('search uses existing Token Plan endpoint, encrypted credentials and global call budget', async () => {
  const f = await fixture(); const result = await f.send();
  const { calls, budgets, captured } = f.state();
  assert.equal(calls, 1); assert.equal(budgets, 1);
  assert.equal(captured.url, `${f.config.baseUrl}/responses`);
  assert.equal(captured.init.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(captured.init.redirect, 'manual'); assert.equal(captured.init.credentials, 'omit');
  assert.equal(captured.body.model, f.config.model);
  assert.deepEqual(captured.body.tools, [{ type: 'web_search' }]);
  assert.equal(captured.body.tool_choice, 'required'); assert.equal(captured.body.store, false);
  assert.equal(captured.body.stream, false); assert.deepEqual(captured.body.reasoning, { effort: 'none' });
  assert.equal(captured.body.input[1].content, input().query);
  assert.equal(result.mode, 'server_agent_web_search'); assert.equal(result.searched, true);
  assert.deepEqual(result.sources, [{ index: 1, title: '深圳天气', url: 'https://weather.example.com/shenzhen' }]);
  assert.ok(!JSON.stringify(result).includes(apiKey)); assert.ok(!captured.init.body.includes(apiKey));
});

test('query validation rejects extra authority, injected system messages and malformed input before a call', async () => {
  const f = await fixture();
  for (const payload of [input({ messages: [] }), input({ operation: 'other' }), input({ query: '' }),
    input({ query: 'a' }), input({ query: 'x'.repeat(1001) }), input({ query: '\ud800' }), input({ query: 'a\0b' }), null]) {
    assert.equal(validServerAgentWebSearchPayload(payload), false);
    await assert.rejects(f.send(payload), /SERVER_AGENT_SEARCH_INPUT/u);
  }
  assert.equal(f.state().calls, 0); assert.equal(f.state().budgets, 0);
});

test('unsupported providers and models fail without falling back, decrypting, or requesting', async () => {
  const otherProvider = await fixture({ provider: 'other' }); otherProvider.config.encryptedKey = 'invalid';
  await assert.rejects(otherProvider.send(), /SERVER_AGENT_SEARCH_UNAVAILABLE/u);
  assert.equal(otherProvider.state().calls, 0);
  for (const model of ['qwen-plus', 'unknown', 'qwen3.8-max;command']) {
    const f = await fixture({ model }); f.config.encryptedKey = 'invalid';
    await assert.rejects(f.send(), /SERVER_AGENT_SEARCH_UNAVAILABLE/u); assert.equal(f.state().calls, 0);
  }
  assert.equal(supportsServerAgentWebSearch('qwen3.8-max-0902'), true);
  assert.equal(supportsServerAgentWebSearch('qwen3.7-plus'), true);
});

test('unsafe endpoint and exhausted budget do not send provider requests', async () => {
  const unsafe = await fixture({ baseUrl: 'https://example.com/compatible-mode/v1' });
  await assert.rejects(unsafe.send()); assert.equal(unsafe.state().calls, 0);
  const exhausted = await fixture({ budget: () => { throw new Error('synthetic budget'); } });
  await assert.rejects(exhausted.send(), /synthetic budget/u); assert.equal(exhausted.state().calls, 0);
});

test('only provider returned public sources count as a completed search', () => {
  const value = upstream(); value.output[0].action.sources.push(
    { type: 'url', url: 'http://127.0.0.1/config' }, { type: 'url', url: 'http://2130706433/config' },
    { type: 'url', url: 'http://[::1]/config' }, { type: 'url', url: 'http://localhost/config' },
    { type: 'url', url: 'https://user:password@example.com/' }, { type: 'url', url: 'https://internal.local/config' },
    { type: 'url', url: 'file:///etc/passwd' }, { type: 'url', url: 'https://weather.example.com/shenzhen' },
    { type: 'url', url: 'https://news.example.com/report' },
  );
  const result = normalizeServerAgentWebSearchReply(value);
  assert.equal(result.sources.length, 2); assert.equal(result.sources[1].title, 'news.example.com');
  for (const invalid of [upstream({ output: upstream().output.slice(1) }),
    upstream({ output: [{ ...upstream().output[0], action: { type: 'search', sources: [] } }, upstream().output[1]] })]) {
    assert.throws(() => normalizeServerAgentWebSearchReply(invalid), /SERVER_AGENT_SEARCH_NO_SOURCES/u);
  }
});

test('incomplete, failed, oversized or unexpected provider tool outputs cannot claim success', () => {
  for (const value of [upstream({ status: 'incomplete' }), upstream({ error: { message: 'private' } }),
    upstream({ output: [{ ...upstream().output[0], status: 'failed' }, upstream().output[1]] }),
    upstream({ output: [{ type: 'function_call', name: 'shell' }, ...upstream().output] }),
    upstream({ output: [upstream().output[0], { ...upstream().output[1], content: [{ type: 'output_text', text: 'x'.repeat(10001) }] }] }),
  ]) assert.throws(() => normalizeServerAgentWebSearchReply(value), /SERVER_AGENT_SEARCH_PROTOCOL/u);
});

test('sources and synthesized answer are bounded and do not expose provider internal fields', () => {
  const value = upstream(); value.private = apiKey;
  value.output.unshift({ type: 'reasoning', summary: [{ text: 'internal reasoning' }] });
  value.output[1].action.sources = Array.from({ length: 20 }, (_, i) => ({ type: 'url', url: `https://public${i}.example.com/`, title: 't'.repeat(500) }));
  const result = normalizeServerAgentWebSearchReply(value);
  assert.equal(result.sources.length, 8); assert.equal(result.sources[0].title.length, 300);
  assert.ok(!JSON.stringify(result).includes('internal reasoning')); assert.ok(!JSON.stringify(result).includes(apiKey));
});

test('HTTP and protocol errors never include upstream bodies or credentials', async () => {
  const http = await fixture({ fetcher: () => Response.json({ private: apiKey }, { status: 403 }) });
  await assert.rejects(http.send(), error => error.message === 'SERVER_AGENT_SEARCH_HTTP' && error.upstreamStatus === 403);
  const html = await fixture({ fetcher: () => new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(html.send(), /SERVER_AGENT_SEARCH_PROTOCOL/u);
  const tooLarge = await fixture({ fetcher: () => new Response('x'.repeat(131073), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(tooLarge.send(), /SERVER_AGENT_SEARCH_RESPONSE_LIMIT/u);
  const broken = await fixture({ fetcher: () => new Response('{', { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(broken.send(), /SERVER_AGENT_SEARCH_PROTOCOL/u);
});

test('deadline and network failures are distinct and do not trigger retries', async () => {
  let calls = 0;
  const search = createBailianWebSearch({ endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey, model: 'qwen3.8-max', now: () => 100, consumeBudget: async () => {}, fetcher: async () => { calls++; throw new TypeError('private network detail'); } });
  await assert.rejects(search({ query: input().query, deadline: 100 }), /SERVER_AGENT_SEARCH_TIMEOUT/u);
  assert.equal(calls, 0);
  await assert.rejects(search({ query: input().query, deadline: 101 }), /^Error: SERVER_AGENT_SEARCH_TRANSPORT$/u);
  assert.equal(calls, 1);
});
